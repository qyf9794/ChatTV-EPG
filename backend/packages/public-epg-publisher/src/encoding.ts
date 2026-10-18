import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  PUBLIC_EPG_PREFIX,
  type ArtifactRef
} from "@vocaltv/public-epg-contract";

export type ObjectMetadata = {
  contentType: "application/json" | "application/xml; charset=utf-8" | "application/octet-stream";
  contentEncoding?: "gzip";
  cacheControl: string;
};

export interface ObjectStore {
  get(key: string, maximumBytes?: number): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array, metadata: ObjectMetadata): Promise<void>;
  getWithETag(key: string, maximumBytes: number): Promise<{ value: Uint8Array; etag: string } | null>;
  putConditional(
    key: string,
    value: Uint8Array,
    metadata: ObjectMetadata,
    condition: { ifMatch: string } | { ifNoneMatch: "*" }
  ): Promise<string>;
}

/** Retention only enumerates the publisher namespace. It never accesses other
 * bucket data and must execute under the same fenced publication lease. */
export type StoredObject = { key: string; bytes: number; lastModified: number };
export interface RetentionObjectStore extends ObjectStore {
  list(prefix: string, cursor?: string): Promise<{ objects: StoredObject[]; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
}

export type VerifiedArtifact = {
  storedSha256: string;
  storedBytes: number;
  rawSha256: string;
  rawBytes: number;
};

/** Optional run-local proof cache used by the publisher after conditional content-addressed writes. */
export interface VerifiedArtifactStore extends ObjectStore {
  getCachedObject?(key: string, maximumBytes: number): Uint8Array | null;
  hasVerifiedArtifact(key: string, artifact: VerifiedArtifact): boolean;
  markVerifiedArtifact(key: string, artifact: VerifiedArtifact): void;
}

export function hasVerifiedArtifact(store: ObjectStore, key: string, artifact: VerifiedArtifact): boolean {
  const candidate = store as Partial<VerifiedArtifactStore>;
  return candidate.hasVerifiedArtifact?.(key, artifact) === true;
}

/** Exact bytes already read/acknowledged in this bounded run need no duplicate
 * immutable PUT. This lookup never performs an object-store request. */
export function hasIdenticalCachedObject(store: ObjectStore, key: string, bytes: Uint8Array): boolean {
  const cached = (store as Partial<VerifiedArtifactStore>).getCachedObject?.(key, bytes.byteLength);
  return !!cached && cached.byteLength === bytes.byteLength
    && cached.every((byte, index) => byte === bytes[index]);
}

/** Reuse artifacts from earlier runs only after a bounded read proves their
 * exact bytes. Existing objects must not spend a conditional PUT attempt just
 * to discover that they exist; interrupted graphs can then resume in budget. */
export async function hasIdenticalStoredObject(store: ObjectStore, key: string, bytes: Uint8Array): Promise<boolean> {
  const existing = await store.get(key, bytes.byteLength);
  if (!existing) return false;
  if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)
    || existing.some((byte, index) => byte !== bytes[index])) {
    throw new Error("immutable_object_hash_mismatch");
  }
  return true;
}

export function markVerifiedArtifact(store: ObjectStore, key: string, artifact: VerifiedArtifact): void {
  const candidate = store as Partial<VerifiedArtifactStore>;
  candidate.markVerifiedArtifact?.(key, artifact);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(record[key])}`).join(",")}}`;
}

export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(stableJSON(value));
}

export function gzip(value: Uint8Array): Uint8Array {
  // Node writes a zero timestamp by default, keeping content-addressed output deterministic.
  return gzipSync(value, { level: 9 });
}

export function gunzip(value: Uint8Array, maximumBytes: number): Uint8Array {
  const result = gunzipSync(value, { maxOutputLength: maximumBytes + 1 });
  if (result.byteLength > maximumBytes) throw new Error("artifact_decompressed_size_exceeded");
  return result;
}

export async function putImmutable(
  store: ObjectStore,
  kind: "json" | "xml",
  rawBytes: Uint8Array,
  compressedBytes = gzip(rawBytes)
): Promise<ArtifactRef> {
  const digest = sha256(compressedBytes);
  const key = `${PUBLIC_EPG_PREFIX}objects/${digest}.${kind}.gz`;
  const verification = {
    storedSha256: digest,
    storedBytes: compressedBytes.byteLength,
    rawSha256: sha256(rawBytes),
    rawBytes: rawBytes.byteLength
  };
  if (hasVerifiedArtifact(store, key, verification) || hasIdenticalCachedObject(store, key, compressedBytes)
    || await hasIdenticalStoredObject(store, key, compressedBytes)) {
    markVerifiedArtifact(store, key, verification);
    return { key, sha256: digest, bytes: rawBytes.byteLength, compressedBytes: compressedBytes.byteLength };
  }
  try {
    await store.putConditional(key, compressedBytes, {
      contentType: kind === "json" ? "application/json" : "application/xml; charset=utf-8",
      contentEncoding: "gzip",
      cacheControl: "public, max-age=31536000, immutable"
    }, { ifNoneMatch: "*" });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "r2_precondition_failed") throw error;
    const existing = await store.get(key, compressedBytes.byteLength);
    if (!existing || sha256(existing) !== digest || existing.byteLength !== compressedBytes.byteLength
      || existing.some((byte, index) => byte !== compressedBytes[index])) {
      throw new Error("immutable_object_hash_mismatch");
    }
  }
  markVerifiedArtifact(store, key, verification);
  return { key, sha256: digest, bytes: rawBytes.byteLength, compressedBytes: compressedBytes.byteLength };
}

export async function getVerifiedJSON<T>(store: ObjectStore, ref: ArtifactRef, maxBytes: number): Promise<T> {
  const stored = await store.get(ref.key, ref.compressedBytes);
  if (!stored || stored.byteLength !== ref.compressedBytes || sha256(stored) !== ref.sha256) {
    throw new Error("artifact_hash_mismatch");
  }
  const raw = gunzip(stored, maxBytes);
  if (raw.byteLength !== ref.bytes) throw new Error("artifact_size_mismatch");
  try { return JSON.parse(new TextDecoder().decode(raw)) as T; }
  catch { throw new Error("artifact_invalid_json"); }
}

export async function getVerifiedBytes(store: ObjectStore, ref: ArtifactRef, maxBytes: number): Promise<Uint8Array> {
  const stored = await store.get(ref.key, ref.compressedBytes);
  if (!stored || stored.byteLength !== ref.compressedBytes || sha256(stored) !== ref.sha256) {
    throw new Error("artifact_hash_mismatch");
  }
  const raw = ref.key.endsWith(".gz") ? gunzip(stored, maxBytes) : stored;
  if (raw.byteLength !== ref.bytes) throw new Error("artifact_size_mismatch");
  return raw;
}

export async function putMutableJSON(store: ObjectStore, key: string, value: unknown, cacheControl = "no-store"): Promise<void> {
  await store.put(key, jsonBytes(value), { contentType: "application/json", cacheControl });
}

export async function getMutableJSON<T>(store: ObjectStore, key: string, maxBytes: number): Promise<T | null> {
  const value = await store.get(key, maxBytes);
  if (!value) return null;
  if (value.byteLength > maxBytes) throw new Error("state_size_exceeded");
  try { return JSON.parse(new TextDecoder().decode(value)) as T; }
  catch { throw new Error("state_invalid_json"); }
}
