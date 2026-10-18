export const PUBLIC_EPG_SCHEMA_VERSION = 1 as const;
/** Manifest v2 adds an independently routed source-local programme index. */
export const PUBLIC_EPG_MANIFEST_VERSION = 2 as const;
export const PUBLIC_EPG_LEGACY_MANIFEST_VERSION = 1 as const;
/** Bump when typed channel taxonomy keys, membership semantics or page framing change. */
export const PUBLIC_TAXONOMY_INDEX_VERSION = 1 as const;
/** Metadata-only whitespace-compaction namespace; never used by EPG or playable discovery. */
export const PUBLIC_EPG_METADATA_COMPACT_PREFIX = "compact:" as const;
export const PUBLIC_EPG_PREFIX = "public-epg/v1/";
export const PUBLIC_EPG_CURRENT_KEY = `${PUBLIC_EPG_PREFIX}current.json`;
export const PUBLIC_EPG_PUBLISHER_STATE_KEY = `${PUBLIC_EPG_PREFIX}publisher-state.json`;

/** Stable source IDs and priority are part of the admitted public registry contract. */
export const PUBLIC_EPG_SOURCE_REGISTRY = [
  { id: "public-90d9cacbf43db054b57bbc0a", priority: 0 },
  { id: "public-cbbefef69fc4bd5a18b6fa5d", priority: 1 },
  { id: "public-f052ed19cc993c717cc4e430", priority: 2 },
  { id: "public-c834325f6d69267ae7dfb24e", priority: 3 },
  { id: "public-5f12e5943977c123ae609757", priority: 4 },
  { id: "public-13cbe88267f4e89209d9c142", priority: 5 },
  { id: "public-68cf04206c85720419d2d391", priority: 6 },
  { id: "public-3bc1d0aaed70290958815d60", priority: 7 },
  { id: "public-498c90a433be3d2ec38fd911", priority: 8 },
  { id: "public-b591002085a927ea83b3292d", priority: 9 },
  { id: "public-3f87592218f03706ee9af3af", priority: 10 },
  { id: "public-3e6aac3d12c890b643dff1be", priority: 11 },
  { id: "public-80615eb37b983466496de16d", priority: 12 },
  { id: "public-c295d8b926b1fed554c30735", priority: 13 },
  { id: "public-46347ea79f0c8d26adc88005", priority: 14 },
  { id: "public-808cdd193b161e18a6438fa3", priority: 15 },
  { id: "public-648cde475d55a69d9685e1b6", priority: 16 },
  { id: "public-c67446db1521540996a7076c", priority: 17 }
] as const;
export const PUBLIC_EPG_SOURCE_IDS = PUBLIC_EPG_SOURCE_REGISTRY.map((source) => source.id);
export const PUBLIC_EPG_METADATA_SOURCE_IDS = [
  "iptv-org:channels", "iptv-org:feeds", "iptv-org:categories", "iptv-org:streams", "iptv-org:logos"
] as const;

export const PUBLIC_EPG_LIMITS = {
  maxSourceConcurrency: 2,
  maxCompressedSourceBytes: 16 * 1024 * 1024,
  maxDecompressedSourceBytes: 96 * 1024 * 1024,
  maxCompressedShardBytes: 1024 * 1024,
  maxUncompressedShardBytes: 8 * 1024 * 1024,
  maxRootCompressedBytes: 16 * 1024,
  maxRootUncompressedBytes: 128 * 1024,
  maxIndexNodeUncompressedBytes: 64 * 1024,
  // Identity rows carry bounded route hints. Complete dated shard lists live
  // only in programmeRoot, where they are read on demand for an exact route.
  maxIdentityRelations: 64,
  maxIndexedCandidates: 16,
  maxProgrammeNameCandidates: 64,
  maxProgrammeNamePostingBytes: 48 * 1024,
  maxProgrammeNameTermBytes: 4 * 1024,
  maxProgrammeNameTerms: 1_000_000,
  maxProgrammeNameDescriptorBytes: 4 * 1024,
  maxMetadataNameCandidates: 8,
  maxMetadataSuggestionCandidates: 32,
  maxMetadataSuggestionTerms: 250_000,
  maxWikidataSuggestionEntities: 3_000,
  maxWikidataSuggestionAliases: 4,
  maxWikidataSuggestionResponseBytes: 2 * 1024 * 1024,
  maxWikidataSuggestionDecodedBytes: 4 * 1024 * 1024,
  maxChannelCategoryIDs: 16,
  maxMetadataNameTerms: 1_000_000,
  maxPublicAccessMembersPerDigest: 16,
  maxPublicTaxonomyPostings: 20_000,
  maxPublicTaxonomyMembersPerPosting: 200_000,
  maxPublicTaxonomyMemberships: 5_400_000,
  maxTaxonomyPagesPerPosting: 384,
  maxTaxonomyPageBytes: 48 * 1024,
  maxTaxonomyPostingBytes: 256 * 1024,
  maxIdentityXmlParts: 64,
  maxJsonObjectsPerRead: 40,
  maxDecodedJsonBytesPerRead: 1024 * 1024
} as const;

export type ArtifactRef = {
  key: string;
  sha256: string;
  /** Number of bytes after decompression; equal to the body length for JSON manifests. */
  bytes: number;
  /** Number of bytes stored in R2. */
  compressedBytes: number;
};

export type CurrentPointer = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  /** Hash of stable logical source/index inputs. */
  revision: string;
  manifestKey: string;
  /** Hash of exact UTF-8 manifest bytes; this is distinct from `revision`. */
  manifestSha256: string;
};

export type SourceFreshness = "ready" | "stale" | "unavailable";

export type PublicEpgSourceStatus = {
  sourceID: string;
  sourceRevision: string | null;
  status: SourceFreshness;
  /** Timestamp of last successful source body, not the last attempt. */
  lastGoodAt: string | null;
};

