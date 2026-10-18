import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { ObjectMetadata, RetentionObjectStore } from "../src/encoding.js";
import { publicEpgSources, publicMetadataSources } from "../src/sources.js";

export const channelsFixture = [
  { id: "news", name: "News", alt_names: ["N"], country: "US", categories: ["news"] },
  { id: "other", name: "Other", alt_names: [] }
];

export const categoriesFixture = [
  { id: "news", name: "News" },
  { id: "sports", name: "Sports" }
];

export const feedsFixture = [
  { id: "en", channel: "news", name: "English", languages: ["eng"], broadcast_area: ["GB"], timezones: ["Europe/London"] },
  { id: "shared", channel: "news", name: "HD", languages: ["eng"], broadcast_area: ["GB"], timezones: ["Europe/London"] },
  { id: "shared", channel: "other", name: "International", languages: ["eng"], broadcast_area: ["US"], timezones: ["America/New_York"] }
];

export const streamsFixture = [
  {
    id: "news-en-1080p", channel: "news", feed: "en", title: "News Live",
    url: "https://cdn.example/news.m3u8", referrer: "https://player.example/",
    user_agent: "VocalTV-Test/1.0", quality: "1080p", labels: ["HD", "News"]
  },
  {
    id: "other-shared", channel: "other", feed: "shared", title: "Other International",
    url: "https://cdn.example/other.m3u8", quality: "720p", labels: ["International"]
  },
  { id: "private-host", channel: "news", feed: "en", title: "Private", url: "http://127.0.0.1/live.m3u8" },
  { id: "unknown-feed", channel: "news", feed: "missing", title: "Unmapped", url: "https://cdn.example/unmapped.m3u8" }
];

export function xmlFixture(title = "Late bulletin"): string {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<tv><channel id="news@en"><display-name lang="en">News English</display-name></channel>'
    + '<programme start="20261001233000 +0000" stop="20261002010000 +0000" channel="news@en">'
    + '<title lang="en">' + title + '</title><desc>Fixture description</desc><category>News</category>'
    + '</programme></tv>';
}

export class MemoryObjectStore implements RetentionObjectStore {
  readonly objects = new Map<string, { value: Uint8Array; metadata: ObjectMetadata; modifiedAt: number }>();
  readonly puts: string[] = [];
  activeImmutablePuts = 0;
  maxConcurrentImmutablePuts = 0;
  immutablePutDelayMs = 0;
  immutablePutDelayForKey: ((key: string) => number) | null = null;
  failPut: ((key: string) => boolean) | null = null;
  beforeConditionalPut: ((key: string, condition: { ifMatch: string } | { ifNoneMatch: "*" }) => void) | null = null;

  async get(key: string, maximumBytes = 64 * 1024 * 1024): Promise<Uint8Array | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    if (object.value.byteLength > maximumBytes) throw new Error("r2_object_size_invalid");
    return new Uint8Array(object.value);
  }

  async getWithETag(key: string, maximumBytes = 64 * 1024 * 1024): Promise<{ value: Uint8Array; etag: string } | null> {
    const value = await this.get(key, maximumBytes);
    return value ? { value, etag: this.etag(value) } : null;
  }

  async put(key: string, value: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    const immutable = key.startsWith("public-epg/v1/objects/")
      || key.startsWith("public-epg/v1/manifests/")
      || key.startsWith("public-epg/v1/source-names/")
      || key.startsWith("public-epg/v1/publisher/source-cache/");
    if (immutable) {
      this.activeImmutablePuts += 1;
      this.maxConcurrentImmutablePuts = Math.max(this.maxConcurrentImmutablePuts, this.activeImmutablePuts);
    }
    try {
      const delayMs = immutable
        ? Math.max(this.immutablePutDelayMs, this.immutablePutDelayForKey?.(key) ?? 0)
        : 0;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (this.failPut?.(key)) throw new Error("r2_put_failed");
      this.objects.set(key, { value: new Uint8Array(value), metadata: { ...metadata }, modifiedAt: Date.now() });
      this.puts.push(key);
    } finally {
      if (immutable) this.activeImmutablePuts -= 1;
    }
  }

  async putConditional(
    key: string,
    value: Uint8Array,
    metadata: ObjectMetadata,
    condition: { ifMatch: string } | { ifNoneMatch: "*" }
  ): Promise<string> {
    this.beforeConditionalPut?.(key, condition);
    const previous = this.objects.get(key)?.value;
    if ("ifMatch" in condition) {
      if (!previous || this.etag(previous) !== condition.ifMatch) throw new Error("r2_precondition_failed");
    } else if (previous) {
      throw new Error("r2_precondition_failed");
    }
    await this.put(key, value, metadata);
    return this.etag(value);
  }

  private etag(value: Uint8Array): string {
    return `"${createHash("sha256").update(value).digest("hex")}"`;
  }

  async list(prefix: string, cursor?: string): Promise<{ objects: Array<{ key: string; bytes: number; lastModified: number }>; cursor?: string }> {
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix) && (!cursor || key > cursor))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => ({ key, bytes: item.value.byteLength, lastModified: item.modifiedAt }));
    const page = all.slice(0, 1000);
    return { objects: page, ...(all.length > page.length ? { cursor: page.at(-1)!.key } : {}) };
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

