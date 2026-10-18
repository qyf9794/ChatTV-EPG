import {
  PUBLIC_EPG_LIMITS,
  PUBLIC_EPG_SCHEMA_VERSION,
  identityKey,
  taxonomyDirectoryKey,
  validPublicTaxonomyPage,
  validPublicTaxonomyPosting,
  validPublicTaxonomyRoot,
  validPublicProgrammeNamePosting,
  validPublicAccessEntry,
  validPublicProgrammeChannel,
  normalizePublicProgrammeName,
  programmeIdentityKey,
  validMetadataSuggestionBucketEntry,
  type ArtifactRef,
  type DirectoryChild,
  type DirectoryRoot,
  type PublicIdentityEntry,
  type PublicAccessEntry,
  type PublicTaxonomyPage,
  type PublicTaxonomyPosting,
  type PublicTaxonomyVocabulary,
  type PublicProgrammeNamePosting,
  type PublicProgrammeChannel,
  type MetadataSuggestionBucketEntry,
  type PublicStreamsEntry
} from "@vocaltv/public-epg-contract";
import { getVerifiedJSON, jsonBytes, putImmutable, sha256, type ObjectStore } from "./encoding.js";
import { mapBounded } from "./bounded.js";
import type { NameEntryRecord } from "./identity.js";
import type { PublicTaxonomyPostingSeed } from "./streams.js";

export type DirectoryKind = "identity" | "name" | "metadata-name" | "metadata-suggestion" | "source" | "streams" | "access" | "taxonomy" | "programme" | "programme-names";
export type HashedRecord<T> = { hash: string; value: T };

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function rootKind(kind: DirectoryKind): DirectoryRoot["kind"] { return `${kind}-root` as DirectoryRoot["kind"]; }
function nodeKind(kind: DirectoryKind): string { return `${kind}-node`; }
function bucketKind(kind: DirectoryKind): string { return `${kind}-bucket`; }

function gzipSize(ref: ArtifactRef): number { return ref.compressedBytes; }

// Small roots avoid decoding all 256 routes in a cold Worker isolate. Name
// leaves have a tighter target because discovery needs only one short posting.
function leafTarget(kind: DirectoryKind): number {
  return kind === "name" || kind === "metadata-name" || kind === "metadata-suggestion" || kind === "programme-names"
    ? 8 * 1024 : 32 * 1024;
}

