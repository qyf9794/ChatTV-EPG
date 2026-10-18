import { publicLogoMetadataSource } from "./sources.js";
import { createHash, randomUUID } from "node:crypto";
import {
  PUBLIC_EPG_CURRENT_KEY,
  PUBLIC_EPG_LIMITS,
  PUBLIC_EPG_MANIFEST_VERSION,
  PUBLIC_EPG_SOURCE_IDS,
  PUBLIC_EPG_METADATA_COMPACT_PREFIX,
  PUBLIC_EPG_PREFIX,
  PUBLIC_EPG_PUBLISHER_STATE_KEY,
  PUBLIC_EPG_SCHEMA_VERSION,
  PUBLIC_TAXONOMY_INDEX_VERSION,
  identityKey,
  taxonomyDirectoryKey,
  normalizePublicName,
  publicProgrammeNameDescriptorKey,
  validArtifactRef,
  validCurrentPointer,
  validMetadataSuggestionBucketEntry,
  validPublicChannelCandidate,
  validPublicStreamsEntry,
  validPublicTaxonomyRoot,
  validPublicProgrammeChannel,
  validPublicProgrammeNameDescriptor,
  validPublicProgrammeNamePosting,
  programmeIdentityKey,
  validManifest,
  type ArtifactRef,
  type CurrentPointer,
  type PublicEpgManifest,
  type PublicEpgSourceStatus,
  type PublicIdentityEntry,
  type PublicAccessEntry,
  type PublicStreamsEntry,
  type MetadataSuggestionBucketEntry,
  type PublicMetadataSuggestionCandidate,
  type ProgrammePartRef,
  type PublicTaxonomyPage,
  type PublicTaxonomyPosting,
  type PublicTaxonomyVocabulary,
  type PublicProgrammeChannel,
  type PublicProgrammeNameDescriptor,
  type PublicProgrammeNamePosting
} from "@vocaltv/public-epg-contract";
import {
  buildChannelSeeds,
  buildMetadataNameIndex,
  buildMetadataNameSuggestionIndex,
  buildNameIndex,
  mergeMetadataSuggestionIndexes,
  mergeIdentityEntry
} from "./identity.js";
import {
  gunzip,
  getVerifiedBytes,
  getVerifiedJSON,
  hasVerifiedArtifact,
  hasIdenticalCachedObject,
  hasIdenticalStoredObject,
  jsonBytes,
  markVerifiedArtifact,
  putImmutable,
  sha256,
  stableJSON,
  type ObjectMetadata,
  type ObjectStore,
  type RetentionObjectStore,
  type VerifiedArtifact,
  type VerifiedArtifactStore
} from "./encoding.js";
import {
  buildSourceIndex,
  combineSourceIndexes,
  type GeneratedSourceIndex,
  type SourceIndexEntry
} from "./programmes.js";
import { publicEpgSources, publicMetadataSources } from "./sources.js";
import type { FixedEpgSource } from "./xmltv.js";
import {
  readRoutedDirectory,
  readTaxonomyPostingPages,
  writeRoutedDirectory,
  writeTaxonomyDirectory,
  identityRecords,
  nameRecords,
  streamsRecords,
  accessRecords,
  programmeRecords,
  programmeNameRecords,
  metadataSuggestionRecords
} from "./index-builder.js";
import type { ChannelSeed, NameEntryRecord } from "./identity.js";
import {
  buildPublicAccessIndex,
  buildPublicStreams,
  buildPublicTaxonomyIndex,
  publicAccessGraphMatches,
  PUBLIC_ACCESS_INDEX_VERSION
} from "./streams.js";
import { runRetention } from "./retention.js";
import { assertStorageHeadroom } from "./storage-budget.js";
import { BoundedSemaphore, mapBounded } from "./bounded.js";
import { buildWikidataSuggestionIndex, fetchWikidataSuggestions } from "./wikidata.js";

const HEX = /^[a-f0-9]{64}$/u;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_SOURCE_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 45_000;
const LEASE_TTL_MS = 30 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_RUN_OBJECT_CACHE_BYTES = 128 * 1024 * 1024;
const INDEX_GENERATOR_VERSION = 8;
const SOURCE_INDEX_SCHEMA_VERSION = 2;
// Bump only when public channel metadata projections or metadata matching/index rules change.
// Keep this separate from the EPG index generator so schedule changes do not invalidate metadata.
export const CHANNEL_METADATA_GENERATOR_VERSION = 2;
const METADATA_NAME_GENERATOR_VERSION = 1;
const PUBLISHER_LEASE_KEY = PUBLIC_EPG_PREFIX + "publisher/lease.json";
const MAX_IMMUTABLE_PUT_CONCURRENCY = 8;

export type PublisherRunLimits = {
  maxHTTPRequests: number;
  maxHTTPBytes: number;
  maxR2GetRequests: number;
  maxR2GetBytes: number;
  maxR2PutRequests: number;
  maxR2PutBytes: number;
  maxR2ListRequests: number;
  maxR2DeleteRequests: number;
  maxR2DeleteObjects: number;
};

export const PUBLISHER_RUN_LIMITS: PublisherRunLimits = {
  maxHTTPRequests: 128,
  maxHTTPBytes: 416 * 1024 * 1024,
  // Source-local v2 publishes every trusted XMLTV identity. The measured cold
  // graph needs 35,568 PUTs / 40,444 GETs; retain room for reuse and two pinned
  // publications without relaxing the independent byte/storage ceilings.
  maxR2GetRequests: 100_000,
  maxR2GetBytes: 1024 * 1024 * 1024,
  maxR2PutRequests: 50_000,
  maxR2PutBytes: 2 * 1024 * 1024 * 1024,
  maxR2ListRequests: 500,
  maxR2DeleteRequests: 100,
  maxR2DeleteObjects: 100_000
};

type PublisherUsage = {
  httpRequests: number;
  httpBytes: number;
  r2Gets: number;
  r2GetBytes: number;
  r2Puts: number;
  r2PutBytes: number;
  r2Lists: number;
  r2DeleteRequests: number;
  r2DeleteObjects: number;
};

export type PublisherProgress = Partial<PublisherUsage> & {
  phase: "publisher" | "upstream" | "r2" | "sources" | "validation";
  limits?: PublisherRunLimits;
  metadataNameValidation?: MetadataNameValidationDiagnostic;
  sourcesCompleted?: number;
  sourceTotal?: number;
  programmesParsedInSource?: number;
};

export class BudgetedObjectStore implements VerifiedArtifactStore, RetentionObjectStore {
  readonly usage: PublisherUsage = {
    httpRequests: 0, httpBytes: 0, r2Gets: 0, r2GetBytes: 0, r2Puts: 0, r2PutBytes: 0,
    r2Lists: 0, r2DeleteRequests: 0, r2DeleteObjects: 0
  };
  private lastProgressBytes = 0;
  private lastProgressOperations = 0;
  private readonly verifiedArtifacts = new Map<string, VerifiedArtifact>();
  private readonly cachedObjects = new Map<string, Uint8Array>();
  private readonly immutableWriteSlots = new BoundedSemaphore(MAX_IMMUTABLE_PUT_CONCURRENCY);
  private readonly immutablePutFlights = new Map<string, Promise<string>>();
  private cachedObjectBytes = 0;

  constructor(
    private readonly inner: RetentionObjectStore,
    readonly limits: PublisherRunLimits,
    private readonly onProgress?: (progress: PublisherProgress) => void,
    private readonly maxConditionalAttempts = 3
  ) {}

  recordHTTPRequest(): void {
    this.usage.httpRequests += 1;
    if (this.usage.httpRequests % 16 === 0) this.report("upstream");
    if (this.usage.httpRequests > this.limits.maxHTTPRequests) throw new Error("publisher_http_request_budget_exceeded");
  }

  recordHTTPBytes(bytes: number): void {
    this.usage.httpBytes += bytes;
    if (this.usage.httpBytes - this.lastProgressBytes >= 16 * 1024 * 1024) {
      this.lastProgressBytes = this.usage.httpBytes;
      this.report("upstream");
    }
    if (this.usage.httpBytes > this.limits.maxHTTPBytes) throw new Error("publisher_http_byte_budget_exceeded");
  }

  async get(key: string, maximumBytes?: number): Promise<Uint8Array | null> {
    // A content-addressed object just acknowledged by R2 is immutable in this
    // run. Reuse its bytes; consumers still validate hash, size and structure.
    if (this.isImmutableArtifactKey(key)) {
      const cached = this.getCachedObject(key, maximumBytes ?? 64 * 1024 * 1024);
      if (cached) return cached;
    }
    this.usage.r2Gets += 1;
    if (this.usage.r2Gets > this.limits.maxR2GetRequests) throw new Error("publisher_r2_get_budget_exceeded");
    this.reportR2Progress();
    const value = await this.inner.get(key, maximumBytes);
    this.recordRead(value?.byteLength ?? 0);
    if (value) this.cacheObject(key, value);
    return value;
  }

  async getWithETag(key: string, maximumBytes: number): Promise<{ value: Uint8Array; etag: string } | null> {
    this.usage.r2Gets += 1;
    if (this.usage.r2Gets > this.limits.maxR2GetRequests) throw new Error("publisher_r2_get_budget_exceeded");
    this.reportR2Progress();
    const value = await this.inner.getWithETag(key, maximumBytes);
    this.recordRead(value?.value.byteLength ?? 0);
    if (value) this.cacheObject(key, value.value);
    return value;
  }

  async put(key: string, value: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    this.reserveWrite(value.byteLength);
    this.reportR2Progress();
    await this.inner.put(key, value, metadata);
    this.cacheObject(key, value);
  }