export class FixedPublicUpstream {
  readonly conditionalRequests = new Map<string, number>();
  readonly requests = new Map<string, number>();
  readonly failingSourceIDs = new Set<string>();
  readonly changedSourceIDs = new Set<string>();
  readonly changedMetadataSourceIDs = new Set<string>();
  readonly metadataOverrides = new Map<string, unknown>();
  beforeFetch: ((url: string) => void) | null = null;
  private readonly etags = new Map<string, string>();

  private bodyFor(url: string): { id: string; body: Uint8Array; etag: string } {
    const metadata = publicMetadataSources.find((item) => item.publicURL === url);
    if (metadata) {
      const defaultValue = metadata.id.endsWith(":channels") ? channelsFixture
        : metadata.id.endsWith(":feeds") ? feedsFixture
          : metadata.id.endsWith(":categories") ? categoriesFixture
            : streamsFixture;
      const value = this.metadataOverrides.get(metadata.id) ?? defaultValue;
      const body = new TextEncoder().encode(JSON.stringify(value));
      const etag = '"meta-' + metadata.id.split(":")[1]
        + (this.changedMetadataSourceIDs.has(metadata.id) ? '-v2' : '-v1') + '"';
      this.etags.set(metadata.id, etag);
      return { id: metadata.id, body, etag };
    }
    const source = publicEpgSources.find((item) => item.publicURL === url);
    if (!source) throw new Error("fixture_url_unexpected");
    const title = this.changedSourceIDs.has(source.id) ? `Changed bulletin ${source.id}` : `Late bulletin ${source.id}`;
    const xml = new TextEncoder().encode(xmlFixture(title));
    const body = source.publicURL.endsWith(".gz") ? new Uint8Array(gzipSync(xml)) : xml;
    const etag = '"source-' + source.id + (this.changedSourceIDs.has(source.id) ? "-v2" : "-v1") + '"';
    this.etags.set(source.id, etag);
    return { id: source.id, body, etag };
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    this.beforeFetch?.(url);
    const metadata = publicMetadataSources.find((item) => item.publicURL === url);
    const source = publicEpgSources.find((item) => item.publicURL === url);
    const id = metadata?.id ?? source?.id;
    if (!id) throw new Error("fixture_url_unexpected");
    this.requests.set(id, (this.requests.get(id) ?? 0) + 1);
    if (source && this.failingSourceIDs.has(source.id)) return new Response("unavailable", { status: 503 });
    const current = this.bodyFor(url);
    const headers = new Headers(init?.headers);
    const validator = headers.get("if-none-match");
    if (validator) this.conditionalRequests.set(id, (this.conditionalRequests.get(id) ?? 0) + 1);
    if (validator && validator === current.etag) return new Response(null, { status: 304 });
    return new Response(Buffer.from(current.body), { status: 200, headers: { etag: current.etag } });
  };
}
