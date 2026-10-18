import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PUBLIC_EPG_PREFIX } from "@vocaltv/public-epg-contract";
import type { ObjectMetadata, RetentionObjectStore, StoredObject } from "./encoding.js";

function etag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

export class LocalObjectStore implements RetentionObjectStore {
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("local_store_path_must_be_absolute");
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    if (!/^public-epg\/v1\/[A-Za-z0-9._/-]{1,512}$/u.test(key)
      || key.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
      throw new Error("local_store_key_invalid");
    }
    const path = resolve(this.root, ...key.split("/"));
    const escaped = relative(this.root, path);
    if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error("local_store_key_invalid");
    return path;
  }

  async get(key: string, maximumBytes = 64 * 1024 * 1024): Promise<Uint8Array | null> {
    const path = this.pathFor(key);
    let info;
    try { info = await stat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("local_store_read_failed");
    }
    if (!info.isFile() || info.size > maximumBytes) throw new Error("local_store_object_size_invalid");
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > maximumBytes) throw new Error("local_store_object_size_invalid");
      return new Uint8Array(bytes);
    } catch (error) {
      if (error instanceof Error && error.message === "local_store_object_size_invalid") throw error;
      throw new Error("local_store_read_failed");
    }
  }

  async getWithETag(key: string, maximumBytes = 64 * 1024 * 1024): Promise<{ value: Uint8Array; etag: string } | null> {
    const value = await this.get(key, maximumBytes);
    return value ? { value, etag: etag(value) } : null;
  }

  async put(key: string, value: Uint8Array, _metadata: ObjectMetadata): Promise<void> {
    const path = this.pathFor(key);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    } catch {
      throw new Error("local_store_write_failed");
    }
  }

  async putConditional(
    key: string,
    value: Uint8Array,
    metadata: ObjectMetadata,
    condition: { ifMatch: string } | { ifNoneMatch: "*" }
  ): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = path + ".lock";
    let lock;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("local_store_lock_failed");
        await delay(10);
      }
    }
    if (!lock) throw new Error("local_store_lock_timeout");
    try {
      const existing = await this.get(key, Math.max(value.byteLength, 1024 * 1024));
      if ("ifMatch" in condition) {
        if (!existing || etag(existing) !== condition.ifMatch) throw new Error("r2_precondition_failed");
      } else if (existing) {
        throw new Error("r2_precondition_failed");
      }
      await this.put(key, value, metadata);
      return etag(value);
    } finally {
      await lock.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  async list(prefix: string, cursor?: string) {
    if (prefix !== PUBLIC_EPG_PREFIX) throw new Error("retention_namespace_invalid");
    const objects: StoredObject[] = [];
    const visit = async (key: string): Promise<void> => {
      const path = resolve(this.root, key);
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("retention_listing_failed"); }
      for (const entry of entries) {
        const next = key + entry.name;
        if (entry.isDirectory()) await visit(next + "/");
        else if (entry.isFile() && !/\.(lock|tmp)$/u.test(entry.name)) {
          const info = await stat(this.pathFor(next));
          objects.push({ key: next, bytes: info.size, lastModified: info.mtimeMs });
          if (objects.length > 100_000) throw new Error("retention_listing_budget_exceeded");
        }
      }
    };
    await visit(prefix);
    objects.sort((a, b) => a.key.localeCompare(b.key));
    const remaining = objects.filter((item) => !cursor || item.key > cursor), page = remaining.slice(0, 1000);
    return { objects: page, ...(remaining.length > page.length ? { cursor: page.at(-1)!.key } : {}) };
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length || keys.length > 1000 || keys.some((key) => !key.startsWith(PUBLIC_EPG_PREFIX))) throw new Error("retention_namespace_invalid");
    for (const key of keys) await rm(this.pathFor(key), { force: true });
  }
}