  async putConditional(
    key: string,
    value: Uint8Array,
    metadata: ObjectMetadata,
    condition: { ifMatch: string } | { ifNoneMatch: "*" }
  ): Promise<string> {
    const write = async (): Promise<string> => {
      // Retry only verified transient provider failures, with every actual
      // attempt charged to the same finite operation/byte budget. Conditional
      // mutable writes reconcile an unknown ACK before retrying their exact CAS.
      for (let attempt = 0; ; attempt += 1) {
        this.reserveWrite(value.byteLength);
        this.reportR2Progress();
        try {
          const etag = await this.inner.putConditional(key, value, metadata, condition);
          this.cacheObject(key, value);
          return etag;
        } catch (error) {
          if (attempt + 1 >= this.maxConditionalAttempts || !(error instanceof Error)
            || !/^r2_put_failed:(?:408|429|5\d\d|0:(?:TimeoutError|AbortError))(?:[:][A-Za-z_]{1,64})?$/u.test(error.message)) throw error;
          const current = await this.getWithETag(key, Math.max(value.byteLength, MAX_STATE_BYTES));
          if (current && current.value.byteLength === value.byteLength
            && current.value.every((byte, index) => byte === value[index])) {
            this.cacheObject(key, value);
            return current.etag;
          }
          if ("ifMatch" in condition ? !current || current.etag !== condition.ifMatch : current !== null) {
            throw new Error("r2_precondition_failed");
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    };
    if (!this.isImmutableArtifactKey(key)) return write();

    // Identical content-addressed XML can back several UTC-day descriptors.
    // Coalesce concurrent If-None-Match attempts so duplicate refs do not race
    // into avoidable failed PUTs and verification GETs.
    if ("ifNoneMatch" in condition) {
      const pending = this.immutablePutFlights.get(key);
      if (pending) return pending;
      const flight = this.immutableWriteSlots.run(write);
      this.immutablePutFlights.set(key, flight);
      try { return await flight; }
      finally { if (this.immutablePutFlights.get(key) === flight) this.immutablePutFlights.delete(key); }
    }
    return this.immutableWriteSlots.run(write);
  }

  private isImmutableArtifactKey(key: string): boolean {
    return /^public-epg\/v1\/(objects\/[a-f0-9]{64}\.(json|xml)\.gz|manifests\/[a-f0-9]{64}\.json|source-names\/[a-f0-9]{64}\.json|publisher\/source-cache\/[A-Za-z0-9._-]{1,160}\/[a-f0-9]{64}\.body)$/u.test(key);
  }

  getCachedObject(key: string, maximumBytes: number): Uint8Array | null {
    if (!key.startsWith(PUBLIC_EPG_PREFIX)) return null;
    const value = this.cachedObjects.get(key);
    return value && value.byteLength <= maximumBytes ? new Uint8Array(value) : null;
  }

  private cacheObject(key: string, value: Uint8Array): void {
    if (!key.startsWith(PUBLIC_EPG_PREFIX) || this.cachedObjects.has(key)
      || this.cachedObjectBytes + value.byteLength > MAX_RUN_OBJECT_CACHE_BYTES) return;
    this.cachedObjects.set(key, new Uint8Array(value));
    this.cachedObjectBytes += value.byteLength;
  }

  async list(prefix: string, cursor?: string): Promise<{ objects: Array<{ key: string; bytes: number; lastModified: number }>; cursor?: string }> {
    this.usage.r2Lists += 1;
    if (this.usage.r2Lists > this.limits.maxR2ListRequests) throw new Error("publisher_r2_list_budget_exceeded");
    this.reportR2Progress();
    return this.inner.list(prefix, cursor);
  }

  async delete(keys: string[]): Promise<void> {
    this.usage.r2DeleteRequests += 1;
    if (this.usage.r2DeleteRequests > this.limits.maxR2DeleteRequests
      || this.usage.r2DeleteObjects + keys.length > this.limits.maxR2DeleteObjects) {
      throw new Error("publisher_r2_delete_budget_exceeded");
    }
    this.usage.r2DeleteObjects += keys.length;
    this.reportR2Progress();
    await this.inner.delete(keys);
  }

  hasVerifiedArtifact(key: string, artifact: VerifiedArtifact): boolean {
    const known = this.verifiedArtifacts.get(key);
    return !!known && known.storedSha256 === artifact.storedSha256
      && known.storedBytes === artifact.storedBytes
      && known.rawSha256 === artifact.rawSha256
      && known.rawBytes === artifact.rawBytes;
  }

  markVerifiedArtifact(key: string, artifact: VerifiedArtifact): void {
    this.verifiedArtifacts.set(key, artifact);
  }

  private recordRead(bytes: number): void {
    this.usage.r2GetBytes += bytes;
    if (this.usage.r2GetBytes > this.limits.maxR2GetBytes) throw new Error("publisher_r2_read_byte_budget_exceeded");
  }

  private reserveWrite(bytes: number): void {
    if (this.usage.r2Puts + 1 > this.limits.maxR2PutRequests
      || this.usage.r2PutBytes + bytes > this.limits.maxR2PutBytes) {
      this.report("r2");
      throw new Error("publisher_r2_write_budget_exceeded");
    }
    this.usage.r2Puts += 1;
    this.usage.r2PutBytes += bytes;
  }

  private reportR2Progress(): void {
    const operations = this.usage.r2Gets + this.usage.r2Puts + this.usage.r2Lists + this.usage.r2DeleteRequests;
    if (operations - this.lastProgressOperations < 250) return;
    this.lastProgressOperations = operations;
    this.report("r2");
  }

  report(phase: PublisherProgress["phase"], details: Pick<PublisherProgress, "sourcesCompleted" | "sourceTotal" | "programmesParsedInSource" | "metadataNameValidation" | "limits"> = {}): void {
    this.onProgress?.({ phase, ...this.usage, ...details });
  }
}

function isBudgetError(error: unknown): boolean {
  return error instanceof Error && /^publisher_.*_budget_exceeded$/u.test(error.message);
}

type LeaseRecord = { schemaVersion: 1; owner: string; expiresAt: number };

export class PublishLease {
  private constructor(private readonly owner: string, private etag: string, private expiresAt: number) {}

  /** Persist only in a server-owned maintenance record, never in the public API. */
  getOwner(): string { return this.owner; }

  static async resume(store: ObjectStore, owner: string, now: number): Promise<PublishLease> {
    const current = await store.getWithETag(PUBLISHER_LEASE_KEY, 2048);
    if (!current) throw new Error("publisher_lease_lost");
    let record: unknown;
    try { record = parseJSON(current.value); } catch { throw new Error("publisher_lease_lost"); }
    if (!isRecord(record) || record.schemaVersion !== 1 || record.owner !== owner
      || !Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) <= now) {
      throw new Error("publisher_lease_lost");
    }
    return new PublishLease(owner, current.etag, Number(record.expiresAt));
  }

  static async acquire(store: ObjectStore, now: number): Promise<PublishLease> {
    const owner = randomUUID();
    const record: LeaseRecord = { schemaVersion: 1, owner, expiresAt: now + LEASE_TTL_MS };
    const bytes = jsonBytes(record);
    const metadata: ObjectMetadata = { contentType: "application/json", cacheControl: "no-store" };
    const existing = await store.getWithETag(PUBLISHER_LEASE_KEY, 2048);
    try {
      if (!existing) {
        const etag = await store.putConditional(PUBLISHER_LEASE_KEY, bytes, metadata, { ifNoneMatch: "*" });
        return new PublishLease(owner, etag, record.expiresAt);
      }
      let value: unknown;
      try { value = parseJSON(existing.value); } catch { throw new Error("publisher_lease_invalid"); }
      if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.owner !== "string"
        || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) > now) {
        throw new Error("publisher_lease_busy");
      }
      const etag = await store.putConditional(PUBLISHER_LEASE_KEY, bytes, metadata, { ifMatch: existing.etag });
      return new PublishLease(owner, etag, record.expiresAt);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("publisher_lease_")) throw error;
      // An acknowledged write may have committed despite a lost transport ACK.
      // Reconcile the exact generated lease, never adopt another publisher's owner.
      const committed = await store.getWithETag(PUBLISHER_LEASE_KEY, 2048);
      if (committed && sha256(committed.value) === sha256(bytes)) return new PublishLease(owner, committed.etag, record.expiresAt);
      if (error instanceof Error && error.message === "r2_precondition_failed") throw new Error("publisher_lease_busy");
      throw error;
    }
  }

  async renew(store: ObjectStore, now: number): Promise<void> {
    if (now >= this.expiresAt) throw new Error("publisher_lease_lost");
    const current = await store.getWithETag(PUBLISHER_LEASE_KEY, 2048);
    if (!current || current.etag !== this.etag) throw new Error("publisher_lease_lost");
    let record: unknown;
    try { record = parseJSON(current.value); } catch { throw new Error("publisher_lease_lost"); }
    if (!isRecord(record) || record.owner !== this.owner || Number(record.expiresAt) <= now) throw new Error("publisher_lease_lost");
    const next: LeaseRecord = { schemaVersion: 1, owner: this.owner, expiresAt: now + LEASE_TTL_MS };
    try {
      this.etag = await store.putConditional(PUBLISHER_LEASE_KEY, jsonBytes(next), {
        contentType: "application/json", cacheControl: "no-store"
      }, { ifMatch: current.etag });
      this.expiresAt = next.expiresAt;
    } catch (error) {
      // A finite operation/byte budget is not evidence of foreign lease loss.
      if (isBudgetError(error)) throw error;
      throw new Error("publisher_lease_lost");
    }
  }

  async release(store: ObjectStore, now: number): Promise<void> {
    try {
      const current = await store.getWithETag(PUBLISHER_LEASE_KEY, 2048);
      if (!current || current.etag !== this.etag) return;
      const record: LeaseRecord = { schemaVersion: 1, owner: this.owner, expiresAt: now };
      await store.putConditional(PUBLISHER_LEASE_KEY, jsonBytes(record), {
        contentType: "application/json", cacheControl: "no-store"
      }, { ifMatch: current.etag });
    } catch {
      // A failed release leaves only a bounded-expiry lease; it cannot commit stale data.
    }
  }
}

type CachedMetadata = {
  sourceRevision: string;
  bodyRef: ArtifactRef;
  etag: string | null;
  lastModified: string | null;
  lastGoodAt: string;
};

type CachedSource = {
  sourceRevision: string;
  bodyKey: string;
  bodySha256: string;
  bodyBytes: number;
  indexRef: ArtifactRef;
  etag: string | null;
  lastModified: string | null;
  lastGoodAt: string;
};

type PublisherIndexStats = {
  programmeCount: number;
  shardCount: number;
  channelCount: number;
  nameTermCount: number;
  metadataNameTermCount?: number;
  accessDigestCount?: number;
  accessMemberCount?: number;
  accessAmbiguousCount?: number;
  taxonomyPostingCount?: number;
  taxonomyMemberCount?: number;
  taxonomyPageCount?: number;
};

type PublisherStateSnapshot = {
  metadata: Record<string, CachedMetadata>;
  sources: Record<string, CachedSource>;
  indexInputDigest?: string;
  metadataNameInputDigest?: string;
  taxonomyInputDigest?: string;
  indexStats?: PublisherIndexStats;
};

type PublisherState = PublisherStateSnapshot & {
  schemaVersion: 1;
  /** One previous source snapshot remains pinned while the latest is committed. */
  previousStates?: PublisherStateSnapshot[];
  /** One previous publication remains pinned after compare-and-swap. */
  previousPointers?: CurrentPointer[];
  /** Last index-input digest and counts used to reuse deterministic roots. */
  indexInputDigest?: string;
  metadataNameInputDigest?: string;
  taxonomyInputDigest?: string;
  indexStats?: PublisherIndexStats;
  /** Set only after a complete, fenced retention sweep succeeds. */
  lastRetentionAt?: number;
};

type LoadedPublisherState = { value: PublisherState; etag: string | null };

type FetchResult =
  | { kind: "not-modified"; etag: string | null; lastModified: string | null }
  | { kind: "modified"; body: Uint8Array; etag: string | null; lastModified: string | null };

type MetadataResult = {
  state: CachedMetadata;
  value: unknown;
  freshness: "ready" | "stale";
};