export type PublicEpgManifestFields = {
  revision: string;
  /** Independent fence for public channel attributes and metadata candidates; absent only in legacy manifests. */
  channelMetadataRevision?: string;
  generatedAt: string;
  previousRevision: string | null;
  sources: PublicEpgSourceStatus[];
  /** Digest of the fixed metadata and source-index inputs used for all roots. */
  indexInputDigest?: string;
  identityRoot: ArtifactRef;
  nameRoot: ArtifactRef;
  /** Optional for old last-known-good manifests; new publications always include it. */
  streamsRoot?: ArtifactRef;
  /** Optional for legacy manifests; maps exact public route digests to deduplicated public identities. */
  accessRoot?: ArtifactRef;
  /** Optional for old last-known-good manifests; new publications always include it. */
  metadataNameRoot?: ArtifactRef;
  /** Optional identity-free public metadata suggestions, never EPG/playback evidence. */
  metadataSuggestionRoot?: ArtifactRef;
  /** Optional bounded typed language/category/country candidate postings. */
  taxonomyRoot?: ArtifactRef;
};

export type PublicEpgManifest = (PublicEpgManifestFields & {
  schemaVersion: typeof PUBLIC_EPG_LEGACY_MANIFEST_VERSION;
  /** Absent in legacy v1 manifests. */
  programmeRoot?: never;
}) | (PublicEpgManifestFields & {
  schemaVersion: typeof PUBLIC_EPG_MANIFEST_VERSION;
  /** Exact sourceID+xmltvChannelID index; required by v2. */
  programmeRoot: ArtifactRef;
});

export type PublicTaxonomyDimension = "language" | "category" | "country";

/** The key is stable and unambiguous because public channel/feed IDs cannot contain `@`. */
export type PublicTaxonomyPageDescriptor = {
  ref: ArtifactRef;
  firstKey: string;
  lastKey: string;
  count: number;
};

export type PublicTaxonomyPosting = {
  dimension: PublicTaxonomyDimension;
  value: string;
  memberCount: number;
  pages: PublicTaxonomyPageDescriptor[];
};

export type PublicTaxonomyVocabulary = {
  language: string[];
  category: string[];
  country: string[];
};

export type PublicTaxonomyPage = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "taxonomy-page";
  dimension: PublicTaxonomyDimension;
  value: string;
  pageIndex: number;
  pageCount: number;
  firstKey: string;
  lastKey: string;
  count: number;
  /** Sorted complete identity keys: channelID@feedID, or channelID@ for Channel identity. */
  memberKeys: string[];
};

export type PublicChannelIdentity = {
  provider: "iptv-org";
  channelID: string;
  feedID: string | null;
};

export type NameMatchKind = "exact" | "alias" | "gram";

/** Small public metadata copied from the same fixed-registry ChannelSeed. */
export type PublicChannelProjection = {
  name: string;
  canonicalName: string;
  feedName: string | null;
  aliases: string[];
  languages: string[];
  broadcastAreas: string[];
  timezones: string[];
  /** ISO 3166-1 alpha-2 country from which the channel is transmitted. */
  country?: string | null;
  /** Bounded IDs from the fixed public channel-category taxonomy. */
  categoryIDs?: string[];
  /** One ISO-639-3 language only when every public Feed agrees. */
  channelLanguages?: string[];
};

export type PublicChannelCandidate = PublicChannelIdentity & {
  matchKind: NameMatchKind;
  /** Optional for compatibility with already-published name artifacts. */
  projection?: PublicChannelProjection;
};

export type ProgrammePartRef = ArtifactRef & {
  utcDay: string;
  part: number;
  /** Raw XML digest. `sha256` hashes the stored gzip object. */
  xmlSha256: string;
};

export type ProgrammeDayRef = {
  utcDay: string;
  parts: ProgrammePartRef[];
};

export type PublicProgrammeRelation = {
  sourceID: string;
  sourceRevision: string;
  sourcePriority: number;
  xmltvChannelID: string;
  displayName: string;
  days: ProgrammeDayRef[];
};

/**
 * One XMLTV channel's programme evidence inside one trusted public source.
 * This source-local identity exists independently of optional external metadata.
 */
export type PublicProgrammeChannel = {
  sourceID: string;
  sourceRevision: string;
  sourcePriority: number;
  xmltvChannelID: string;
  displayNames: string[];
  /** Language tags declared on corresponding XMLTV display-name elements, when present. */
  displayNameLanguages: string[];
  /** Optional exact metadata association; never used to construct the source-local identity. */
  externalIdentity?: PublicChannelIdentity;
  days: ProgrammeDayRef[];
};

/** Candidate for source-local name lookup; this is never an external identity association. */
export type PublicProgrammeNameCandidate = {
  sourceID: string;
  sourceRevision: string;
  sourcePriority: number;
  xmltvChannelID: string;
};

/** Complete bounded posting for one normalized XMLTV display name. */
export type PublicProgrammeNamePosting = {
  term: string;
  candidates: PublicProgrammeNameCandidate[];
  /** True means the complete candidate set exceeded a published bound. */
  ambiguous: boolean;
};

/** Companion descriptor is bound to one exact immutable programmeRoot digest. */
export type PublicProgrammeNameDescriptor = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  programmeRootSHA256: string;
  root: ArtifactRef;
};

export type PublicIdentityEntry = {
  /** Optional display-only Logo; not identity evidence or a stream route. */
  logoURL?: string;
  provider: "iptv-org";
  channelID: string;
  feedID: string | null;
  /** Channel-level public name. */
  canonicalName: string;
  /** Feed-level name, when this row identifies a Feed. */
  feedName: string | null;
  name: string;
  aliases: string[];
  languages: string[];
  broadcastAreas: string[];
  timezones: string[];
  relations: PublicProgrammeRelation[];
  /** ISO 3166-1 alpha-2 country from which the channel is transmitted. */
  country?: string | null;
  /** Bounded IDs from the fixed public channel-category taxonomy. */
  categoryIDs?: string[];
  /** One ISO-639-3 language only when every public Feed agrees. */
  channelLanguages?: string[];
};

export type PublicStream = {
  streamId: string;
  providerChannelId: string;
  feedId?: string;
  title: string;
  url: string;
  referrer?: string;
  userAgent?: string;
  quality?: string;
  labels: string[];
};

export type PublicStreamsEntry = {
  channelID: string;
  feedID: string | null;
  streams: PublicStream[];
};