async function writeNodeOrBucket<T>(
  store: ObjectStore,
  kind: DirectoryKind,
  prefix: string,
  records: HashedRecord<T>[]
): Promise<ArtifactRef> {
  const payload: unknown = {
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    kind: bucketKind(kind),
    prefix,
    entries: records.map((item) => item.value)
  };
  const raw = jsonBytes(payload);
  const target = leafTarget(kind);
  const maxSingleBucketBytes = kind === "taxonomy"
    ? PUBLIC_EPG_LIMITS.maxTaxonomyPostingBytes : PUBLIC_EPG_LIMITS.maxIndexNodeUncompressedBytes;
  if (raw.byteLength <= target || records.length === 1 && raw.byteLength <= maxSingleBucketBytes) return putImmutable(store, "json", raw);
  if (prefix.length >= 64) throw new Error("index_partition_unbounded");
  const groups = new Map<string, HashedRecord<T>[]>();
  for (const record of records) {
    const childPrefix = record.hash.slice(0, prefix.length + 1);
    const group = groups.get(childPrefix) ?? [];
    group.push(record);
    groups.set(childPrefix, group);
  }
  const entries: DirectoryChild[] = [];
  let pageRecords: HashedRecord<T>[] = [];
  let pagePrefixes: string[] = [];
  const flushPage = async (): Promise<void> => {
    if (!pageRecords.length) return;
    const bucketPrefix = pagePrefixes.length === 1 ? pagePrefixes[0]! : prefix;
    const pageBytes = jsonBytes({
      schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
      kind: bucketKind(kind),
      prefix: bucketPrefix,
      entries: pageRecords.map((item) => item.value)
    });
    if (pageBytes.byteLength > maxSingleBucketBytes) throw new Error("index_bucket_size_exceeded");
    const ref = await putImmutable(store, "json", pageBytes);
    for (const childPrefix of pagePrefixes) entries.push({ prefix: childPrefix, ref });
    pageRecords = [];
    pagePrefixes = [];
  };
  for (const [childPrefix, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const childPayload = jsonBytes({
      schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
      kind: bucketKind(kind),
      prefix: childPrefix,
      entries: group.map((item) => item.value)
    });
    if (childPayload.byteLength > target && group.length > 1) {
      await flushPage();
      entries.push({ prefix: childPrefix, ref: await writeNodeOrBucket(store, kind, childPrefix, group) });
      continue;
    }
    const combined = [...pageRecords, ...group];
    const combinedPayload = jsonBytes({
      schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
      kind: bucketKind(kind),
      prefix,
      entries: combined.map((item) => item.value)
    });
    if (pageRecords.length && combinedPayload.byteLength > target) {
      await flushPage();
    }
    pagePrefixes.push(childPrefix);
    pageRecords.push(...group);
  }
  await flushPage();
  const nodeBytes = jsonBytes({ schemaVersion: PUBLIC_EPG_SCHEMA_VERSION, kind: nodeKind(kind), prefix, entries });
  if (nodeBytes.byteLength > PUBLIC_EPG_LIMITS.maxIndexNodeUncompressedBytes) throw new Error("index_node_size_exceeded");
  return putImmutable(store, "json", nodeBytes);
}

/** Build a prefix-routed, content-addressed JSON index. It uploads only immutable artifacts. */
export async function writeRoutedDirectory<T>(
  store: ObjectStore,
  kind: DirectoryKind,
  records: HashedRecord<T>[],
  taxonomyVocabulary?: PublicTaxonomyVocabulary
): Promise<ArtifactRef> {
  const sorted = [...records].sort((left, right) => left.hash.localeCompare(right.hash));
  for (const record of sorted) {
    if (!/^[0-9a-f]{64}$/u.test(record.hash)) throw new Error("invalid_index_digest");
  }
  const groups = new Map<string, HashedRecord<T>[]>();
  for (const record of sorted) {
    const prefix = record.hash.slice(0, 1);
    const group = groups.get(prefix) ?? [];
    group.push(record);
    groups.set(prefix, group);
  }
  const sortedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const children = await mapBounded(sortedGroups, 8, async ([prefix, group]) => ({
    prefix,
    ref: await writeNodeOrBucket(store, kind, prefix, group)
  }));
  const entries: DirectoryChild[] = children;
  const root = {
    schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
    kind: rootKind(kind),
    entries,
    ...(kind === "taxonomy" && taxonomyVocabulary ? { vocabulary: taxonomyVocabulary } : {})
  } satisfies DirectoryRoot;
  const raw = jsonBytes(root);
  const ref = await putImmutable(store, "json", raw);
  if (ref.bytes > PUBLIC_EPG_LIMITS.maxRootUncompressedBytes || gzipSize(ref) > PUBLIC_EPG_LIMITS.maxRootCompressedBytes) {
    throw new Error("index_root_size_exceeded");
  }
  return ref;
}

export function identityRecords(entries: readonly PublicIdentityEntry[]): HashedRecord<PublicIdentityEntry>[] {
  return entries.map((value) => ({ hash: sha256(identityKey(value)), value }));
}

export function programmeRecords(entries: readonly PublicProgrammeChannel[]): HashedRecord<PublicProgrammeChannel>[] {
  const seen = new Set<string>();
  return entries.map((value) => {
    if (!validPublicProgrammeChannel(value)) throw new Error("programme_identity_invalid");
    const key = programmeIdentityKey(value);
    if (seen.has(key)) throw new Error("programme_identity_duplicate");
    seen.add(key);
    return { hash: sha256(key), value };
  });
}

/** Build complete source-local name postings from the already-verified programmeRoot rows. */
export function programmeNameRecords(entries: readonly PublicProgrammeChannel[]): HashedRecord<PublicProgrammeNamePosting>[] {
  const terms = new Map<string, Map<string, PublicProgrammeNamePosting["candidates"][number]>>();
  for (const channel of entries) {
    if (!validPublicProgrammeChannel(channel)) throw new Error("programme_name_source_invalid");
    const candidate = {
      sourceID: channel.sourceID,
      sourceRevision: channel.sourceRevision,
      sourcePriority: channel.sourcePriority,
      xmltvChannelID: channel.xmltvChannelID
    };
    const identity = programmeIdentityKey(candidate);
    for (const displayName of channel.displayNames) {
      const term = normalizePublicProgrammeName(displayName);
      if (!term) continue;
      if (new TextEncoder().encode(term).byteLength > PUBLIC_EPG_LIMITS.maxProgrammeNameTermBytes) {
        throw new Error("programme_name_term_too_large");
      }
      let candidates = terms.get(term);
      if (!candidates) {
        if (terms.size >= PUBLIC_EPG_LIMITS.maxProgrammeNameTerms) throw new Error("programme_name_term_budget_exceeded");
        candidates = new Map();
        terms.set(term, candidates);
      }
      const prior = candidates.get(identity);
      if (prior && (prior.sourceRevision !== candidate.sourceRevision || prior.sourcePriority !== candidate.sourcePriority)) {
        throw new Error("programme_name_tuple_conflict");
      }
      candidates.set(identity, candidate);
    }
  }
  return [...terms.entries()].sort(([left], [right]) => compareText(left, right)).map(([term, sourceCandidates]) => {
    const candidates = [...sourceCandidates.values()].sort((left, right) => left.sourcePriority - right.sourcePriority
      || compareText(left.sourceID, right.sourceID) || compareText(left.xmltvChannelID, right.xmltvChannelID));
    let posting: PublicProgrammeNamePosting = {
      term,
      candidates: candidates.length > PUBLIC_EPG_LIMITS.maxProgrammeNameCandidates ? [] : candidates,
      ambiguous: candidates.length > PUBLIC_EPG_LIMITS.maxProgrammeNameCandidates
    };
    if (!posting.ambiguous
      && new TextEncoder().encode(JSON.stringify(posting)).byteLength > PUBLIC_EPG_LIMITS.maxProgrammeNamePostingBytes) {
      posting = { term, candidates: [], ambiguous: true };
    }
    if (!validPublicProgrammeNamePosting(posting)) throw new Error("programme_name_posting_invalid");
    return { hash: sha256(term), value: posting };
  });
}

export function nameRecords(entries: readonly NameEntryRecord[]): HashedRecord<NameEntryRecord>[] {
  return entries.map((value) => ({ hash: sha256(value.term), value }));
}

export function metadataSuggestionRecords(
  entries: readonly MetadataSuggestionBucketEntry[]
): HashedRecord<MetadataSuggestionBucketEntry>[] {
  return entries.map((value) => ({ hash: sha256(value.term), value }));
}

export function streamsRecords(entries: readonly PublicStreamsEntry[]): HashedRecord<PublicStreamsEntry>[] {
  return entries.map((value) => ({ hash: sha256(identityKey(value)), value }));
}

/** Route by the already-hashed public access digest so clients can select the same fixed artifact prefix locally. */
export function accessRecords(entries: readonly PublicAccessEntry[]): HashedRecord<PublicAccessEntry>[] {
  return entries.map((value) => ({ hash: value.accessDigest, value }));
}

export function taxonomyRecords(entries: readonly PublicTaxonomyPosting[]): HashedRecord<PublicTaxonomyPosting>[] {
  return entries.map((value) => ({ hash: sha256(taxonomyDirectoryKey(value.dimension, value.value)), value }));
}

/** Write a complete range-addressable typed taxonomy. Pages are immutable and never truncated. */
export async function writeTaxonomyDirectory(
  store: ObjectStore,
  seeds: readonly PublicTaxonomyPostingSeed[],
  vocabulary: PublicTaxonomyVocabulary
): Promise<{ root: ArtifactRef; postings: PublicTaxonomyPosting[]; pageCount: number }> {
  const pageGroups: Array<{ dimension: PublicTaxonomyPostingSeed["dimension"]; value: string; memberKeys: string[][] }> = [];
  let pageCount = 0;
  const postings: PublicTaxonomyPosting[] = [];
  for (const seed of seeds) {
    if (!seed.memberKeys.length || seed.memberKeys.length > PUBLIC_EPG_LIMITS.maxPublicTaxonomyMembersPerPosting) {
      throw new Error("taxonomy_posting_invalid");
    }
    const groups: string[][] = [];
    let current: string[] = [];
    let currentMemberBytes = 0;
    for (const memberKey of seed.memberKeys) {
      // Identity keys are restricted to ASCII IDs plus `@`. Account for the
      // JSON string and comma incrementally so large complete postings remain
      // linear-time rather than serializing the growing page for every member.
      const memberBytes = Buffer.byteLength(JSON.stringify(memberKey));
      const candidateBytes = currentMemberBytes + memberBytes + (current.length ? 1 : 0) + 1_024;
      // The fixed 1 KiB allowance covers the envelope and the final pageIndex,
      // pageCount, firstKey and lastKey fields. The serialized page is checked
      // again once its exact page count is known.
      if (candidateBytes > PUBLIC_EPG_LIMITS.maxTaxonomyPageBytes - 128) {
        if (!current.length) throw new Error("taxonomy_member_exceeds_page_budget");
        groups.push(current);
        current = [memberKey];
        currentMemberBytes = memberBytes;
      } else {
        current.push(memberKey);
        currentMemberBytes += memberBytes + (current.length > 1 ? 1 : 0);
      }
    }
    if (current.length) groups.push(current);
    pageGroups.push({ dimension: seed.dimension, value: seed.value, memberKeys: groups });
    pageCount += groups.length;
    if (pageCount > PUBLIC_EPG_LIMITS.maxPublicTaxonomyMemberships) throw new Error("taxonomy_page_budget_exceeded");
  }
  if (pageGroups.length > PUBLIC_EPG_LIMITS.maxPublicTaxonomyPostings) throw new Error("taxonomy_posting_budget_exceeded");

  for (const group of pageGroups) {
    if (group.memberKeys.length > PUBLIC_EPG_LIMITS.maxTaxonomyPagesPerPosting) throw new Error("taxonomy_posting_page_budget_exceeded");
    const descriptors = [];
    const expectedPageCount = group.memberKeys.length;
    for (let pageIndex = 0; pageIndex < expectedPageCount; pageIndex += 1) {
      const memberKeys = group.memberKeys[pageIndex]!;
      const page: PublicTaxonomyPage = {
        schemaVersion: PUBLIC_EPG_SCHEMA_VERSION,
        kind: "taxonomy-page",
        dimension: group.dimension,
        value: group.value,
        pageIndex,
        pageCount: expectedPageCount,
        firstKey: memberKeys[0]!,
        lastKey: memberKeys[memberKeys.length - 1]!,
        count: memberKeys.length,
        memberKeys
      };
      const raw = jsonBytes(page);
      if (raw.byteLength > PUBLIC_EPG_LIMITS.maxTaxonomyPageBytes || !validPublicTaxonomyPage(page)) {
        throw new Error("taxonomy_page_invalid");
      }
      const ref = await putImmutable(store, "json", raw);
      descriptors.push({ ref, firstKey: page.firstKey, lastKey: page.lastKey, count: page.count });
    }
    const posting: PublicTaxonomyPosting = {
      dimension: group.dimension,
      value: group.value,
      memberCount: group.memberKeys.reduce((total, page) => total + page.length, 0),
      pages: descriptors
    };
    if (!validPublicTaxonomyPosting(posting)) throw new Error("taxonomy_posting_invalid");
    postings.push(posting);
  }
  const root = await writeRoutedDirectory(store, "taxonomy", taxonomyRecords(postings), vocabulary);
  if (root.bytes > PUBLIC_EPG_LIMITS.maxRootUncompressedBytes || root.compressedBytes > PUBLIC_EPG_LIMITS.maxRootCompressedBytes) {
    throw new Error("taxonomy_root_size_exceeded");
  }
  return { root, postings, pageCount };
}

export type RoutedDirectoryEntry = { hash: string; value: unknown };

/** Load a content-addressed directory with digest/byte validation and strict object-count bounds. */
export async function readRoutedDirectory<T>(
  store: ObjectStore,
  rootRef: ArtifactRef,
  expectedKind: DirectoryKind,
  maxObjects = 20,
  maxDecodedBytes = 1024 * 1024
): Promise<HashedRecord<T>[]> {
  const objects = new Map<string, unknown>();
  let reads = 0;
  let decodedBytes = 0;
  const read = async (ref: ArtifactRef): Promise<unknown> => {
    const prior = objects.get(ref.key);
    if (prior) return prior;
    if (++reads > maxObjects) throw new Error("index_read_budget_exceeded");
    const value = await getVerifiedJSON<unknown>(store, ref, expectedKind === "taxonomy"
      ? PUBLIC_EPG_LIMITS.maxTaxonomyPostingBytes : PUBLIC_EPG_LIMITS.maxRootUncompressedBytes);
    decodedBytes += ref.bytes;
    if (decodedBytes > maxDecodedBytes) throw new Error("index_decode_budget_exceeded");
    objects.set(ref.key, value);
    return value;
  };
  const root = await read(rootRef) as Record<string, unknown>;
  if (root.schemaVersion !== PUBLIC_EPG_SCHEMA_VERSION || root.kind !== rootKind(expectedKind) || !Array.isArray(root.entries)) {
    throw new Error("index_root_invalid");
  }
  if (expectedKind === "taxonomy" && !validPublicTaxonomyRoot(root)) throw new Error("index_root_invalid");
  const output: HashedRecord<T>[] = [];
  const emitted = new Set<string>();
  const visit = async (prefix: string, ref: ArtifactRef, siblings: Array<{ prefix: string; ref: ArtifactRef }> = [{ prefix, ref }]): Promise<void> => {
    const node = await read(ref) as Record<string, unknown>;
    if (node.schemaVersion !== PUBLIC_EPG_SCHEMA_VERSION || typeof node.kind !== "string" || !Array.isArray(node.entries)) {
      throw new Error("index_node_invalid");
    }
    if (node.kind === bucketKind(expectedKind)) {
      const commonPrefix = siblings.map((child) => child.prefix).reduce((common, candidate) => {
        let length = 0;
        while (length < common.length && length < candidate.length && common[length] === candidate[length]) length += 1;
        return common.slice(0, length);
      });
      if (node.prefix !== commonPrefix) throw new Error("index_bucket_prefix_invalid");
      for (const value of node.entries) {
        let hash: string;
        if (expectedKind === "name" || expectedKind === "metadata-name" || expectedKind === "metadata-suggestion"
          || expectedKind === "programme-names") {
          if (!value || typeof value !== "object" || typeof (value as { term?: unknown }).term !== "string") throw new Error("index_bucket_entry_invalid");
          if (expectedKind === "metadata-suggestion" && !validMetadataSuggestionBucketEntry(value)) throw new Error("index_bucket_entry_invalid");
          if (expectedKind === "programme-names" && !validPublicProgrammeNamePosting(value)) throw new Error("index_bucket_entry_invalid");
          hash = sha256((value as { term: string }).term);
        } else if (expectedKind === "access") {
          if (!validPublicAccessEntry(value)) throw new Error("index_bucket_entry_invalid");
          hash = (value as PublicAccessEntry).accessDigest;
        } else if (expectedKind === "taxonomy") {
          if (!validPublicTaxonomyPosting(value)) throw new Error("index_bucket_entry_invalid");
          hash = sha256(taxonomyDirectoryKey((value as PublicTaxonomyPosting).dimension, (value as PublicTaxonomyPosting).value));
        } else if (expectedKind === "programme") {
          if (!validPublicProgrammeChannel(value)) throw new Error("index_bucket_entry_invalid");
          hash = sha256(programmeIdentityKey(value));
        } else {
          if (!value || typeof value !== "object" || typeof (value as { channelID?: unknown }).channelID !== "string"
            || !((value as { feedID?: unknown }).feedID === null || typeof (value as { feedID?: unknown }).feedID === "string")) {
            throw new Error("index_bucket_entry_invalid");
          }
          hash = sha256(identityKey(value as { channelID: string; feedID: string | null }));
        }
        if (!siblings.some((child) => hash.startsWith(child.prefix))) throw new Error("index_bucket_route_invalid");
        const entryKey = `${hash}\u001f${expectedKind === "name" || expectedKind === "metadata-name" || expectedKind === "metadata-suggestion"
          || expectedKind === "programme-names"
          ? (value as { term: string }).term
          : expectedKind === "access" ? (value as PublicAccessEntry).accessDigest
          : expectedKind === "taxonomy" ? `${(value as PublicTaxonomyPosting).dimension}\u001f${(value as PublicTaxonomyPosting).value}`
          : expectedKind === "programme" ? programmeIdentityKey(value as PublicProgrammeChannel)
          : identityKey(value as { channelID: string; feedID: string | null })}`;
        if (emitted.has(entryKey)) throw new Error("index_bucket_duplicate_entry");
        emitted.add(entryKey);
        output.push({ hash, value: value as T });
      }
      return;
    }
    if (node.kind !== nodeKind(expectedKind) || node.prefix !== prefix) throw new Error("index_node_kind_invalid");
    const byRef = new Map<string, Array<{ prefix: string; ref: ArtifactRef }>>();
    for (const child of node.entries as DirectoryChild[]) {
      if (!child || !child.ref || typeof child.prefix !== "string" || !/^[0-9a-f]{1,64}$/u.test(child.prefix)
        || !child.prefix.startsWith(prefix) || child.prefix.length !== prefix.length + 1) throw new Error("index_child_invalid");
      const rows = byRef.get(child.ref.key) ?? [];
      rows.push(child);
      byRef.set(child.ref.key, rows);
    }
    for (const children of byRef.values()) {
      if (children.length > 1) await visit(prefix, children[0]!.ref, children);
      else await visit(children[0]!.prefix, children[0]!.ref);
    }
  };
  for (const child of root.entries as DirectoryChild[]) {
    if (!child || !child.ref || !/^[0-9a-f]{1,64}$/u.test(child.prefix)) throw new Error("index_root_child_invalid");
    await visit(child.prefix, child.ref);
  }
  return output.sort((left, right) => left.hash.localeCompare(right.hash));
}

/** Read selected posting pages and verify descriptor ranges against page bytes. */
export async function readTaxonomyPostingPages(
  store: ObjectStore,
  posting: PublicTaxonomyPosting,
  pageIndexes: readonly number[] = posting.pages.map((_, index) => index),
  maxDecodedBytes = Number.MAX_SAFE_INTEGER
): Promise<PublicTaxonomyPage[]> {
  if (!validPublicTaxonomyPosting(posting)) throw new Error("taxonomy_posting_invalid");
  const uniqueIndexes = [...new Set(pageIndexes)];
  if (uniqueIndexes.length !== pageIndexes.length || uniqueIndexes.some((index) => !Number.isSafeInteger(index)
    || index < 0 || index >= posting.pages.length)) throw new Error("taxonomy_page_selection_invalid");
  let decodedBytes = 0;
  const output: PublicTaxonomyPage[] = [];
  for (const pageIndex of uniqueIndexes) {
    const descriptor = posting.pages[pageIndex]!;
    const page = await getVerifiedJSON<unknown>(store, descriptor.ref, PUBLIC_EPG_LIMITS.maxTaxonomyPageBytes);
    decodedBytes += descriptor.ref.bytes;
    if (decodedBytes > maxDecodedBytes) throw new Error("taxonomy_page_decode_budget_exceeded");
    if (!validPublicTaxonomyPage(page)
      || page.dimension !== posting.dimension || page.value !== posting.value
      || page.pageIndex !== pageIndex || page.pageCount !== posting.pages.length
      || page.firstKey !== descriptor.firstKey || page.lastKey !== descriptor.lastKey
      || page.count !== descriptor.count) throw new Error("taxonomy_page_descriptor_mismatch");
    output.push(page);
  }
  return output;
}