export type PublisherSummary = {
  revision: string;
  published: boolean;
  metadataCount: number;
  sourceCount: number;
  staleSources: number;
  unavailableSources: number;
  parsedSources: number;
  reusedSources: number;
  channelCount: number;
  nameTermCount: number;
  metadataNameTermCount: number;
  accessDigestCount: number;
  accessMemberCount: number;
  accessAmbiguousCount: number;
  taxonomyPostingCount: number;
  taxonomyMemberCount: number;
  taxonomyPageCount: number;
  metadataSuggestionTermCount: number;
  wikidataSuggestionStatus: "ready" | "stale" | "unavailable";
  sourceProgrammeChannelCount: number;
  externallyLinkedProgrammeChannelCount: number;
  externallyUnconfirmedProgrammeChannelCount: number;
  programmeCount: number;
  shardCount: number;
  elapsedMs: number;
  httpRequests: number;
  httpBytes: number;
  r2GetRequests: number;
  r2GetBytes: number;
  r2PutRequests: number;
  r2PutBytes: number;
  r2ListRequests: number;
  r2DeleteRequests: number;
  r2DeleteObjects: number;
  retentionObjects: number;
  retentionNamespaceBytes: number | null;
  retentionStorageBudgetExceeded: boolean | null;
  retentionRan: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validValidator(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 512 && !/[\r\n\u0000]/u.test(value);
}

function validCachedMetadata(value: unknown): value is CachedMetadata {
  return isRecord(value) && typeof value.sourceRevision === "string" && HEX.test(value.sourceRevision)
    && validArtifactRef(value.bodyRef) && validValidator(value.etag) && validValidator(value.lastModified)
    && validTimestamp(value.lastGoodAt);
}

function validCachedSource(value: unknown, source: (typeof publicEpgSources)[number]): value is CachedSource {
  return isRecord(value) && typeof value.sourceRevision === "string" && HEX.test(value.sourceRevision)
    && value.bodyKey === sourceBodyKey(source.id, value.sourceRevision)
    && typeof value.bodySha256 === "string" && HEX.test(value.bodySha256)
    && Number.isSafeInteger(value.bodyBytes) && Number(value.bodyBytes) > 0
    && Number(value.bodyBytes) <= source.maximumCompressedBytes
    && validArtifactRef(value.indexRef) && validValidator(value.etag) && validValidator(value.lastModified)
    && validTimestamp(value.lastGoodAt);
}

function validIndexStats(value: unknown): value is PublisherIndexStats {
  if (!isRecord(value)) return false;
  const boundedCount = (candidate: unknown, maximum: number): candidate is number =>
    Number.isSafeInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= maximum;
  return boundedCount(value.programmeCount, 10_000_000)
    && boundedCount(value.shardCount, 10_000_000)
    && boundedCount(value.channelCount, 300_000)
    && boundedCount(value.nameTermCount, 10_000_000)
    && (value.metadataNameTermCount === undefined || boundedCount(value.metadataNameTermCount, PUBLIC_EPG_LIMITS.maxMetadataNameTerms))
    && (value.accessDigestCount === undefined || boundedCount(value.accessDigestCount, 500_000))
    && (value.accessMemberCount === undefined || boundedCount(value.accessMemberCount, 500_000))
    && (value.accessAmbiguousCount === undefined || boundedCount(value.accessAmbiguousCount, 500_000))
    && (value.accessDigestCount === undefined && value.accessMemberCount === undefined && value.accessAmbiguousCount === undefined
      || boundedCount(value.accessDigestCount, 500_000) && boundedCount(value.accessMemberCount, 500_000)
        && boundedCount(value.accessAmbiguousCount, 500_000))
    && (value.taxonomyPostingCount === undefined && value.taxonomyMemberCount === undefined && value.taxonomyPageCount === undefined
      || boundedCount(value.taxonomyPostingCount, PUBLIC_EPG_LIMITS.maxPublicTaxonomyPostings)
        && boundedCount(value.taxonomyMemberCount, PUBLIC_EPG_LIMITS.maxPublicTaxonomyMemberships)
        && boundedCount(value.taxonomyPageCount, PUBLIC_EPG_LIMITS.maxPublicTaxonomyMemberships));
}

function hasAccessIndexStats(value: PublisherIndexStats | undefined): value is PublisherIndexStats & {
  accessDigestCount: number;
  accessMemberCount: number;
  accessAmbiguousCount: number;
} {
  return !!value && Number.isSafeInteger(value.accessDigestCount) && Number.isSafeInteger(value.accessMemberCount)
    && Number.isSafeInteger(value.accessAmbiguousCount);
}

function hasTaxonomyIndexStats(value: PublisherIndexStats | undefined): value is PublisherIndexStats & {
  taxonomyPostingCount: number;
  taxonomyMemberCount: number;
  taxonomyPageCount: number;
} {
  return !!value && Number.isSafeInteger(value.taxonomyPostingCount)
    && Number.isSafeInteger(value.taxonomyMemberCount) && Number.isSafeInteger(value.taxonomyPageCount);
}

export type MetadataNameValidationDiagnostic = {
  reason: "term_not_normalized" | "compact_term_whitespace" | "reserved_term"
    | "ambiguity_invalid" | "candidate_limit" | "candidate_invalid";
  entryIndex: number;
  termSha256: string;
  termLength: number;
  candidateCount: number;
};

export function validateMetadataNameEntries(
  entries: readonly NameEntryRecord[],
  onInvalid?: (diagnostic: MetadataNameValidationDiagnostic) => void
): void {
  if (entries.length > PUBLIC_EPG_LIMITS.maxMetadataNameTerms) throw new Error("metadata_name_term_budget_exceeded");
  for (const [entryIndex, entry] of entries.entries()) {
    const compactTerm = entry.term.startsWith(PUBLIC_EPG_METADATA_COMPACT_PREFIX);
    const normalizedTerm = compactTerm ? entry.term.slice(PUBLIC_EPG_METADATA_COMPACT_PREFIX.length) : entry.term;
    const reason: MetadataNameValidationDiagnostic["reason"] | null =
      !normalizedTerm || normalizedTerm !== normalizePublicName(normalizedTerm) ? "term_not_normalized"
      : compactTerm && /\s/u.test(normalizedTerm) ? "compact_term_whitespace"
      : !compactTerm && entry.term.startsWith("gram:") ? "reserved_term"
      : entry.candidates.length > PUBLIC_EPG_LIMITS.maxMetadataNameCandidates ? "candidate_limit"
      : typeof entry.ambiguous !== "boolean" || entry.ambiguous && entry.candidates.length !== 0
        || !entry.ambiguous && entry.candidates.length === 0 ? "ambiguity_invalid"
      : entry.candidates.some((candidate) => !validPublicChannelCandidate(candidate)
        || candidate.projection !== undefined || candidate.matchKind === "gram"
        || compactTerm && candidate.matchKind !== "alias") ? "candidate_invalid"
      : null;
    if (reason) {
      // One fixed-size structural record; never log source names, IDs or URLs.
      onInvalid?.({ reason, entryIndex, termSha256: sha256(entry.term),
        termLength: entry.term.length, candidateCount: entry.candidates.length });
      throw new Error("metadata_name_index_invalid");
    }
  }
}

function indexInputDigest(
  metadata: Record<string, CachedMetadata>,
  sources: Record<string, CachedSource>,
  generatorVersion = INDEX_GENERATOR_VERSION
): string {
  return sha256(stableJSON({
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    generatorVersion,
    accessIndexVersion: PUBLIC_ACCESS_INDEX_VERSION,
    metadata: [...publicMetadataSources, ...(metadata[publicLogoMetadataSource.id] ? [publicLogoMetadataSource] : [])].map((source) => [
      source.id,
      metadata[source.id]?.sourceRevision ?? null,
      metadata[source.id]?.bodyRef.sha256 ?? null
    ]),
    sources: publicEpgSources.map((source) => [
      source.id,
      sources[source.id]?.sourceRevision ?? null,
      sources[source.id]?.indexRef.sha256 ?? null
    ])
  }));
}

function metadataNameInputDigest(metadata: Record<string, CachedMetadata>): string {
  return sha256(stableJSON({
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    generatorVersion: METADATA_NAME_GENERATOR_VERSION,
    metadata: publicMetadataSources
      .filter((source) => source.id === "iptv-org:channels" || source.id === "iptv-org:feeds")
      .map((source) => [source.id, metadata[source.id]?.sourceRevision ?? null, metadata[source.id]?.bodyRef.sha256 ?? null])
  }));
}

function taxonomyInputDigest(metadata: Record<string, CachedMetadata>): string {
  return sha256(stableJSON({
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    taxonomyIndexVersion: PUBLIC_TAXONOMY_INDEX_VERSION,
    metadata: publicMetadataSources
      .filter((source) => source.id === "iptv-org:channels" || source.id === "iptv-org:feeds" || source.id === "iptv-org:categories")
      .map((source) => [source.id, metadata[source.id]?.sourceRevision ?? null, metadata[source.id]?.bodyRef.sha256 ?? null])
  }));
}

export function channelMetadataRevision(
  seeds: readonly ChannelSeed[],
  metadataNameRoot: ArtifactRef,
  metadataSuggestionRoot: ArtifactRef | undefined,
  generatorVersion = CHANNEL_METADATA_GENERATOR_VERSION,
  taxonomyRoot: ArtifactRef | undefined = undefined
): string {
  const projectionHash = createHash("sha256");
  for (const seed of [...seeds].sort((left, right) =>
    identityKey(left.identity).localeCompare(identityKey(right.identity)))) {
    projectionHash.update(stableJSON({
      identity: seed.identity,
      canonicalName: seed.canonicalName,
      logoURL: seed.logoURL ?? null,
      feedName: seed.feedName,
      name: seed.name,
      aliases: seed.aliases,
      metadataNameAliases: seed.metadataNameAliases,
      languages: seed.languages,
      broadcastAreas: seed.broadcastAreas,
      timezones: seed.timezones,
      country: seed.country,
      categoryIDs: seed.categoryIDs,
      channelLanguages: seed.channelLanguages
    })).update("\n");
  }
  return sha256(stableJSON({
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    generatorVersion,
    channelProjectionDigest: projectionHash.digest("hex"),
    metadataNameRoot: metadataNameRoot.sha256,
    metadataSuggestionRoot: metadataSuggestionRoot?.sha256 ?? null,
    taxonomyIndexVersion: PUBLIC_TAXONOMY_INDEX_VERSION,
    taxonomyRoot: taxonomyRoot?.sha256 ?? null
  }));
}

function emptyState(): PublisherState {
  return { schemaVersion: 1, metadata: {}, sources: {}, previousStates: [], previousPointers: [] };
}

function sourceBodyKey(sourceID: string, revision: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(sourceID) || !HEX.test(revision)) throw new Error("source_id_invalid");
  return PUBLIC_EPG_PREFIX + "publisher/source-cache/" + sourceID + "/" + revision + ".body";
}

function validPublisherSnapshot(value: unknown): value is PublisherStateSnapshot {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.sources)
    || !(value.indexInputDigest === undefined || typeof value.indexInputDigest === "string" && HEX.test(value.indexInputDigest))
    || !(value.metadataNameInputDigest === undefined || typeof value.metadataNameInputDigest === "string" && HEX.test(value.metadataNameInputDigest))
    || !(value.taxonomyInputDigest === undefined || typeof value.taxonomyInputDigest === "string" && HEX.test(value.taxonomyInputDigest))
    || !(value.indexStats === undefined || validIndexStats(value.indexStats))) return false;
  for (const [id, metadata] of Object.entries(value.metadata)) {
    const source = [...publicMetadataSources, publicLogoMetadataSource].find((item) => item.id === id);
    if (!source || !validCachedMetadata(metadata)) return false;
  }
  for (const [id, sourceValue] of Object.entries(value.sources)) {
    const source = publicEpgSources.find((item) => item.id === id);
    if (!source || !validCachedSource(sourceValue, source)) return false;
  }
  return true;
}

async function readPublisherState(store: ObjectStore): Promise<LoadedPublisherState> {
  const stored = await store.getWithETag(PUBLIC_EPG_PUBLISHER_STATE_KEY, MAX_STATE_BYTES);
  if (stored === null) return { value: emptyState(), etag: null };
  let raw: unknown;
  try { raw = parseJSON(stored.value); }
  catch { throw new Error("publisher_state_invalid"); }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !validPublisherSnapshot(raw)) {
    throw new Error("publisher_state_invalid");
  }
  const extended = raw as PublisherState;
  const previousStates = extended.previousStates === undefined ? [] : extended.previousStates;
  const previousPointers = extended.previousPointers === undefined ? [] : extended.previousPointers;
  if (!Array.isArray(previousStates) || previousStates.length > 1 || !previousStates.every(validPublisherSnapshot)
    || !Array.isArray(previousPointers) || previousPointers.length > 1 || !previousPointers.every(validCurrentPointer)
    || !(extended.lastRetentionAt === undefined || Number.isSafeInteger(extended.lastRetentionAt) && extended.lastRetentionAt >= 0)) {
    throw new Error("publisher_state_invalid");
  }
  return {
    value: {
      schemaVersion: 1,
      metadata: raw.metadata,
      sources: raw.sources,
      previousStates,
      previousPointers,
      ...(extended.indexInputDigest ? { indexInputDigest: extended.indexInputDigest } : {}),
      ...(extended.metadataNameInputDigest ? { metadataNameInputDigest: extended.metadataNameInputDigest } : {}),
      ...(extended.taxonomyInputDigest ? { taxonomyInputDigest: extended.taxonomyInputDigest } : {}),
      ...(extended.indexStats ? { indexStats: extended.indexStats } : {}),
      ...(extended.lastRetentionAt !== undefined ? { lastRetentionAt: extended.lastRetentionAt } : {})
    },
    etag: stored.etag
  };
}

function parseJSON(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("source_json_invalid");
  }
}

function safeURL(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error("source_url_rejected");
  }
  return url;
}

function boundedHeader(value: string | null): string | null {
  return value && value.length <= 512 && !/[\r\n\u0000]/u.test(value) ? value : null;
}