export type DirectoryChild = {
  /** Prefix of the UTF-8 SHA-256 hex digest used for routing, one to 64 hex chars. */
  prefix: string;
  ref: ArtifactRef;
};

export type DirectoryRoot = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "identity-root" | "name-root" | "metadata-name-root" | "metadata-suggestion-root" | "source-root" | "streams-root" | "access-root" | "taxonomy-root" | "programme-root" | "programme-names-root";
  entries: DirectoryChild[];
  /** Present only on taxonomy-root; vocabulary is public metadata, never route data. */
  vocabulary?: PublicTaxonomyVocabulary;
};

export type DirectoryNode = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "identity-node" | "name-node" | "metadata-name-node" | "metadata-suggestion-node" | "source-node" | "streams-node" | "access-node" | "taxonomy-node" | "programme-node" | "programme-names-node";
  prefix: string;
  entries: DirectoryChild[];
};

export type IdentityBucket = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "identity-bucket";
  prefix: string;
  entries: PublicIdentityEntry[];
};

export type ProgrammeChannelBucket = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "programme-bucket";
  prefix: string;
  entries: PublicProgrammeChannel[];
};

export type NameBucketEntry = {
  /** Full normalized name, `compact:<name-with-spaces-removed>` for metadata-only lookup, or `gram:<n-gram>` for lexical narrowing. */
  term: string;
  candidates: PublicChannelCandidate[];
  /** True means candidate overflow; callers must fail closed instead of selecting a partial list. */
  ambiguous: boolean;
};

/** A public, identity-free Wikidata candidate. It may only be shown for user confirmation. */
export type PublicMetadataSuggestionCandidate = {
  sourceID: "wikidata";
  itemID: string;
  candidateName: string;
  aliases: string[];
  country?: string;
  languages?: string[];
  categoryIDs?: string[];
  fieldProvenance: {
    title?: string[];
    country?: string[];
    languages?: string[];
    categoryIDs?: string[];
  };
};

export type MetadataSuggestionCandidate = PublicChannelCandidate | PublicMetadataSuggestionCandidate;

export type MetadataSuggestionBucketEntry = {
  term: string;
  candidates: MetadataSuggestionCandidate[];
  /** True means the complete candidate set was too large and must not be used. */
  ambiguous: boolean;
};

export type MetadataSuggestionBucket = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "metadata-suggestion-bucket";
  prefix: string;
  entries: MetadataSuggestionBucketEntry[];
};