async function readLimitedBody(response: Response, maximumBytes: number, onBytes?: (bytes: number) => void): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) throw new Error("source_body_oversized");
  }
  if (!response.body) throw new Error("source_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("source_body_oversized");
      }
      onBytes?.(next.value.byteLength);
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchFixed(
  urlValue: string,
  allowedRedirectHosts: readonly string[],
  maximumBytes: number,
  validators: { etag?: string | null; lastModified?: string | null } = {},
  fetchImpl: typeof fetch = fetch,
  usage?: BudgetedObjectStore
): Promise<FetchResult> {
  const initial = safeURL(urlValue, [new URL(urlValue).hostname.toLowerCase(), ...allowedRedirectHosts.map((host) => host.toLowerCase())]);
  const allowed = new Set([initial.hostname.toLowerCase(), ...allowedRedirectHosts.map((host) => host.toLowerCase())]);
  let url = initial;
  for (let redirects = 0; ; redirects += 1) {
    const headers = new Headers({ accept: "application/xml, application/json, */*;q=0.1" });
    if (validators.etag) headers.set("if-none-match", validators.etag);
    if (validators.lastModified) headers.set("if-modified-since", validators.lastModified);
    let response: Response;
    usage?.recordHTTPRequest();
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new Error("source_network_error");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirects >= MAX_HTTP_REDIRECTS) throw new Error("source_redirect_rejected");
      let redirected: URL;
      try {
        redirected = safeURL(new URL(location, url).toString(), [...allowed]);
      } catch {
        throw new Error("source_redirect_rejected");
      }
      url = redirected;
      continue;
    }
    const etag = boundedHeader(response.headers.get("etag"));
    const lastModified = boundedHeader(response.headers.get("last-modified"));
    if (response.status === 304) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "not-modified", etag: etag ?? validators.etag ?? null, lastModified: lastModified ?? validators.lastModified ?? null };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("source_http_" + response.status);
    }
    const body = await readLimitedBody(response, maximumBytes, usage ? (bytes) => usage.recordHTTPBytes(bytes) : undefined);
    return { kind: "modified", body, etag, lastModified };
  }
}

function sourceFetchError(error: unknown): boolean {
  return error instanceof Error && /^(source_(network_error|http_\d+|redirect_rejected|url_rejected|body_oversized|body_missing))$/u.test(error.message);
}

function storageError(error: unknown): boolean {
  return error instanceof Error && /^(r2_|local_store_|artifact_|immutable_object_|publisher_state_)/u.test(error.message);
}

async function getMetadataValue(store: ObjectStore, ref: ArtifactRef): Promise<unknown> {
  const bytes = await getVerifiedBytes(store, ref, 64 * 1024 * 1024);
  return parseJSON(bytes);
}

async function loadMetadata(
  store: ObjectStore,
  source: (typeof publicMetadataSources)[number] | typeof publicLogoMetadataSource,
  previous: CachedMetadata | undefined,
  fetchImpl: typeof fetch,
  now: string,
  usage: BudgetedObjectStore
): Promise<MetadataResult> {
  try {
    let fetched = await fetchFixed(
      source.publicURL,
      source.allowedRedirectHosts,
      source.maximumBytes,
      previous ? { etag: previous.etag, lastModified: previous.lastModified } : {},
      fetchImpl,
      usage
    );
    if (fetched.kind === "not-modified" && !previous) {
      fetched = await fetchFixed(source.publicURL, source.allowedRedirectHosts, source.maximumBytes, {}, fetchImpl, usage);
    }
    if (fetched.kind === "not-modified") {
      const value = await getMetadataValue(store, previous!.bodyRef);
      return { state: previous!, value, freshness: "ready" };
    }
    const value = parseJSON(fetched.body);
    const sourceRevision = sha256(fetched.body);
    const bodyRef = await putImmutable(store, "json", fetched.body);
    return {
      state: {
        sourceRevision,
        bodyRef,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        lastGoodAt: sourceRevision === previous?.sourceRevision ? previous.lastGoodAt : now
      },
      value,
      freshness: "ready"
    };
  } catch (error) {
    if (isBudgetError(error)) throw error;
    if (storageError(error)) throw error;
    if (!previous) throw error;
    return { state: previous, value: await getMetadataValue(store, previous.bodyRef), freshness: "stale" };
  }
}

function metadataStatus(sourceID: string, state: CachedMetadata, freshness: "ready" | "stale"): PublicEpgSourceStatus {
  return { sourceID, sourceRevision: state.sourceRevision, status: freshness, lastGoodAt: state.lastGoodAt };
}

function sourceStatus(sourceID: string, state: CachedSource | undefined, freshness: "ready" | "stale" | "unavailable"): PublicEpgSourceStatus {
  return { sourceID, sourceRevision: state?.sourceRevision ?? null, status: freshness, lastGoodAt: state?.lastGoodAt ?? null };
}

function validateSourceIndex(value: unknown, source: (typeof publicEpgSources)[number]): GeneratedSourceIndex {
  if (!isRecord(value) || value.schemaVersion !== SOURCE_INDEX_SCHEMA_VERSION || value.sourceID !== source.id
    || typeof value.sourceRevision !== "string" || !HEX.test(value.sourceRevision)
    || !Array.isArray(value.entries) || value.entries.length > 300_000
    || !Number.isSafeInteger(value.programmeCount) || Number(value.programmeCount) < 0
    || !Number.isSafeInteger(value.shardCount) || Number(value.shardCount) < 0) throw new Error("source_index_invalid");
  const entries: SourceIndexEntry[] = [];
  const identities = new Set<string>();
  for (const raw of value.entries) {
    if (!validPublicProgrammeChannel(raw) || raw.sourceID !== source.id
      || raw.sourceRevision !== value.sourceRevision || raw.sourcePriority !== source.priority) throw new Error("source_index_invalid");
    const key = programmeIdentityKey(raw);
    if (identities.has(key)) throw new Error("source_index_duplicate_identity");
    identities.add(key);
    entries.push(raw);
  }
  return {
    sourceID: source.id,
    sourceRevision: value.sourceRevision,
    entries,
    programmeCount: Number(value.programmeCount),
    shardCount: Number(value.shardCount)
  };
}

async function loadSourceIndex(store: ObjectStore, source: (typeof publicEpgSources)[number], previous: CachedSource): Promise<GeneratedSourceIndex> {
  const value = await getVerifiedJSON<unknown>(store, previous.indexRef, MAX_SOURCE_INDEX_BYTES);
  const index = validateSourceIndex(value, source);
  if (index.sourceRevision !== previous.sourceRevision) throw new Error("source_index_invalid");
  return index;
}

async function writeSourceIndex(store: ObjectStore, index: GeneratedSourceIndex): Promise<ArtifactRef> {
  const raw = jsonBytes({ schemaVersion: SOURCE_INDEX_SCHEMA_VERSION, ...index });
  if (raw.byteLength > MAX_SOURCE_INDEX_BYTES) throw new Error("source_index_size_exceeded");
  return putImmutable(store, "json", raw);
}

async function loadSourceBody(store: ObjectStore, source: (typeof publicEpgSources)[number], previous: CachedSource): Promise<Uint8Array> {
  const body = await store.get(previous.bodyKey, source.maximumCompressedBytes);
  if (!body || body.byteLength !== previous.bodyBytes || sha256(body) !== previous.bodySha256
    || previous.bodySha256 !== previous.sourceRevision) throw new Error("source_body_cache_invalid");
  return body;
}

async function cacheSourceBody(store: ObjectStore, source: (typeof publicEpgSources)[number], body: Uint8Array): Promise<{ bodyKey: string; bodySha256: string; bodyBytes: number }> {
  const bodySha256 = sha256(body);
  const bodyKey = sourceBodyKey(source.id, bodySha256);
  await putImmutableRaw(store, bodyKey, body, {
    contentType: "application/octet-stream",
    cacheControl: "private, max-age=31536000, immutable"
  });
  return { bodyKey, bodySha256, bodyBytes: body.byteLength };
}

async function storedIndex(
  store: ObjectStore,
  source: (typeof publicEpgSources)[number],
  body: Uint8Array,
  previous: CachedSource | undefined,
  seeds: ReturnType<typeof buildChannelSeeds>,
  sourceRevision: string,
  now: string,
  onProgrammeProgress?: (programmesParsed: number) => void
): Promise<{ index: GeneratedSourceIndex; state: CachedSource; parsed: boolean }> {
  if (previous && previous.sourceRevision === sourceRevision) {
    const index = await loadSourceIndex(store, source, previous);
    return {
      index,
      state: previous,
      parsed: false
    };
  }
  const fixedSource: FixedEpgSource & { priority: number } = {
    id: source.id,
    publicURL: source.publicURL,
    maximumCompressedBytes: source.maximumCompressedBytes,
    maximumDecompressedBytes: source.maximumDecompressedBytes,
    priority: source.priority
  };
  const index = await buildSourceIndex(store, fixedSource, body, sourceRevision, seeds, onProgrammeProgress);
  const indexRef = await writeSourceIndex(store, index);
  const bodyCache = await cacheSourceBody(store, source, body);
  return {
    index,
    state: {
      sourceRevision,
      ...bodyCache,
      indexRef,
      etag: null,
      lastModified: null,
      lastGoodAt: now
    },
    parsed: true
  };
}

async function processSource(
  store: ObjectStore,
  source: (typeof publicEpgSources)[number],
  previous: CachedSource | undefined,
  seeds: ReturnType<typeof buildChannelSeeds>,
  metadataChanged: boolean,
  fetchImpl: typeof fetch,
  now: string,
  usage: BudgetedObjectStore,
  onProgrammeProgress?: (programmesParsed: number) => void
): Promise<{ state?: CachedSource; index?: GeneratedSourceIndex; freshness: "ready" | "stale" | "unavailable"; parsed: boolean }> {
  let fetched: FetchResult | null = null;
  let fetchFailed = false;
  try {
    fetched = await fetchFixed(
      source.publicURL,
      source.allowedRedirectHosts,
      source.maximumCompressedBytes,
      previous ? { etag: previous.etag, lastModified: previous.lastModified } : {},
      fetchImpl,
      usage
    );
  } catch (error) {
    if (isBudgetError(error)) throw error;
    if (!sourceFetchError(error) && !storageError(error)) {
      // Fetch implementation errors are intentionally collapsed to a safe category.
    }
    fetchFailed = true;
  }

  if (!fetchFailed && fetched?.kind === "not-modified" && previous) {
    try {
      if (!metadataChanged) {
        return {
          state: { ...previous, etag: fetched.etag, lastModified: fetched.lastModified },
          freshness: "ready",
          parsed: false
        };
      }
      const body = await loadSourceBody(store, source, previous);
      const sourceRevision = previous.sourceRevision;
      const fixedSource: FixedEpgSource & { priority: number } = {
        id: source.id, publicURL: source.publicURL,
        maximumCompressedBytes: source.maximumCompressedBytes,
        maximumDecompressedBytes: source.maximumDecompressedBytes,
        priority: source.priority
      };
      const index = await buildSourceIndex(store, fixedSource, body, sourceRevision, seeds, onProgrammeProgress);
      const indexRef = await writeSourceIndex(store, index);
      return {
        index,
        state: { ...previous, indexRef, etag: fetched.etag, lastModified: fetched.lastModified },
        freshness: "ready",
        parsed: true
      };
    } catch (error) {
      if (isBudgetError(error)) throw error;
      if (storageError(error)) throw error;
      fetchFailed = true;
    }
  }

  if (!fetchFailed && fetched?.kind === "modified") {
    const sourceRevision = sha256(fetched.body);
    if (previous && previous.sourceRevision === sourceRevision && !metadataChanged) {
      return {
        state: { ...previous, etag: fetched.etag, lastModified: fetched.lastModified },
        freshness: "ready",
        parsed: false
      };
    }
    try {
      const generated = await storedIndex(store, source, fetched.body, previous, seeds, sourceRevision, now, onProgrammeProgress);
      const bodyCache = generated.state.bodyKey === sourceBodyKey(source.id, generated.state.sourceRevision)
        ? { bodyKey: generated.state.bodyKey, bodySha256: generated.state.bodySha256, bodyBytes: generated.state.bodyBytes }
        : await cacheSourceBody(store, source, fetched.body);
      return {
        index: generated.index,
        state: {
          ...generated.state,
          ...bodyCache,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
          lastGoodAt: generated.state.lastGoodAt
        },
        freshness: "ready",
        parsed: generated.parsed
      };
    } catch (error) {
      if (isBudgetError(error)) throw error;
      if (storageError(error)) throw error;
      fetchFailed = true;
    }
  }

  if (previous) {
    try {
      if (!metadataChanged) {
        return { state: previous, freshness: "stale", parsed: false };
      }
      const body = await loadSourceBody(store, source, previous);
      const fixedSource: FixedEpgSource & { priority: number } = {
        id: source.id, publicURL: source.publicURL,
        maximumCompressedBytes: source.maximumCompressedBytes,
        maximumDecompressedBytes: source.maximumDecompressedBytes,
        priority: source.priority
      };
      const index = await buildSourceIndex(store, fixedSource, body, previous.sourceRevision, seeds);
      const indexRef = await writeSourceIndex(store, index);
      return { index, state: { ...previous, indexRef }, freshness: "stale", parsed: true };
    } catch (error) {
      if (isBudgetError(error)) throw error;
      if (storageError(error)) throw error;
      throw new Error("source_lkg_unavailable");
    }
  }
  return { freshness: "unavailable", parsed: false };
}

export async function loadCurrent(store: ObjectStore): Promise<{ pointer: CurrentPointer; manifest: PublicEpgManifest; bytes: Uint8Array; pointerETag: string } | null> {
  const storedPointer = await store.getWithETag(PUBLIC_EPG_CURRENT_KEY, 2048);
  if (!storedPointer) return null;
  const pointerBytes = storedPointer.value;
  let pointerValue: unknown;
  try { pointerValue = parseJSON(pointerBytes); }
  catch { throw new Error("current_pointer_invalid"); }
  if (!validCurrentPointer(pointerValue)) throw new Error("current_pointer_invalid");
  const manifestBytes = await store.get(pointerValue.manifestKey, 32 * 1024);
  if (!manifestBytes || sha256(manifestBytes) !== pointerValue.manifestSha256) throw new Error("current_manifest_hash_invalid");
  markVerifiedArtifact(store, pointerValue.manifestKey, {
    storedSha256: pointerValue.manifestSha256,
    storedBytes: manifestBytes.byteLength,
    rawSha256: pointerValue.manifestSha256,
    rawBytes: manifestBytes.byteLength
  });
  let manifestValue: unknown;
  try { manifestValue = parseJSON(manifestBytes); }
  catch { throw new Error("current_manifest_invalid"); }
  if (!validManifest(manifestValue) || manifestValue.revision !== pointerValue.revision || manifestValue.sources.length > 32) {
    throw new Error("current_manifest_invalid");
  }
  const rootRefs: Array<[ArtifactRef, string]> = [
    [manifestValue.identityRoot, "identity-root"],
    [manifestValue.nameRoot, "name-root"]
  ];
  if (manifestValue.schemaVersion === PUBLIC_EPG_MANIFEST_VERSION) {
    rootRefs.push([manifestValue.programmeRoot, "programme-root"]);
  }
  if (manifestValue.streamsRoot) rootRefs.push([manifestValue.streamsRoot, "streams-root"]);
  if (manifestValue.accessRoot) rootRefs.push([manifestValue.accessRoot, "access-root"]);
  if (manifestValue.metadataNameRoot) rootRefs.push([manifestValue.metadataNameRoot, "metadata-name-root"]);
  if (manifestValue.metadataSuggestionRoot) rootRefs.push([manifestValue.metadataSuggestionRoot, "metadata-suggestion-root"]);
  if (manifestValue.taxonomyRoot) rootRefs.push([manifestValue.taxonomyRoot, "taxonomy-root"]);
  for (const [ref, expected] of rootRefs) {
    const root = await getVerifiedJSON<unknown>(store, ref, PUBLIC_EPG_LIMITS.maxRootUncompressedBytes);
    if (!isRecord(root) || root.schemaVersion !== PUBLIC_EPG_SCHEMA_VERSION || root.kind !== expected
      || !Array.isArray(root.entries) || root.entries.length > 256) throw new Error("current_index_root_invalid");
    if (expected === "taxonomy-root" && !validPublicTaxonomyRoot(root)) throw new Error("current_index_root_invalid");
  }
  return { pointer: pointerValue, manifest: manifestValue, bytes: manifestBytes, pointerETag: storedPointer.etag };
}

export async function putImmutableRaw(store: ObjectStore, key: string, bytes: Uint8Array, metadata: ObjectMetadata): Promise<void> {
  const digest = sha256(bytes);
  const verification = { storedSha256: digest, storedBytes: bytes.byteLength, rawSha256: digest, rawBytes: bytes.byteLength };
  if (hasVerifiedArtifact(store, key, verification) || hasIdenticalCachedObject(store, key, bytes)
    || await hasIdenticalStoredObject(store, key, bytes)) {
    markVerifiedArtifact(store, key, verification);
    return;
  }
  try {
    await store.putConditional(key, bytes, metadata, { ifNoneMatch: "*" });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "r2_precondition_failed") throw error;
    const previous = await store.get(key, bytes.byteLength);
    if (!previous || previous.byteLength !== bytes.byteLength || sha256(previous) !== digest
      || previous.some((byte, index) => byte !== bytes[index])) {
      throw new Error("immutable_object_hash_mismatch");
    }
  }
  markVerifiedArtifact(store, key, verification);
}

async function validatePublishedReferences(
  store: ObjectStore,
  identityRoot: ArtifactRef,
  nameRoot: ArtifactRef,
  streamsRoot: ArtifactRef,
  accessRoot: ArtifactRef,
  taxonomyRoot: ArtifactRef,
  programmeRoot: ArtifactRef,
  sourceStatuses: readonly PublicEpgSourceStatus[],
  expectedProgrammeChannels: readonly PublicProgrammeChannel[] | undefined,
  metadataSuggestionRoot: ArtifactRef | undefined,
  renewLease: () => Promise<void>,
  limits: PublisherRunLimits,
  verifyDiscovery = true
): Promise<PublicProgrammeChannel[]> {
  const maxObjects = limits.maxR2GetRequests;
  const identityEntries = await readRoutedDirectory<PublicIdentityEntry>(
    store, identityRoot, "identity", maxObjects, limits.maxR2GetBytes
  );
  const programmeEntries = await readRoutedDirectory<PublicProgrammeChannel>(
    store, programmeRoot, "programme", maxObjects, limits.maxR2GetBytes
  );
  const statusByID = new Map(sourceStatuses.map((source) => [source.sourceID, source]));
  if (PUBLIC_EPG_SOURCE_IDS.some((sourceID) => !statusByID.has(sourceID))) {
    throw new Error("published_source_registry_incomplete");
  }
  const programmeKeys = new Set<string>();
  for (const entry of programmeEntries) {
    const value = entry.value;
    const source = statusByID.get(value.sourceID);
    const key = programmeIdentityKey(value);
    if (!validPublicProgrammeChannel(value)
      || entry.hash !== sha256(key)
      || programmeKeys.has(key)
      || !source || source.status === "unavailable"
      || source.sourceRevision !== value.sourceRevision
      || value.sourcePriority !== publicEpgSources.find((candidate) => candidate.id === value.sourceID)?.priority) {
      throw new Error("published_programme_index_invalid");
    }
    programmeKeys.add(key);
  }
  if (expectedProgrammeChannels) {
    const expected = [...expectedProgrammeChannels].sort((left, right) => programmeIdentityKey(left).localeCompare(programmeIdentityKey(right)));
    const actual = programmeEntries.map((entry) => entry.value).sort((left, right) => programmeIdentityKey(left).localeCompare(programmeIdentityKey(right)));
    if (stableJSON(actual) !== stableJSON(expected)) throw new Error("published_programme_graph_invalid");
  }
  const taxonomyRootValue = await getVerifiedJSON<unknown>(store, taxonomyRoot, PUBLIC_EPG_LIMITS.maxRootUncompressedBytes);
  if (!validPublicTaxonomyRoot(taxonomyRootValue)) throw new Error("published_taxonomy_root_invalid");
  const taxonomyEntries = await readRoutedDirectory<PublicTaxonomyPosting>(
    store, taxonomyRoot, "taxonomy", maxObjects, limits.maxR2GetBytes
  );
  const expectedTaxonomy = buildPublicTaxonomyIndex(identityEntries.map((entry) => entry.value));
  if (stableJSON(taxonomyRootValue.vocabulary) !== stableJSON(expectedTaxonomy.vocabulary)
    || taxonomyEntries.length !== expectedTaxonomy.postings.length) {
    throw new Error("published_taxonomy_graph_invalid");
  }
  const expectedByKey = new Map(expectedTaxonomy.postings.map((entry) => [
    `${entry.dimension}\u001f${entry.value}`, entry.memberKeys
  ]));
  for (let offset = 0; offset < taxonomyEntries.length; offset += 32) {
    await renewLease();
    const batch = taxonomyEntries.slice(offset, offset + 32);
    await mapBounded(batch, 8, async ({ hash, value }) => {
      const key = `${value.dimension}\u001f${value.value}`;
      const expectedMembers = expectedByKey.get(key);
      if (!expectedMembers || hash !== sha256(taxonomyDirectoryKey(value.dimension, value.value))) {
        throw new Error("published_taxonomy_posting_invalid");
      }
      const pages = await readTaxonomyPostingPages(store, value, value.pages.map((_, index) => index), limits.maxR2GetBytes);
      const actualMembers = pages.flatMap((page: PublicTaxonomyPage) => page.memberKeys);
      if (actualMembers.length !== expectedMembers.length
        || actualMembers.some((memberKey, index) => memberKey !== expectedMembers[index])) {
        throw new Error("published_taxonomy_graph_invalid");
      }
      expectedByKey.delete(key);
    });
  }
  if (expectedByKey.size !== 0) throw new Error("published_taxonomy_graph_invalid");
  if (verifyDiscovery) {
    await readRoutedDirectory<NameEntryRecord>(
      store, nameRoot, "name", maxObjects, limits.maxR2GetBytes
    );
    const streams = await readRoutedDirectory<PublicStreamsEntry>(
      store, streamsRoot, "streams", maxObjects, limits.maxR2GetBytes
    );
    const accessEntries = await readRoutedDirectory<PublicAccessEntry>(
      store, accessRoot, "access", maxObjects, limits.maxR2GetBytes
    );
    if (metadataSuggestionRoot) {
      const suggestions = await readRoutedDirectory<MetadataSuggestionBucketEntry>(
        store, metadataSuggestionRoot, "metadata-suggestion", maxObjects, limits.maxR2GetBytes
      );
      if (suggestions.some((entry) => !validMetadataSuggestionBucketEntry(entry.value)
        || entry.hash !== sha256(entry.value.term))) {
        throw new Error("published_metadata_suggestions_invalid");
      }
    }
    const streamKeys = new Set<string>();
    for (const entry of streams) {
      if (!validPublicStreamsEntry(entry.value)
        || entry.value.channelID !== entry.value.streams[0]?.providerChannelId
        || entry.hash !== sha256(identityKey(entry.value))) {
        throw new Error("published_streams_invalid");
      }
      const key = identityKey(entry.value);
      if (streamKeys.has(key)) throw new Error("published_streams_duplicate_identity");
      streamKeys.add(key);
    }
    if (!publicAccessGraphMatches(streams.map((entry) => entry.value), accessEntries)) {
      throw new Error("published_access_graph_invalid");
    }
  }
  const refs = new Map<string, ProgrammePartRef>();
  for (const entry of [...identityEntries.map((item) => item.value), ...programmeEntries.map((item) => item.value)]) {
    if (!isRecord(entry)) throw new Error("published_identity_invalid");
    const record = entry as Record<string, unknown>;
    const relations = Array.isArray(record.relations) ? record.relations : null;
    const daysCollections = Array.isArray(record.days) ? [record.days] : null;
    if (!relations && !daysCollections) throw new Error("published_identity_invalid");
    for (const relation of relations ?? []) {
      if (!isRecord(relation) || !Array.isArray(relation.days)) throw new Error("published_relation_invalid");
      for (const day of relation.days) {
        if (!isRecord(day) || !Array.isArray(day.parts)) throw new Error("published_day_invalid");
        for (const rawRef of day.parts) {
          if (!isRecord(rawRef)) throw new Error("published_xml_ref_invalid");
          const key = rawRef.key;
          const xmlSha256 = rawRef.xmlSha256;
          if (!validArtifactRef(rawRef) || !HEX.test(String(xmlSha256))
            || key !== PUBLIC_EPG_PREFIX + "objects/" + rawRef.sha256 + ".xml.gz") {
            throw new Error("published_xml_ref_invalid");
          }
          refs.set(String(key), rawRef as unknown as ProgrammePartRef);
        }
      }
    }
    for (const days of daysCollections ?? []) {
      for (const day of days) {
        if (!isRecord(day) || !Array.isArray(day.parts)) throw new Error("published_day_invalid");
        for (const rawRef of day.parts) {
          if (!isRecord(rawRef)) throw new Error("published_xml_ref_invalid");
          const key = rawRef.key;
          const xmlSha256 = rawRef.xmlSha256;
          if (!validArtifactRef(rawRef) || !HEX.test(String(xmlSha256))
            || key !== PUBLIC_EPG_PREFIX + "objects/" + rawRef.sha256 + ".xml.gz") {
            throw new Error("published_xml_ref_invalid");
          }
          refs.set(String(key), rawRef as unknown as ProgrammePartRef);
        }
      }
    }
  }
  const xmlRefs = [...refs.values()];
  for (let offset = 0; offset < xmlRefs.length; offset += 128) {
    await mapBounded(xmlRefs.slice(offset, offset + 128), 8, async (ref) => {
      const verification = {
        storedSha256: ref.sha256,
        storedBytes: ref.compressedBytes,
        rawSha256: ref.xmlSha256,
        rawBytes: ref.bytes
      };
      if (!hasVerifiedArtifact(store, ref.key, verification)) {
        const compressed = await store.get(ref.key, ref.compressedBytes);
        if (!compressed || compressed.byteLength !== ref.compressedBytes || sha256(compressed) !== ref.sha256) {
          throw new Error("published_xml_hash_invalid");
        }
        const xml = gunzip(compressed, PUBLIC_EPG_LIMITS.maxUncompressedShardBytes);
        if (xml.byteLength !== ref.bytes || sha256(xml) !== ref.xmlSha256) throw new Error("published_xml_content_invalid");
        markVerifiedArtifact(store, ref.key, verification);
      }
    });
    await renewLease();
  }
  await renewLease();
  return programmeEntries.map((entry) => entry.value);
}