export function validMetadataSuggestionBucketEntry(value: unknown): value is MetadataSuggestionBucketEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.term !== "string" || !/^fuzzy:[\p{L}\p{N}]{3}$/u.test(entry.term)
    || !Array.isArray(entry.candidates) || entry.candidates.length > PUBLIC_EPG_LIMITS.maxMetadataSuggestionCandidates
    || typeof entry.ambiguous !== "boolean"
    || (entry.ambiguous && entry.candidates.length !== 0)
    || (!entry.ambiguous && entry.candidates.length === 0)) return false;
  const keys = new Set<string>();
  for (const candidate of entry.candidates) {
    const validIPTV = validPublicChannelCandidate(candidate)
      && candidate.matchKind === "gram" && candidate.feedID === null && candidate.projection === undefined;
    const validWikidata = validMetadataSuggestionCandidate(candidate);
    if (!validIPTV && !validWikidata) return false;
    const key = validWikidata ? `wikidata:${candidate.itemID}` : `iptv-org:${(candidate as PublicChannelCandidate).channelID}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export type NameBucket = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "name-bucket" | "metadata-name-bucket";
  prefix: string;
  entries: NameBucketEntry[];
};

export type PublicStreamsBucket = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "streams-bucket";
  prefix: string;
  entries: PublicStreamsEntry[];
};

export type PublicAccessMember = {
  channelID: string;
  feedID: string | null;
};

export type PublicAccessEntry = {
  /** Versioned SHA-256 of the public stream URL and its effective Referer/User-Agent headers. */
  accessDigest: string;
  /** Exact Channel+Feed memberships; empty when the bounded posting overflowed. */
  members: PublicAccessMember[];
  /** True means the full membership set exceeded the bound and must not be used. */
  ambiguous: boolean;
};

export type PublicAccessBucket = {
  schemaVersion: typeof PUBLIC_EPG_SCHEMA_VERSION;
  kind: "access-bucket";
  prefix: string;
  entries: PublicAccessEntry[];
};

const DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_KEY = /^public-epg\/v1\/[A-Za-z0-9._/-]{1,512}$/u;
const SAFE_PUBLIC_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;
const PUBLIC_EPG_SOURCE_BY_ID = new Map<string, number>(PUBLIC_EPG_SOURCE_REGISTRY.map((source) => [source.id, source.priority]));
const QUALITY_SUFFIXES = new Set([
  "4k", "8k", "uhd", "fhd", "hd", "sd", "480p", "576p", "720p", "1080p", "1440p", "2160p"
]);

/** Validate a complete exact-access posting; overflows are represented only by an empty ambiguous entry. */
export function validPublicAccessEntry(value: unknown): value is PublicAccessEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !["accessDigest", "members", "ambiguous"].includes(key))
    || Object.keys(entry).length !== 3
    || typeof entry.accessDigest !== "string" || !DIGEST.test(entry.accessDigest)
    || !Array.isArray(entry.members) || entry.members.length > PUBLIC_EPG_LIMITS.maxPublicAccessMembersPerDigest
    || typeof entry.ambiguous !== "boolean"
    || (entry.ambiguous && entry.members.length !== 0)
    || (!entry.ambiguous && entry.members.length === 0)) return false;
  let previous: PublicAccessMember | undefined;
  const identities = new Set<string>();
  for (const raw of entry.members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const member = raw as Record<string, unknown>;
    if (Object.keys(member).some((key) => !["channelID", "feedID"].includes(key))
      || Object.keys(member).length !== 2
      || typeof member.channelID !== "string" || !SAFE_PUBLIC_ID.test(member.channelID)
      || !(member.feedID === null || typeof member.feedID === "string" && SAFE_PUBLIC_ID.test(member.feedID))) return false;
    const typedMember = member as unknown as PublicAccessMember;
    const key = identityKey(typedMember);
    if (identities.has(key)) return false;
    identities.add(key);
    if (previous && (previous.channelID > typedMember.channelID
      || previous.channelID === typedMember.channelID
        && (previous.feedID ?? "") >= (typedMember.feedID ?? ""))) return false;
    previous = typedMember;
  }
  return true;
}

/** Stable identity used for hashing and equality; provider is fixed by this public catalogue. */
export function identityKey(identity: Pick<PublicChannelIdentity, "channelID" | "feedID">): string {
  return `${identity.channelID}\u001f${identity.feedID ?? ""}`;
}

/** Stable route key for a public programme channel; the source ID is a mandatory identity component. */
export function programmeIdentityKey(identity: Pick<PublicProgrammeChannel, "sourceID" | "xmltvChannelID">): string {
  return `${identity.sourceID}\u001f${identity.xmltvChannelID}`;
}

/** Source-name lookup preserves every visible character except compatibility form and whitespace. */
export function normalizePublicProgrammeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function publicProgrammeNameDescriptorKey(programmeRootSHA256: string): string {
  if (!DIGEST.test(programmeRootSHA256)) throw new Error("programme_root_digest_invalid");
  return `${PUBLIC_EPG_PREFIX}source-names/${programmeRootSHA256}.json`;
}

export function validPublicProgrammeNamePosting(value: unknown): value is PublicProgrammeNamePosting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 3 || Object.keys(entry).some((key) => !["term", "candidates", "ambiguous"].includes(key))
    || typeof entry.term !== "string" || !entry.term || entry.term !== normalizePublicProgrammeName(entry.term)
    || new TextEncoder().encode(entry.term).byteLength > PUBLIC_EPG_LIMITS.maxProgrammeNameTermBytes
    || !Array.isArray(entry.candidates) || entry.candidates.length > PUBLIC_EPG_LIMITS.maxProgrammeNameCandidates
    || typeof entry.ambiguous !== "boolean"
    || (entry.ambiguous && entry.candidates.length !== 0)
    || (!entry.ambiguous && entry.candidates.length === 0)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > PUBLIC_EPG_LIMITS.maxProgrammeNamePostingBytes) return false;
  let previous: PublicProgrammeNameCandidate | undefined;
  const identities = new Set<string>();
  for (const raw of entry.candidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const candidate = raw as Record<string, unknown>;
    if (Object.keys(candidate).length !== 4
      || Object.keys(candidate).some((key) => !["sourceID", "sourceRevision", "sourcePriority", "xmltvChannelID"].includes(key))
      || !validPublicEpgSourceID(candidate.sourceID)
      || typeof candidate.sourceRevision !== "string" || !DIGEST.test(candidate.sourceRevision)
      || candidate.sourcePriority !== publicEpgSourcePriority(candidate.sourceID)
      || !validPublicXMLTVChannelID(candidate.xmltvChannelID)) return false;
    const typed = candidate as unknown as PublicProgrammeNameCandidate;
    const identity = programmeIdentityKey(typed);
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (previous && (previous.sourcePriority > typed.sourcePriority
      || previous.sourcePriority === typed.sourcePriority
        && (previous.sourceID > typed.sourceID
          || previous.sourceID === typed.sourceID && previous.xmltvChannelID >= typed.xmltvChannelID))) return false;
    previous = typed;
  }
  return true;
}

export function validPublicProgrammeNameDescriptor(value: unknown): value is PublicProgrammeNameDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || Object.keys(item).some((key) => !["schemaVersion", "programmeRootSHA256", "root"].includes(key))
    || item.schemaVersion !== PUBLIC_EPG_SCHEMA_VERSION
    || typeof item.programmeRootSHA256 !== "string" || !DIGEST.test(item.programmeRootSHA256)
    || !validArtifactRef(item.root)) return false;
  const root = item.root as ArtifactRef;
  return root.key === `${PUBLIC_EPG_PREFIX}objects/${root.sha256}.json.gz`
    && root.bytes > 0 && root.bytes <= PUBLIC_EPG_LIMITS.maxRootUncompressedBytes
    && root.compressedBytes > 0 && root.compressedBytes <= PUBLIC_EPG_LIMITS.maxRootCompressedBytes
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes;
}

export async function programmeIdentityDirectoryHash(
  identity: Pick<PublicProgrammeChannel, "sourceID" | "xmltvChannelID">
): Promise<string> {
  return sha256Hex(programmeIdentityKey(identity));
}

export function validPublicEpgSourceID(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_EPG_SOURCE_BY_ID.has(value);
}

export function publicEpgSourcePriority(sourceID: string): number | null {
  return PUBLIC_EPG_SOURCE_BY_ID.get(sourceID) ?? null;
}

/** Verify that the fixed publisher registry still matches this versioned shared contract exactly. */
export function validPublicEpgSourceRegistry(value: unknown): value is ReadonlyArray<{ id: string; priority: number }> {
  if (!Array.isArray(value) || value.length !== PUBLIC_EPG_SOURCE_REGISTRY.length) return false;
  const ids = new Set<string>();
  const priorities = new Set<number>();
  return value.every((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== "id" && key !== "priority")
      || row.id !== PUBLIC_EPG_SOURCE_REGISTRY[index]!.id
      || row.priority !== PUBLIC_EPG_SOURCE_REGISTRY[index]!.priority
      || typeof row.id !== "string" || typeof row.priority !== "number"
      || ids.has(row.id) || priorities.has(row.priority)) return false;
    ids.add(row.id);
    priorities.add(row.priority);
    return true;
  });
}

/** Source identities retain their exact XMLTV bytes after UTF-8 decoding; never trim or truncate them. */
export function validPublicXMLTVChannelID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.trim() && !CONTROL_CHARS.test(value);
}

export function validPublicProgrammeChannel(value: unknown): value is PublicProgrammeChannel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const allowed = ["sourceID", "sourceRevision", "sourcePriority", "xmltvChannelID", "displayNames", "displayNameLanguages", "externalIdentity", "days"];
  if (Object.keys(row).some((key) => !allowed.includes(key))
    || !validPublicEpgSourceID(row.sourceID)
    || typeof row.sourceRevision !== "string" || !DIGEST.test(row.sourceRevision)
    || row.sourcePriority !== publicEpgSourcePriority(row.sourceID)
    || !validPublicXMLTVChannelID(row.xmltvChannelID)
    || !boundedPublicTextList(row.displayNames, 32, 256)
    || !boundedPublicTextList(row.displayNameLanguages, 32, 32)
    || (row.externalIdentity !== undefined && !validPublicChannelIdentity(row.externalIdentity))
    || !Array.isArray(row.days) || row.days.length > 32) return false;
  let previousDay = "";
  let partCount = 0;
  for (const rawDay of row.days) {
    if (!rawDay || typeof rawDay !== "object" || Array.isArray(rawDay)) return false;
    const day = rawDay as Record<string, unknown>;
    if (Object.keys(day).length !== 2 || Object.keys(day).some((key) => key !== "utcDay" && key !== "parts")
      || !validUtcDay(day.utcDay)
      || day.utcDay <= previousDay || !Array.isArray(day.parts) || day.parts.length > 64) return false;
    previousDay = day.utcDay;
    let previousPart = -1;
    for (const rawPart of day.parts) {
      if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) return false;
      const part = rawPart as Record<string, unknown>;
      const extendedPart = part as Record<string, unknown>;
      if (Object.keys(part).length !== 7
        || !["key", "sha256", "bytes", "compressedBytes", "utcDay", "part", "xmlSha256"].every((key) => key in part)
        || !validArtifactRef(part) || !DIGEST.test(String(extendedPart.xmlSha256))
        || extendedPart.utcDay !== day.utcDay || !Number.isSafeInteger(extendedPart.part)
        || Number(extendedPart.part) < 0 || Number(extendedPart.part) > 63 || Number(extendedPart.part) <= previousPart
        || Number(extendedPart.bytes) <= 0 || Number(extendedPart.bytes) > PUBLIC_EPG_LIMITS.maxUncompressedShardBytes
        || Number(extendedPart.compressedBytes) <= 0 || Number(extendedPart.compressedBytes) > PUBLIC_EPG_LIMITS.maxCompressedShardBytes
        || extendedPart.key !== `${PUBLIC_EPG_PREFIX}objects/${extendedPart.sha256}.xml.gz`) return false;
      previousPart = Number(extendedPart.part);
      partCount += 1;
    }
  }
  return partCount > 0 && partCount <= PUBLIC_EPG_LIMITS.maxIdentityXmlParts;
}

function validUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validPublicChannelIdentity(value: unknown): value is PublicChannelIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).length === 3
    && Object.keys(identity).every((key) => ["provider", "channelID", "feedID"].includes(key))
    && identity.provider === "iptv-org"
    && typeof identity.channelID === "string" && SAFE_PUBLIC_ID.test(identity.channelID)
    && (identity.feedID === null || typeof identity.feedID === "string" && SAFE_PUBLIC_ID.test(identity.feedID));
}

/** Must stay byte-for-byte compatible between the offline publisher and Worker. */
export function normalizePublicName(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 256);
  const words = normalized.split(/\s+/u).filter(Boolean);
  // Feed composition can repeat quality labels. Strip the complete terminal
  // run so normalizing a published term again cannot change it.
  while (words.length > 1 && QUALITY_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(" ").slice(0, 256);
}

/** All distinct within-word 2- and 3-grams, for bounded lexical candidate narrowing only. */
export function publicNameGrams(value: string): string[] {
  const normalized = normalizePublicName(value);
  const grams = new Set<string>();
  for (const word of normalized.split(" ").filter(Boolean)) {
    for (const size of [2, 3]) {
      for (let index = 0; index + size <= word.length; index += 1) {
        grams.add(word.slice(index, index + size));
      }
    }
  }
  return [...grams].sort();
}

function privateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a! >= 224
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && (c === 113 || c === 0));
}

function privateIPv6(host: string): boolean {
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")
    || /^fe[89ab]/u.test(host) || host.startsWith("ff") || host.startsWith("2001:db8:")) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
  const address = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  return privateIPv4(address);
}

function boundedPublicText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= maximum && !CONTROL_CHARS.test(value);
}

function boundedPublicTextList(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems
    && value.every((item) => boundedPublicText(item, maximumLength));
}

const COUNTRY_CODE = /^[A-Z]{2}$/u;
const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const NON_FACT_CHANNEL_LANGUAGES = new Set(["und", "mul", "zxx"]);

export function validPublicCountryCode(value: unknown): value is string {
  return typeof value === "string" && COUNTRY_CODE.test(value);
}

export function validPublicCategoryIDs(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > PUBLIC_EPG_LIMITS.maxChannelCategoryIDs) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !CATEGORY_ID.test(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

/** Only these existing editor taxonomy IDs may be suggested by Wikidata genres. */
export const PUBLIC_METADATA_SUGGESTION_CATEGORY_IDS = [
  "animation", "auto", "business", "classic", "comedy", "cooking", "culture",
  "documentary", "education", "entertainment", "family", "general", "interactive",
  "kids", "legislative", "lifestyle", "movies", "music", "news", "outdoor",
  "public", "relax", "religious", "science", "series", "shop", "sports", "travel",
  "weather", "xxx"
] as const;

export function validPublicMetadataSuggestionCategoryIDs(value: unknown): value is string[] {
  return validPublicCategoryIDs(value)
    && value.every((id) => (PUBLIC_METADATA_SUGGESTION_CATEGORY_IDS as readonly string[]).includes(id));
}

export function validPublicChannelLanguages(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1
    && value.every((item) => typeof item === "string" && /^[a-z]{3}$/u.test(item) && !NON_FACT_CHANNEL_LANGUAGES.has(item));
}

const WIKIDATA_ITEM = /^Q[1-9][0-9]{0,12}$/u;

export function validMetadataSuggestionCandidate(value: unknown): value is PublicMetadataSuggestionCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ["sourceID", "itemID", "candidateName", "aliases", "country", "languages", "categoryIDs", "fieldProvenance"];
  if (Object.keys(item).some((key) => !allowed.includes(key)) || item.sourceID !== "wikidata"
    || typeof item.itemID !== "string" || !WIKIDATA_ITEM.test(item.itemID)
    || !boundedPublicText(item.candidateName, 256)
    || !boundedPublicTextList(item.aliases, PUBLIC_EPG_LIMITS.maxWikidataSuggestionAliases, 256)
    || (item.country !== undefined && !validPublicCountryCode(item.country))
    || (item.languages !== undefined && (!Array.isArray(item.languages) || item.languages.length > 4
      || item.languages.some((code) => typeof code !== "string" || !/^[a-z]{2,3}$/u.test(code))))
    || (item.categoryIDs !== undefined && !validPublicMetadataSuggestionCategoryIDs(item.categoryIDs))
    || !item.fieldProvenance || typeof item.fieldProvenance !== "object" || Array.isArray(item.fieldProvenance)) return false;
  const provenance = item.fieldProvenance as Record<string, unknown>;
  const fields = ["title", "country", "languages", "categoryIDs"];
  if (Object.keys(provenance).some((key) => !fields.includes(key))) return false;
  for (const [field, sourceList] of Object.entries(provenance)) {
    if (!fields.includes(field) || !boundedPublicTextList(sourceList, 4, 64)) return false;
  }
  return (item.country === undefined || Array.isArray(provenance.country) && provenance.country.length > 0)
    && (item.languages === undefined || Array.isArray(provenance.languages) && provenance.languages.length > 0)
    && (item.categoryIDs === undefined || Array.isArray(provenance.categoryIDs) && provenance.categoryIDs.length > 0)
    && (provenance.title === undefined || Array.isArray(provenance.title) && provenance.title.length > 0);
}

/** Shared validation for fixed-registry candidates and optional public metadata projection. */
export function validPublicChannelCandidate(value: unknown): value is PublicChannelCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => !["provider", "channelID", "feedID", "matchKind", "projection"].includes(key))
    || candidate.provider !== "iptv-org" || typeof candidate.channelID !== "string" || !SAFE_PUBLIC_ID.test(candidate.channelID)
    || !(candidate.feedID === null || typeof candidate.feedID === "string" && SAFE_PUBLIC_ID.test(candidate.feedID))
    || !(candidate.matchKind === "exact" || candidate.matchKind === "alias" || candidate.matchKind === "gram")) return false;
  if (candidate.projection === undefined) return true;
  if (candidate.matchKind === "gram") return false;
  if (!candidate.projection || typeof candidate.projection !== "object" || Array.isArray(candidate.projection)) return false;
  const projection = candidate.projection as Record<string, unknown>;
  const projectionKeys = Object.keys(projection);
  const requiredProjectionKeys = ["name", "canonicalName", "feedName", "aliases", "languages", "broadcastAreas", "timezones"];
  const optionalProjectionKeys = ["country", "categoryIDs", "channelLanguages"];
  if (projectionKeys.length < requiredProjectionKeys.length || projectionKeys.length > requiredProjectionKeys.length + optionalProjectionKeys.length
    || projectionKeys.some((key) => ![...requiredProjectionKeys, ...optionalProjectionKeys].includes(key))
    || requiredProjectionKeys.some((key) => !projectionKeys.includes(key))
    || !boundedPublicText(projection.name, 256) || !boundedPublicText(projection.canonicalName, 256)
    || !(projection.feedName === null || boundedPublicText(projection.feedName, 256))
    || (candidate.feedID === null ? projection.feedName !== null : projection.feedName === null)
    || !boundedPublicTextList(projection.aliases, 32, 256)
    || !boundedPublicTextList(projection.languages, 32, 32)
    || !boundedPublicTextList(projection.broadcastAreas, 64, 64)
    || !boundedPublicTextList(projection.timezones, 64, 64)
    || (projection.country !== undefined && projection.country !== null && !validPublicCountryCode(projection.country))
    || (projection.categoryIDs !== undefined && !validPublicCategoryIDs(projection.categoryIDs))
    || (projection.channelLanguages !== undefined && !validPublicChannelLanguages(projection.channelLanguages))) return false;
  return true;
}

/** Accepts public HTTP(S) URLs without resolving DNS or fetching the media. */
export function validPublicHTTPURL(value: unknown): value is string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096 || CONTROL_CHARS.test(value)) return false;
  try {
    const url = new URL(value);
    if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || !url.hostname) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host.includes(":")) return !privateIPv6(host);
    if (!host.includes(".")) return false;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) && privateIPv4(host)) return false;
    return true;
  } catch { return false; }
}

/** Shared publisher/Worker validation for exact channel+Feed public stream rows. */
export function validPublicStreamsEntry(value: unknown): value is PublicStreamsEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.channelID !== "string" || !SAFE_PUBLIC_ID.test(entry.channelID)
    || !(entry.feedID === null || typeof entry.feedID === "string" && SAFE_PUBLIC_ID.test(entry.feedID))
    || !Array.isArray(entry.streams) || entry.streams.length < 1 || entry.streams.length > 32) return false;
  const ids = new Set<string>();
  return entry.streams.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const stream = raw as Record<string, unknown>;
    if (typeof stream.streamId !== "string" || !stream.streamId.trim() || CONTROL_CHARS.test(stream.streamId)
      || new TextEncoder().encode(stream.streamId).byteLength > 128 || ids.has(stream.streamId)
      || stream.providerChannelId !== entry.channelID
      || !(stream.feedId === undefined || typeof stream.feedId === "string" && SAFE_PUBLIC_ID.test(stream.feedId))
      || (entry.feedID === null ? stream.feedId !== undefined : stream.feedId !== entry.feedID)
      || typeof stream.title !== "string" || !stream.title.trim() || CONTROL_CHARS.test(stream.title)
      || new TextEncoder().encode(stream.title).byteLength > 256 || !validPublicHTTPURL(stream.url)
      || !(stream.referrer === undefined || validPublicHTTPURL(stream.referrer))
      || !(stream.userAgent === undefined || typeof stream.userAgent === "string"
        && !CONTROL_CHARS.test(stream.userAgent) && new TextEncoder().encode(stream.userAgent).byteLength <= 512)
      || !(stream.quality === undefined || typeof stream.quality === "string"
        && !CONTROL_CHARS.test(stream.quality) && new TextEncoder().encode(stream.quality).byteLength <= 64)
      || !Array.isArray(stream.labels) || stream.labels.length > 32
      || stream.labels.some((label) => typeof label !== "string" || CONTROL_CHARS.test(label)
        || new TextEncoder().encode(label).byteLength > 128)) return false;
    ids.add(stream.streamId);
    return true;
  });
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  // Own the backing ArrayBuffer. Node's Buffer/Uint8Array can be backed by a
  // SharedArrayBuffer, which WebCrypto's BufferSource types reject.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", owned.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function identityDirectoryHash(identity: Pick<PublicChannelIdentity, "channelID" | "feedID">): Promise<string> {
  return sha256Hex(identityKey(identity));
}

/** Exact UTF-8 routing key. Keep JSON compact and array order stable for native clients. */
export function taxonomyDirectoryKey(dimension: PublicTaxonomyDimension, value: string): string {
  return JSON.stringify([PUBLIC_TAXONOMY_INDEX_VERSION, dimension, value]);
}

export async function taxonomyDirectoryHash(dimension: PublicTaxonomyDimension, value: string): Promise<string> {
  return sha256Hex(taxonomyDirectoryKey(dimension, value));
}

export function taxonomyMemberKey(identity: Pick<PublicChannelIdentity, "channelID" | "feedID">): string {
  return `${identity.channelID}@${identity.feedID ?? ""}`;
}

function validTaxonomyValue(dimension: PublicTaxonomyDimension, value: unknown): value is string {
  if (typeof value !== "string") return false;
  switch (dimension) {
    case "language": return validPublicChannelLanguages([value]);
    case "category": return validPublicCategoryIDs([value]);
    case "country": return validPublicCountryCode(value);
  }
}

function validTaxonomyMemberKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 257) return false;
  const separator = value.indexOf("@");
  if (separator <= 0 || separator !== value.lastIndexOf("@")) return false;
  const channelID = value.slice(0, separator);
  const feedID = value.slice(separator + 1);
  return SAFE_PUBLIC_ID.test(channelID) && (feedID === "" || SAFE_PUBLIC_ID.test(feedID));
}

export function validPublicTaxonomyPosting(value: unknown): value is PublicTaxonomyPosting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4
    || Object.keys(item).some((key) => !["dimension", "value", "memberCount", "pages"].includes(key))
    || !(item.dimension === "language" || item.dimension === "category" || item.dimension === "country")
    || !validTaxonomyValue(item.dimension, item.value)
    || !Number.isSafeInteger(item.memberCount) || Number(item.memberCount) < 1
    || Number(item.memberCount) > PUBLIC_EPG_LIMITS.maxPublicTaxonomyMembersPerPosting
    || !Array.isArray(item.pages) || item.pages.length < 1
    || item.pages.length > PUBLIC_EPG_LIMITS.maxTaxonomyPagesPerPosting) return false;
  let count = 0;
  let lastKey = "";
  const refs = new Set<string>();
  for (const raw of item.pages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const descriptor = raw as Record<string, unknown>;
    if (Object.keys(descriptor).length !== 4
      || Object.keys(descriptor).some((key) => !["ref", "firstKey", "lastKey", "count"].includes(key))
      || !validArtifactRef(descriptor.ref)
      || !Number.isSafeInteger(descriptor.count) || Number(descriptor.count) < 1
      || Number(descriptor.count) > PUBLIC_EPG_LIMITS.maxPublicTaxonomyMembersPerPosting
      || !validTaxonomyMemberKey(descriptor.firstKey) || !validTaxonomyMemberKey(descriptor.lastKey)
      || descriptor.firstKey > descriptor.lastKey || (lastKey && lastKey >= descriptor.firstKey)) return false;
    const ref = descriptor.ref as ArtifactRef;
    if (ref.bytes < 1 || ref.bytes > PUBLIC_EPG_LIMITS.maxTaxonomyPageBytes
      || ref.compressedBytes < 1 || ref.compressedBytes > PUBLIC_EPG_LIMITS.maxTaxonomyPageBytes
      || ref.key !== `${PUBLIC_EPG_PREFIX}objects/${ref.sha256}.json.gz` || refs.has(ref.key)) return false;
    refs.add(ref.key);
    count += Number(descriptor.count);
    lastKey = descriptor.lastKey;
  }
  return count === item.memberCount
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= PUBLIC_EPG_LIMITS.maxTaxonomyPostingBytes;
}

export function validPublicTaxonomyPage(value: unknown): value is PublicTaxonomyPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 10
    || Object.keys(item).some((key) => !["schemaVersion", "kind", "dimension", "value", "pageIndex", "pageCount", "firstKey", "lastKey", "count", "memberKeys"].includes(key))
    || item.schemaVersion !== PUBLIC_EPG_SCHEMA_VERSION || item.kind !== "taxonomy-page"
    || !(item.dimension === "language" || item.dimension === "category" || item.dimension === "country")
    || !validTaxonomyValue(item.dimension, item.value)
    || !Number.isSafeInteger(item.pageIndex) || Number(item.pageIndex) < 0
    || !Number.isSafeInteger(item.pageCount) || Number(item.pageCount) < 1
    || Number(item.pageCount) > PUBLIC_EPG_LIMITS.maxTaxonomyPagesPerPosting
    || Number(item.pageIndex) >= Number(item.pageCount)
    || !Array.isArray(item.memberKeys) || item.memberKeys.length < 1
    || item.memberKeys.length > PUBLIC_EPG_LIMITS.maxPublicTaxonomyMembersPerPosting
    || item.count !== item.memberKeys.length
    || !validTaxonomyMemberKey(item.firstKey) || !validTaxonomyMemberKey(item.lastKey)
    || item.firstKey !== item.memberKeys[0] || item.lastKey !== item.memberKeys[item.memberKeys.length - 1]
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > PUBLIC_EPG_LIMITS.maxTaxonomyPageBytes) return false;
  let previous = "";
  for (const key of item.memberKeys) {
    if (!validTaxonomyMemberKey(key) || previous && previous >= key) return false;
    previous = key;
  }
  return true;
}

export function validPublicTaxonomyRoot(value: unknown): value is DirectoryRoot & { kind: "taxonomy-root"; vocabulary: PublicTaxonomyVocabulary } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4
    || Object.keys(item).some((key) => !["schemaVersion", "kind", "entries", "vocabulary"].includes(key))
    || item.schemaVersion !== PUBLIC_EPG_SCHEMA_VERSION || item.kind !== "taxonomy-root"
    || !Array.isArray(item.entries) || item.entries.length > 16
    || !item.vocabulary || typeof item.vocabulary !== "object" || Array.isArray(item.vocabulary)) return false;
  const vocabulary = item.vocabulary as Record<string, unknown>;
  if (Object.keys(vocabulary).length !== 3
    || Object.keys(vocabulary).some((key) => !["language", "category", "country"].includes(key))) return false;
  let vocabularyCount = 0;
  for (const dimension of ["language", "category", "country"] as const) {
    const values = vocabulary[dimension];
    if (!Array.isArray(values)) return false;
    vocabularyCount += values.length;
    if (vocabularyCount > 2_000) return false;
    let previous = "";
    for (const value of values) {
      if (!validTaxonomyValue(dimension, value) || previous && previous >= value) return false;
      previous = value;
    }
  }
  let previousPrefix = "";
  for (const raw of item.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const child = raw as Record<string, unknown>;
    if (Object.keys(child).length !== 2 || Object.keys(child).some((key) => !["prefix", "ref"].includes(key))
      || typeof child.prefix !== "string" || !/^[a-f0-9]$/u.test(child.prefix) || previousPrefix && previousPrefix >= child.prefix
      || !validArtifactRef(child.ref)) return false;
    const ref = child.ref as ArtifactRef;
    if (ref.bytes < 1 || ref.bytes > PUBLIC_EPG_LIMITS.maxTaxonomyPostingBytes
      || ref.compressedBytes < 1 || ref.compressedBytes > PUBLIC_EPG_LIMITS.maxTaxonomyPostingBytes
      || ref.key !== `${PUBLIC_EPG_PREFIX}objects/${ref.sha256}.json.gz`) return false;
    previousPrefix = child.prefix;
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= PUBLIC_EPG_LIMITS.maxRootUncompressedBytes;
}

export async function nameDirectoryHash(term: string): Promise<string> {
  return sha256Hex(term);
}

export function validArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === "string" && SAFE_KEY.test(item.key)
    && typeof item.sha256 === "string" && DIGEST.test(item.sha256)
    && Number.isSafeInteger(item.bytes) && Number(item.bytes) >= 0
    && Number.isSafeInteger(item.compressedBytes) && Number(item.compressedBytes) >= 0;
}

export function validCurrentPointer(value: unknown): value is CurrentPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === PUBLIC_EPG_SCHEMA_VERSION
    && typeof item.revision === "string" && DIGEST.test(item.revision)
    && typeof item.manifestKey === "string" && SAFE_KEY.test(item.manifestKey)
    && item.manifestKey === `${PUBLIC_EPG_PREFIX}manifests/${item.manifestSha256}.json`
    && typeof item.manifestSha256 === "string" && DIGEST.test(item.manifestSha256);
}

export function validManifest(value: unknown): value is PublicEpgManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const legacy = item.schemaVersion === PUBLIC_EPG_LEGACY_MANIFEST_VERSION;
  const current = item.schemaVersion === PUBLIC_EPG_MANIFEST_VERSION;
  return (legacy || current)
    && typeof item.revision === "string" && DIGEST.test(item.revision)
    && (item.channelMetadataRevision === undefined
      || typeof item.channelMetadataRevision === "string" && DIGEST.test(item.channelMetadataRevision))
    && typeof item.generatedAt === "string" && Number.isFinite(Date.parse(item.generatedAt))
    && (item.previousRevision === null || (typeof item.previousRevision === "string" && DIGEST.test(item.previousRevision)))
    && (item.indexInputDigest === undefined || typeof item.indexInputDigest === "string" && DIGEST.test(item.indexInputDigest))
    && validManifestSourceStatuses(item.sources, current)
    && validArtifactRef(item.identityRoot)
    && validArtifactRef(item.nameRoot)
    && (legacy ? item.programmeRoot === undefined : validArtifactRef(item.programmeRoot))
    && (item.streamsRoot === undefined || validArtifactRef(item.streamsRoot))
    && (item.accessRoot === undefined || validArtifactRef(item.accessRoot))
    && (item.metadataNameRoot === undefined || validArtifactRef(item.metadataNameRoot))
    && (item.metadataSuggestionRoot === undefined || validArtifactRef(item.metadataSuggestionRoot))
    && (item.taxonomyRoot === undefined || validArtifactRef(item.taxonomyRoot));
}

function validManifestSourceStatuses(value: unknown, requireFixedRegistry: boolean): value is PublicEpgSourceStatus[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  const known = new Set<string>([...PUBLIC_EPG_SOURCE_IDS, ...PUBLIC_EPG_METADATA_SOURCE_IDS]);
  const rows = new Map<string, Record<string, unknown>>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    if (typeof row.sourceID !== "string" || row.sourceID.length > 160
      || (requireFixedRegistry && !known.has(row.sourceID))
      || rows.has(row.sourceID)
      || !(row.sourceRevision === null || typeof row.sourceRevision === "string" && DIGEST.test(row.sourceRevision))
      || !(row.status === "ready" || row.status === "stale" || row.status === "unavailable")
      || !(row.lastGoodAt === null || typeof row.lastGoodAt === "string" && Number.isFinite(Date.parse(row.lastGoodAt)))) return false;
    rows.set(row.sourceID, row);
  }
  if (!requireFixedRegistry) return true;
  if (PUBLIC_EPG_SOURCE_IDS.some((sourceID) => !rows.has(sourceID))) return false;
  const requiredMetadata = PUBLIC_EPG_METADATA_SOURCE_IDS.filter((sourceID) => sourceID !== "iptv-org:logos");
  return requiredMetadata.every((sourceID) => rows.has(sourceID));
}