function sameSourceStatuses(left: readonly PublicEpgSourceStatus[], right: readonly PublicEpgSourceStatus[]): boolean {
  return stableJSON(left) === stableJSON(right);
}

/** Build and read back the companion for one already verified programme graph. */
async function publishProgrammeNameCompanion(
  store: ObjectStore, programmeRoot: ArtifactRef, channels: readonly PublicProgrammeChannel[],
  limits: PublisherRunLimits
): Promise<PublicProgrammeNameDescriptor> {
  const sourceNameRecords = programmeNameRecords(channels);
  const sourceNamesRoot = await writeRoutedDirectory(store, "programme-names", sourceNameRecords);
  const validatedSourceNames = await readRoutedDirectory<PublicProgrammeNamePosting>(
    store, sourceNamesRoot, "programme-names", limits.maxR2GetRequests, limits.maxR2GetBytes
  );
  const expectedSourceNames = sourceNameRecords.map(({ hash, value }) => ({ hash, value }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
  const actualSourceNames = validatedSourceNames.map(({ hash, value }) => ({ hash, value }));
  if (stableJSON(actualSourceNames) !== stableJSON(expectedSourceNames)
    || validatedSourceNames.some(({ hash, value }) => !validPublicProgrammeNamePosting(value) || hash !== sha256(value.term))) {
    throw new Error("published_programme_name_graph_invalid");
  }
  const sourceNameDescriptor: PublicProgrammeNameDescriptor = {
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    programmeRootSHA256: programmeRoot.sha256,
    root: sourceNamesRoot
  };
  const sourceNameDescriptorBytes = jsonBytes(sourceNameDescriptor);
  if (!validPublicProgrammeNameDescriptor(sourceNameDescriptor)
    || sourceNameDescriptorBytes.byteLength > PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes) {
    throw new Error("published_programme_name_descriptor_invalid");
  }
  const sourceNameDescriptorKey = publicProgrammeNameDescriptorKey(programmeRoot.sha256);
  await putImmutableRaw(store, sourceNameDescriptorKey, sourceNameDescriptorBytes, {
    contentType: "application/json", cacheControl: "public, max-age=31536000, immutable"
  });
  const storedSourceNameDescriptorBytes = await store.get(
    sourceNameDescriptorKey, PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes
  );
  let storedSourceNameDescriptor: unknown;
  try {
    storedSourceNameDescriptor = storedSourceNameDescriptorBytes
      ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(storedSourceNameDescriptorBytes)) as unknown
      : null;
  } catch { storedSourceNameDescriptor = null; }
  if (!storedSourceNameDescriptorBytes
    || storedSourceNameDescriptorBytes.byteLength !== sourceNameDescriptorBytes.byteLength
    || sha256(storedSourceNameDescriptorBytes) !== sha256(sourceNameDescriptorBytes)
    || !validPublicProgrammeNameDescriptor(storedSourceNameDescriptor)
    || storedSourceNameDescriptor.programmeRootSHA256 !== programmeRoot.sha256
    || stableJSON(storedSourceNameDescriptor) !== stableJSON(sourceNameDescriptor)) {
    throw new Error("published_programme_name_descriptor_invalid");
  }
  return sourceNameDescriptor;
}

/** Repair an existing publication without upstream downloads, pointer/state writes or retention. */
export async function backfillProgrammeNameCompanion(options: {
  store: RetentionObjectStore;
  leaseClock?: () => number;
  budgets?: Partial<PublisherRunLimits>;
  onProgress?: (progress: PublisherProgress) => void;
}): Promise<{ programmeRootSHA256: string; channelCount: number; usage: PublisherUsage }> {
  const limits = { ...PUBLISHER_RUN_LIMITS, ...options.budgets };
  const store = new BudgetedObjectStore(options.store, limits, options.onProgress);
  const clock = options.leaseClock ?? Date.now;
  const lease = await PublishLease.acquire(store, clock());
  let renewedAt = clock();
  let renewal: Promise<void> | null = null;
  // Renew from existing I/O, without a timer or overlapping lease CAS calls.
  const fencedStore = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (!["get", "getWithETag", "put", "putConditional"].includes(String(key))) return value.bind(target);
      return async (...args: unknown[]) => {
        if (renewal || clock() - renewedAt >= 5 * 60 * 1000) {
          renewal ??= lease.renew(store, clock()).then(() => { renewedAt = clock(); })
            .finally(() => { renewal = null; });
          await renewal;
        }
        return Reflect.apply(value, target, args);
      };
    }
  });
  try {
    const current = await loadCurrent(fencedStore);
    if (!current?.manifest.programmeRoot) throw new Error("published_programme_root_missing");
    const root = current.manifest.programmeRoot;
    const records = await readRoutedDirectory<PublicProgrammeChannel>(
      fencedStore, root, "programme", limits.maxR2GetRequests, limits.maxR2GetBytes
    );
    const revisions = new Map(current.manifest.sources.map((source) => [source.sourceID, source.sourceRevision]));
    if (records.some(({ value }) => !validPublicProgrammeChannel(value)
      || revisions.get(value.sourceID) !== value.sourceRevision)) {
      throw new Error("published_programme_source_revision_invalid");
    }
    await lease.renew(store, clock());
    await publishProgrammeNameCompanion(fencedStore, root, records.map(({ value }) => value), limits);
    await lease.renew(store, clock());
    const after = await loadCurrent(fencedStore);
    if (!after || after.pointerETag !== current.pointerETag
      || stableJSON(after.pointer) !== stableJSON(current.pointer)) throw new Error("publisher_pointer_changed");
    return { programmeRootSHA256: root.sha256, channelCount: records.length, usage: { ...store.usage } };
  } finally {
    await lease.release(store, clock());
  }
}

export async function runPublisher(options: {
  store: RetentionObjectStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  leaseClock?: () => number;
  budgets?: Partial<PublisherRunLimits>;
  onProgress?: (progress: PublisherProgress) => void;
}): Promise<PublisherSummary> {
  const started = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const runLimits = { ...PUBLISHER_RUN_LIMITS, ...options.budgets };
  const usageStore = new BudgetedObjectStore(options.store, runLimits, options.onProgress);
  usageStore.report("publisher", { limits: runLimits });
  const leaseClock = options.leaseClock ?? Date.now;
  const lease = await PublishLease.acquire(usageStore, leaseClock());
  let released = false;
  try {
  const renewLease = () => lease.renew(usageStore, leaseClock());
  const current = await loadCurrent(usageStore);
  const loadedState = await readPublisherState(usageStore);
  const state = loadedState.value;

  await assertStorageHeadroom(usageStore, runLimits.maxR2PutBytes, renewLease);
  const metadataResults = [] as Array<{ sourceID: string; result: MetadataResult }>;
  for (const source of publicMetadataSources) {
    await renewLease();
    const result = await loadMetadata(usageStore, source, state.metadata[source.id], fetchImpl, now, usageStore);
    metadataResults.push({ sourceID: source.id, result });
  }
  const staleMetadata = metadataResults.some(({ result }) => result.freshness !== "ready");
  let metadataStates: Record<string, CachedMetadata>;
  let metadataValues: unknown[];
  let metadataFreshness: Record<string, "ready" | "stale">;
  if (staleMetadata && publicMetadataSources.every((source) => state.metadata[source.id])) {
    // Do not combine a new channel catalogue with stale Feed metadata.
    metadataStates = Object.fromEntries(publicMetadataSources.map((source) => [source.id, state.metadata[source.id]!]));
    metadataValues = await Promise.all(publicMetadataSources.map((source) => getMetadataValue(usageStore, metadataStates[source.id]!.bodyRef)));
    metadataFreshness = Object.fromEntries(publicMetadataSources.map((source) => [source.id, "stale"]));
  } else {
    if (staleMetadata) throw new Error("metadata_lkg_unavailable");
    metadataStates = Object.fromEntries(metadataResults.map(({ sourceID, result }) => [sourceID, result.state]));
    metadataValues = metadataResults.map(({ result }) => result.value);
    metadataFreshness = Object.fromEntries(metadataResults.map(({ sourceID, result }) => [sourceID, result.freshness]));
  }
  const [channelsValue, feedsValue, categoriesValue, streamsValue] = metadataValues;
  let logosValue: unknown = [];
  try {
    const result = await loadMetadata(usageStore, publicLogoMetadataSource,
      state.metadata[publicLogoMetadataSource.id], fetchImpl, now, usageStore);
    if (!Array.isArray(result.value) || result.value.length > 300_000) throw new Error("optional_logos_invalid");
    logosValue = result.value;
    metadataStates[publicLogoMetadataSource.id] = result.state;
    metadataFreshness[publicLogoMetadataSource.id] = result.freshness;
    metadataResults.push({ sourceID: publicLogoMetadataSource.id, result });
  } catch {
    const previous = state.metadata[publicLogoMetadataSource.id];
    if (previous) {
      try {
        logosValue = await getMetadataValue(usageStore, previous.bodyRef);
        metadataStates[publicLogoMetadataSource.id] = previous;
        metadataFreshness[publicLogoMetadataSource.id] = "stale";
      } catch { /* Optional Logos never erase or block an EPG publication. */ }
    }
  }
  const seeds = buildChannelSeeds(channelsValue, feedsValue, categoriesValue, logosValue);
  const publicStreams = buildPublicStreams(streamsValue, seeds);
  const publicAccess = buildPublicAccessIndex(publicStreams.entries);
  let wikidataCandidates: PublicMetadataSuggestionCandidate[] | null = null;
  try {
    wikidataCandidates = await fetchWikidataSuggestions(fetchImpl, {
      onRequest: () => usageStore.recordHTTPRequest(),
      onBytes: (bytes) => usageStore.recordHTTPBytes(bytes)
    });
  } catch (error) {
    // Wikidata is an optional suggestion source. A fixed-source outage or
    // malformed result preserves the prior suggestion index and never blocks
    // public channel/EPG publication. Global publisher budget/storage errors
    // still fail the run.
    if (isBudgetError(error) || storageError(error)) throw error;
  }
  const metadataChanged = ["iptv-org:channels", "iptv-org:feeds"].some((sourceID) =>
    metadataStates[sourceID]?.sourceRevision !== state.metadata[sourceID]?.sourceRevision
  );
  const sourceIndexFormatChanged = Object.keys(state.sources).length > 0
    && state.indexInputDigest === indexInputDigest(state.metadata, state.sources, INDEX_GENERATOR_VERSION - 1);
  const rebuildSourceIndexes = metadataChanged || sourceIndexFormatChanged;

  const sourceIndexesByID = new Map<string, GeneratedSourceIndex>();
  const newSourceStates: Record<string, CachedSource> = {};
  const sourceFreshness = new Map<string, "ready" | "stale" | "unavailable">();
  let parsedSources = 0;
  let reusedSources = 0;
    for (let offset = 0; offset < publicEpgSources.length; offset += PUBLIC_EPG_LIMITS.maxSourceConcurrency) {
    await renewLease();
    const batch = publicEpgSources.slice(offset, offset + PUBLIC_EPG_LIMITS.maxSourceConcurrency);
    const settled = await Promise.allSettled(batch.map(async (source) => ({
      source,
      result: await processSource(
        usageStore,
        source,
        state.sources[source.id],
        seeds,
        rebuildSourceIndexes,
        fetchImpl,
        now,
        usageStore,
        (programmesParsed) => usageStore.report("sources", { programmesParsedInSource: programmesParsed })
      )
    })));
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed) throw failed.reason;
    const results = settled.map((item) => (item as PromiseFulfilledResult<{
      source: (typeof publicEpgSources)[number];
      result: Awaited<ReturnType<typeof processSource>>;
    }>).value);
      for (const { source, result } of results) {
      sourceFreshness.set(source.id, result.freshness);
      if (result.state) newSourceStates[source.id] = result.state;
      if (result.index) sourceIndexesByID.set(source.id, result.index);
      if (result.parsed) parsedSources += 1;
      else if (result.state) reusedSources += 1;
      }
      usageStore.report("sources", { sourcesCompleted: Math.min(offset + batch.length, publicEpgSources.length), sourceTotal: publicEpgSources.length });
    }
  if (current && publicEpgSources.some((source) => sourceFreshness.get(source.id) === "unavailable")) {
    throw new Error("publisher_state_missing_source_lkg");
  }
  const inputDigest = indexInputDigest(metadataStates, newSourceStates);
  const metadataNameDigest = metadataNameInputDigest(metadataStates);
  const taxonomyDigest = taxonomyInputDigest(metadataStates);
  const reuseExistingRoots = !!current && current.manifest.indexInputDigest === inputDigest
    && state.indexInputDigest === inputDigest && state.metadataNameInputDigest === metadataNameDigest
    && state.taxonomyInputDigest === taxonomyDigest
    && validIndexStats(state.indexStats) && hasAccessIndexStats(state.indexStats) && hasTaxonomyIndexStats(state.indexStats)
    && !!current.manifest.streamsRoot && !!current.manifest.accessRoot && !!current.manifest.metadataNameRoot
    && !!current.manifest.taxonomyRoot && current.manifest.schemaVersion === PUBLIC_EPG_MANIFEST_VERSION
    && !!current.manifest.programmeRoot;
  const reuseDiscoveryRoots = !!current?.manifest.streamsRoot && !!current.manifest.accessRoot
    && validIndexStats(state.indexStats) && hasAccessIndexStats(state.indexStats)
    && current.manifest.indexInputDigest === state.indexInputDigest
    && state.indexInputDigest === indexInputDigest(state.metadata, state.sources)
    && publicMetadataSources.every((source) => metadataStates[source.id]?.sourceRevision === state.metadata[source.id]?.sourceRevision);
  const canReuseMetadataNameRoot = !!current?.manifest.metadataNameRoot
    && current.manifest.indexInputDigest === state.indexInputDigest
    && state.metadataNameInputDigest === metadataNameInputDigest(state.metadata)
    && state.metadataNameInputDigest === metadataNameDigest;
  const canReuseTaxonomyRoot = !!current?.manifest.taxonomyRoot
    && hasTaxonomyIndexStats(state.indexStats)
    && current.manifest.indexInputDigest === state.indexInputDigest
    && state.taxonomyInputDigest === taxonomyInputDigest(state.metadata)
    && state.taxonomyInputDigest === taxonomyDigest;
  const sourceIndexes: GeneratedSourceIndex[] = [];
  if (!reuseExistingRoots) {
    for (const source of publicEpgSources) {
      const sourceState = newSourceStates[source.id];
      if (!sourceState) continue;
      let sourceIndex = sourceIndexesByID.get(source.id);
      if (!sourceIndex) sourceIndex = await loadSourceIndex(usageStore, source, sourceState);
      sourceIndexes.push(sourceIndex);
    }
    if (!sourceIndexes.length) throw new Error("no_usable_epg_sources");
  }

  const playableSeeds = seeds.filter((seed) => publicStreams.playableIdentityKeys.has(identityKey(seed.identity)));
  let identityRoot: ArtifactRef;
  let nameRoot: ArtifactRef;
  let streamsRoot: ArtifactRef;
  let accessRoot: ArtifactRef;
  let taxonomyRoot: ArtifactRef;
  let metadataNameRoot: ArtifactRef;
  let programmeRoot: ArtifactRef;
  let metadataSuggestionRoot: ArtifactRef | undefined = current?.manifest.metadataSuggestionRoot;
  let metadataSuggestionEntries: MetadataSuggestionBucketEntry[] | null = null;
  let wikidataSuggestionStatus: "ready" | "stale" | "unavailable" = "unavailable";
  const shouldBuildMetadataSuggestions = wikidataCandidates !== null || metadataSuggestionRoot === undefined;
  if (shouldBuildMetadataSuggestions) {
    try {
      const iptvEntries = buildMetadataNameSuggestionIndex(seeds);
      let wikidataEntries: MetadataSuggestionBucketEntry[] = [];
      let wikidataProjectionFailed = false;
      if (wikidataCandidates) {
        try {
          wikidataEntries = buildWikidataSuggestionIndex(wikidataCandidates);
          wikidataSuggestionStatus = "ready";
        } catch {
          // Reject an over-budget optional source as a whole; do not truncate it.
          wikidataProjectionFailed = true;
          wikidataSuggestionStatus = "unavailable";
        }
      }
      if (wikidataProjectionFailed && current?.manifest.metadataSuggestionRoot) {
        // Preserve the complete previous cross-source index instead of
        // silently rebuilding a partial one from only one source.
        metadataSuggestionEntries = null;
        metadataSuggestionRoot = current.manifest.metadataSuggestionRoot;
      } else {
        metadataSuggestionEntries = mergeMetadataSuggestionIndexes(iptvEntries, wikidataEntries);
        if (metadataSuggestionEntries.length > 0) {
          metadataSuggestionRoot = await writeRoutedDirectory(
            usageStore, "metadata-suggestion", metadataSuggestionRecords(metadataSuggestionEntries)
          );
        } else {
          metadataSuggestionRoot = undefined;
        }
      }
    } catch (error) {
      if (isBudgetError(error) || storageError(error)) throw error;
      // The suggestion index is optional, so an invalid local projection is
      // omitted and cannot replace the existing exact/EPG roots.
      metadataSuggestionEntries = null;
      metadataSuggestionRoot = current?.manifest.metadataSuggestionRoot;
      wikidataSuggestionStatus = "unavailable";
    }
  } else {
    wikidataSuggestionStatus = metadataSuggestionRoot ? "stale" : "unavailable";
  }
  if (wikidataCandidates === null && current?.manifest.metadataSuggestionRoot) wikidataSuggestionStatus = "stale";
  let indexStats: PublisherIndexStats;
  if (reuseExistingRoots && current?.manifest.streamsRoot && current.manifest.accessRoot
    && current.manifest.metadataNameRoot && current.manifest.taxonomyRoot && current.manifest.programmeRoot && state.indexStats) {
    identityRoot = current.manifest.identityRoot;
    nameRoot = current.manifest.nameRoot;
    streamsRoot = current.manifest.streamsRoot;
    accessRoot = current.manifest.accessRoot;
    taxonomyRoot = current.manifest.taxonomyRoot;
    metadataNameRoot = current.manifest.metadataNameRoot;
    programmeRoot = current.manifest.programmeRoot;
    indexStats = state.indexStats;
  } else {
    const relationships = combineSourceIndexes(seeds, sourceIndexes);
    const identityEntries = seeds.map((seed) => mergeIdentityEntry(seed, relationships.get(identityKey(seed.identity)) ?? []));
    const nameEntries = reuseDiscoveryRoots ? null : buildNameIndex(playableSeeds);
    const metadataNameEntries = canReuseMetadataNameRoot ? null : buildMetadataNameIndex(seeds);
    const taxonomyIndex = canReuseTaxonomyRoot ? null : buildPublicTaxonomyIndex(identityEntries);
    if (metadataNameEntries) validateMetadataNameEntries(metadataNameEntries,
      (metadataNameValidation) => usageStore.report("validation", { metadataNameValidation }));
    identityRoot = await writeRoutedDirectory(usageStore, "identity", identityRecords(identityEntries));
    const programmeChannels = sourceIndexes.flatMap((index) => index.entries);
    programmeRoot = await writeRoutedDirectory(usageStore, "programme", programmeRecords(programmeChannels));
    if (reuseDiscoveryRoots && current?.manifest.streamsRoot && current.manifest.accessRoot) {
      nameRoot = current.manifest.nameRoot;
      streamsRoot = current.manifest.streamsRoot;
      accessRoot = current.manifest.accessRoot;
    } else {
      nameRoot = await writeRoutedDirectory(usageStore, "name", nameRecords(nameEntries!));
      streamsRoot = await writeRoutedDirectory(usageStore, "streams", streamsRecords(publicStreams.entries));
      accessRoot = await writeRoutedDirectory(usageStore, "access", accessRecords(publicAccess.entries));
    }
    metadataNameRoot = canReuseMetadataNameRoot
      ? current!.manifest.metadataNameRoot!
      : await writeRoutedDirectory(usageStore, "metadata-name", nameRecords(metadataNameEntries!));
    const taxonomyWrite = taxonomyIndex
      ? await writeTaxonomyDirectory(usageStore, taxonomyIndex.postings, taxonomyIndex.vocabulary)
      : null;
    taxonomyRoot = canReuseTaxonomyRoot
      ? current!.manifest.taxonomyRoot!
      : taxonomyWrite!.root;
    indexStats = {
      programmeCount: sourceIndexes.reduce((sum, index) => sum + index.programmeCount, 0),
      shardCount: sourceIndexes.reduce((sum, index) => sum + index.shardCount, 0),
      channelCount: seeds.length,
      nameTermCount: nameEntries?.length ?? state.indexStats!.nameTermCount,
      metadataNameTermCount: metadataNameEntries?.length ?? state.indexStats?.metadataNameTermCount ?? 0,
      accessDigestCount: publicAccess.accessDigestCount,
      accessMemberCount: publicAccess.accessMemberCount,
      accessAmbiguousCount: publicAccess.accessAmbiguousCount,
      taxonomyPostingCount: taxonomyIndex?.postingCount ?? state.indexStats!.taxonomyPostingCount!,
      taxonomyMemberCount: taxonomyIndex?.memberCount ?? state.indexStats!.taxonomyMemberCount!,
      taxonomyPageCount: taxonomyWrite?.pageCount ?? state.indexStats!.taxonomyPageCount!
    };
  }
  const statuses: PublicEpgSourceStatus[] = [
    ...[...publicMetadataSources, ...(metadataStates[publicLogoMetadataSource.id] ? [publicLogoMetadataSource] : [])]
      .map((source) => metadataStatus(source.id, metadataStates[source.id]!, metadataFreshness[source.id]!)),
    ...publicEpgSources.map((source) => sourceStatus(source.id, newSourceStates[source.id], sourceFreshness.get(source.id) ?? "unavailable"))
  ].sort((left, right) => left.sourceID.localeCompare(right.sourceID));
  const expectedProgrammeChannels = reuseExistingRoots ? undefined : sourceIndexes.flatMap((index) => index.entries);
  const publishedProgrammeChannels = await validatePublishedReferences(
    usageStore, identityRoot, nameRoot, streamsRoot, accessRoot, taxonomyRoot, programmeRoot,
    statuses, expectedProgrammeChannels, metadataSuggestionRoot,
    renewLease, runLimits, !reuseDiscoveryRoots
  );
  await renewLease();
  await publishProgrammeNameCompanion(usageStore, programmeRoot, publishedProgrammeChannels, runLimits);
  await renewLease();
  if (reuseExistingRoots && metadataSuggestionEntries && metadataSuggestionRoot) {
    const publishedSuggestions = await readRoutedDirectory<MetadataSuggestionBucketEntry>(
      usageStore, metadataSuggestionRoot, "metadata-suggestion", runLimits.maxR2GetRequests, runLimits.maxR2GetBytes
    );
    if (publishedSuggestions.some((entry) => !validMetadataSuggestionBucketEntry(entry.value)
      || entry.hash !== sha256(entry.value.term))) {
      throw new Error("published_metadata_suggestions_invalid");
    }
  }
  const metadataRevision = channelMetadataRevision(seeds, metadataNameRoot, metadataSuggestionRoot,
    CHANNEL_METADATA_GENERATOR_VERSION, taxonomyRoot);
  const logicalInputs = {
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    manifestVersion: PUBLIC_EPG_MANIFEST_VERSION,
    taxonomyIndexVersion: PUBLIC_TAXONOMY_INDEX_VERSION,
    indexInputDigest: inputDigest,
    metadata: [...publicMetadataSources, ...(metadataStates[publicLogoMetadataSource.id] ? [publicLogoMetadataSource] : [])]
      .map((source) => [source.id, metadataStates[source.id]!.sourceRevision]),
    sources: publicEpgSources.map((source) => [
      source.id,
      newSourceStates[source.id]?.sourceRevision ?? null,
      newSourceStates[source.id]?.indexRef.sha256 ?? null
    ]),
    identityRoot: identityRoot.sha256,
    programmeRoot: programmeRoot.sha256,
    nameRoot: nameRoot.sha256,
    streamsRoot: streamsRoot.sha256,
    accessRoot: accessRoot.sha256,
    taxonomyRoot: taxonomyRoot.sha256,
    metadataNameRoot: metadataNameRoot.sha256,
    metadataSuggestionRoot: metadataSuggestionRoot?.sha256 ?? null,
    channelMetadataRevision: metadataRevision
  };
  const revision = sha256(stableJSON(logicalInputs));
  const rootSame = current
    && current.manifest.identityRoot.sha256 === identityRoot.sha256
    && current.manifest.programmeRoot?.sha256 === programmeRoot.sha256
    && current.manifest.nameRoot.sha256 === nameRoot.sha256
    && current.manifest.streamsRoot?.sha256 === streamsRoot.sha256
    && current.manifest.accessRoot?.sha256 === accessRoot.sha256
    && current.manifest.taxonomyRoot?.sha256 === taxonomyRoot.sha256
    && current.manifest.metadataNameRoot?.sha256 === metadataNameRoot.sha256
    && current.manifest.metadataSuggestionRoot?.sha256 === metadataSuggestionRoot?.sha256;
  const revisionSame = current?.manifest.revision === revision;
  const statusSame = !!current && sameSourceStatuses(current.manifest.sources, statuses);
  const generatedAt = revisionSame && statusSame && rootSame ? current!.manifest.generatedAt : now;
  const manifest: PublicEpgManifest = {
    schemaVersion: PUBLIC_EPG_MANIFEST_VERSION,
    revision,
    channelMetadataRevision: metadataRevision,
    generatedAt,
    previousRevision: current
      ? revision === current.manifest.revision ? current.manifest.previousRevision : current.manifest.revision
      : null,
    sources: statuses,
    indexInputDigest: inputDigest,
    identityRoot,
    programmeRoot,
    nameRoot,
    streamsRoot,
    accessRoot,
    metadataNameRoot,
    taxonomyRoot,
    ...(metadataSuggestionRoot ? { metadataSuggestionRoot } : {})
  };
  const manifestBytes = jsonBytes(manifest);
  if (!validManifest(manifest) || manifestBytes.byteLength > 32 * 1024 || statuses.length > 32) throw new Error("manifest_budget_exceeded");
  const manifestSha256 = sha256(manifestBytes);
  const manifestKey = PUBLIC_EPG_PREFIX + "manifests/" + manifestSha256 + ".json";
  await putImmutableRaw(usageStore, manifestKey, manifestBytes, {
    contentType: "application/json",
    cacheControl: "public, max-age=31536000, immutable"
  });
  const pointer: CurrentPointer = { schemaVersion: 1, revision, manifestKey, manifestSha256 };
  const pointerBytes = jsonBytes(pointer);
  const published = !current || sha256(current.bytes) !== manifestSha256;

  const currentStateSnapshot: PublisherStateSnapshot = {
    metadata: metadataStates,
    sources: newSourceStates,
    indexInputDigest: inputDigest,
    metadataNameInputDigest: metadataNameDigest,
    taxonomyInputDigest: taxonomyDigest,
    indexStats
  };
  const priorStateSnapshot: PublisherStateSnapshot = {
    metadata: state.metadata,
    sources: state.sources,
    ...(state.indexInputDigest ? { indexInputDigest: state.indexInputDigest } : {}),
    ...(state.metadataNameInputDigest ? { metadataNameInputDigest: state.metadataNameInputDigest } : {}),
    ...(state.taxonomyInputDigest ? { taxonomyInputDigest: state.taxonomyInputDigest } : {}),
    ...(state.indexStats ? { indexStats: state.indexStats } : {})
  };
  const priorSnapshotHasData = Object.keys(priorStateSnapshot.metadata).length > 0 || Object.keys(priorStateSnapshot.sources).length > 0;
  const priorStateChanged = stableJSON(priorStateSnapshot) !== stableJSON(currentStateSnapshot);
  const previousStates = priorStateChanged && priorSnapshotHasData
    ? [priorStateSnapshot]
    : state.previousStates ?? [];
  const previousPointers = published
    ? (current ? [current.pointer] : [])
    : (state.previousPointers ?? []);
  const retentionDue = published || state.lastRetentionAt === undefined
    || leaseClock() - state.lastRetentionAt >= RETENTION_INTERVAL_MS;
  const nextState: PublisherState = {
    schemaVersion: 1,
    metadata: metadataStates,
    sources: newSourceStates,
    previousStates,
    previousPointers,
    indexInputDigest: inputDigest,
    metadataNameInputDigest: metadataNameDigest,
    taxonomyInputDigest: taxonomyDigest,
    indexStats,
    ...(state.lastRetentionAt !== undefined ? { lastRetentionAt: state.lastRetentionAt } : {})
  };
  let committedStateETag = loadedState.etag;
  if (stableJSON(state) !== stableJSON(nextState)) {
    await renewLease();
    try {
      committedStateETag = await usageStore.putConditional(PUBLIC_EPG_PUBLISHER_STATE_KEY, jsonBytes(nextState), {
        contentType: "application/json", cacheControl: "private, no-store"
      }, loadedState.etag ? { ifMatch: loadedState.etag } : { ifNoneMatch: "*" });
    } catch (error) {
      if (error instanceof Error && error.message === "r2_precondition_failed") throw new Error("publisher_state_conflict");
      throw error;
    }
  }
  if (published) {
    await renewLease();
    try {
      await usageStore.putConditional(PUBLIC_EPG_CURRENT_KEY, pointerBytes, {
        contentType: "application/json", cacheControl: "no-cache"
      }, current ? { ifMatch: current.pointerETag } : { ifNoneMatch: "*" });
    } catch (error) {
      if (error instanceof Error && error.message === "r2_precondition_failed") throw new Error("publisher_pointer_conflict");
      throw error;
    }
  }

  const committedPointer = published ? pointer : current?.pointer ?? pointer;
  const retainedPointers = [committedPointer, ...(nextState.previousPointers ?? [])]
    .filter((candidate, index, all) => all.findIndex((item) => item.manifestKey === candidate.manifestKey) === index)
    .slice(0, 2);
  const retainedStates: unknown[] = [nextState, ...(nextState.previousStates ?? [])].slice(0, 2);
  const retention = retentionDue
    ? await runRetention(usageStore, { pointers: retainedPointers, states: retainedStates }, renewLease, leaseClock())
    : null;
  if (retention) {
    if (!committedStateETag) throw new Error("publisher_retention_state_missing");
    const completedState: PublisherState = { ...nextState, lastRetentionAt: leaseClock() };
    await renewLease();
    try {
      await usageStore.putConditional(PUBLIC_EPG_PUBLISHER_STATE_KEY, jsonBytes(completedState), {
        contentType: "application/json", cacheControl: "private, no-store"
      }, { ifMatch: committedStateETag });
    } catch (error) {
      if (error instanceof Error && error.message === "r2_precondition_failed") throw new Error("publisher_state_conflict");
      throw error;
    }
  }

  await lease.release(usageStore, leaseClock());
  released = true;
  return {
    revision,
    published,
    metadataCount: metadataResults.length,
    sourceCount: publicEpgSources.length,
    staleSources: statuses.filter((item) => item.status === "stale").length,
    unavailableSources: statuses.filter((item) => item.status === "unavailable").length,
    parsedSources,
    reusedSources,
    channelCount: indexStats.channelCount,
    nameTermCount: indexStats.nameTermCount,
    metadataNameTermCount: indexStats.metadataNameTermCount ?? 0,
    accessDigestCount: indexStats.accessDigestCount ?? 0,
    accessMemberCount: indexStats.accessMemberCount ?? 0,
    accessAmbiguousCount: indexStats.accessAmbiguousCount ?? 0,
    taxonomyPostingCount: indexStats.taxonomyPostingCount ?? 0,
    taxonomyMemberCount: indexStats.taxonomyMemberCount ?? 0,
    taxonomyPageCount: indexStats.taxonomyPageCount ?? 0,
    metadataSuggestionTermCount: metadataSuggestionEntries?.length ?? 0,
    wikidataSuggestionStatus,
    sourceProgrammeChannelCount: sourceIndexes.reduce((sum, index) => sum + index.entries.length, 0),
    externallyLinkedProgrammeChannelCount: sourceIndexes.reduce((sum, index) =>
      sum + index.entries.filter((entry) => entry.externalIdentity !== undefined).length, 0),
    externallyUnconfirmedProgrammeChannelCount: sourceIndexes.reduce((sum, index) =>
      sum + index.entries.filter((entry) => entry.externalIdentity === undefined).length, 0),
    programmeCount: indexStats.programmeCount,
    shardCount: indexStats.shardCount,
    elapsedMs: Date.now() - started,
    httpRequests: usageStore.usage.httpRequests,
    httpBytes: usageStore.usage.httpBytes,
    r2GetRequests: usageStore.usage.r2Gets,
    r2GetBytes: usageStore.usage.r2GetBytes,
    r2PutRequests: usageStore.usage.r2Puts,
    r2PutBytes: usageStore.usage.r2PutBytes,
    r2ListRequests: usageStore.usage.r2Lists,
    r2DeleteRequests: usageStore.usage.r2DeleteRequests,
    r2DeleteObjects: usageStore.usage.r2DeleteObjects,
    retentionObjects: retention?.objects ?? 0,
    retentionNamespaceBytes: retention?.namespaceBytes ?? null,
    retentionStorageBudgetExceeded: retention?.storageBudgetExceeded ?? null,
    retentionRan: retention !== null
  };
  } finally {
    if (!released) await lease.release(usageStore, leaseClock());
  }
}
