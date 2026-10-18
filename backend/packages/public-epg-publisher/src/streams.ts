import {
  PUBLIC_EPG_LIMITS,
  identityKey,
  taxonomyMemberKey,
  validPublicHTTPURL,
  validPublicAccessEntry,
  validPublicStreamsEntry,
  validPublicCategoryIDs,
  validPublicChannelLanguages,
  validPublicCountryCode,
  type PublicStream,
  type PublicAccessEntry,
  type PublicAccessMember,
  type PublicStreamsEntry,
  type PublicIdentityEntry,
  type PublicTaxonomyDimension,
  type PublicTaxonomyVocabulary
} from "@vocaltv/public-epg-contract";
import { sha256, stableJSON } from "./encoding.js";
import type { ChannelSeed } from "./identity.js";

const MAX_STREAM_ROWS = 500_000;
const PUBLIC_ACCESS_DOMAIN = "vocaltv-public-access";
/** Bump when access digest framing or reverse-index admission rules change. */
export const PUBLIC_ACCESS_INDEX_VERSION = 1 as const;
const STREAM_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bounded(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || CONTROL.test(candidate) || byteLength(candidate) > maximum) return null;
  return candidate;
}

function cleanLabels(value: unknown): string[] | null {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/[;,]/u) : [];
  const labels: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") return null;
    const item = raw.trim();
    if (!item || CONTROL.test(item)) return null;
    if (byteLength(item) <= 128 && !labels.includes(item)) labels.push(item);
    if (labels.length === 32) break;
  }
  return labels;
}

function streamID(raw: Record<string, unknown>): string {
  const supplied = bounded(raw.id ?? raw.slug, 128);
  if (supplied && STREAM_ID.test(supplied)) return supplied;
  return `row-${sha256(stableJSON(raw)).slice(0, 40)}`;
}

function publicURL(value: unknown): string | null {
  if (typeof value !== "string" || !validPublicHTTPURL(value)) return null;
  try {
    const url = new URL(value);
    return url.toString();
  } catch { return null; }
}

function uint32BE(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("public_access_field_too_large");
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function framedUTF8(value: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(value);
  return [uint32BE(bytes.byteLength), bytes];
}

/**
 * Versioned, delimiter-safe identity for an effective public playback route.
 * The URL string is the admitted URL after the same URL serialization used by
 * the public stream artifact. Only effective Referer and User-Agent headers
 * participate; values are already bounded, control-free, and trimmed by the
 * stream admission path.
 */
export function publicAccessDigest(stream: Pick<PublicStream, "url" | "referrer" | "userAgent">): string {
  const headers = [
    ...(stream.referrer ? [["referer", stream.referrer] as const] : []),
    ...(stream.userAgent ? [["user-agent", stream.userAgent.trim()] as const] : [])
  ].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const chunks: Uint8Array[] = [
    ...framedUTF8(PUBLIC_ACCESS_DOMAIN),
    uint32BE(PUBLIC_ACCESS_INDEX_VERSION),
    ...framedUTF8(stream.url),
    uint32BE(headers.length)
  ];
  for (const [name, value] of headers) chunks.push(...framedUTF8(name), ...framedUTF8(value));
  return sha256(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function compareMembers(left: PublicAccessMember, right: PublicAccessMember): number {
  const channelOrder = left.channelID < right.channelID ? -1 : left.channelID > right.channelID ? 1 : 0;
  if (channelOrder) return channelOrder;
  const leftFeed = left.feedID ?? "", rightFeed = right.feedID ?? "";
  return leftFeed < rightFeed ? -1 : leftFeed > rightFeed ? 1 : 0;
}

/** Build a bounded public access reverse index from already-admitted stream rows. */
export function buildPublicAccessIndex(streamEntries: readonly PublicStreamsEntry[]): {
  entries: PublicAccessEntry[];
  accessDigestCount: number;
  accessMemberCount: number;
  accessAmbiguousCount: number;
} {
  const rows = new Map<string, Map<string, PublicAccessMember>>();
  let streamCount = 0;
  for (const entry of streamEntries) {
    if (!validPublicStreamsEntry(entry)) throw new Error("streams_dataset_invalid");
    for (const stream of entry.streams) {
      if (++streamCount > MAX_STREAM_ROWS) throw new Error("streams_dataset_invalid");
      const digest = publicAccessDigest(stream);
      const members = rows.get(digest) ?? new Map<string, PublicAccessMember>();
      const member = { channelID: entry.channelID, feedID: entry.feedID };
      members.set(identityKey(member), member);
      rows.set(digest, members);
    }
  }
  let accessMemberCount = 0;
  let accessAmbiguousCount = 0;
  const entries = [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([accessDigest, byIdentity]) => {
    const allMembers = [...byIdentity.values()].sort(compareMembers);
    const ambiguous = allMembers.length > PUBLIC_EPG_LIMITS.maxPublicAccessMembersPerDigest;
    if (ambiguous) accessAmbiguousCount += 1;
    else accessMemberCount += allMembers.length;
    const entry: PublicAccessEntry = {
      accessDigest,
      members: ambiguous ? [] : allMembers,
      ambiguous
    };
    if (!validPublicAccessEntry(entry)) throw new Error("public_access_entry_invalid");
    return entry;
  });
  return { entries, accessDigestCount: entries.length, accessMemberCount, accessAmbiguousCount };
}

/** Check that a published access directory is the complete reverse projection of its stream directory. */
export function publicAccessGraphMatches(
  streamEntries: readonly PublicStreamsEntry[],
  indexedEntries: readonly { hash: string; value: PublicAccessEntry }[]
): boolean {
  const expected = buildPublicAccessIndex(streamEntries).entries;
  const actual = new Map<string, PublicAccessEntry>();
  for (const row of indexedEntries) {
    if (!validPublicAccessEntry(row.value) || row.hash !== row.value.accessDigest || actual.has(row.value.accessDigest)) return false;
    actual.set(row.value.accessDigest, row.value);
  }
  return actual.size === expected.length && expected.every((entry) =>
    stableJSON(actual.get(entry.accessDigest) ?? null) === stableJSON(entry));
}

export type PublicTaxonomyPostingSeed = {
  dimension: PublicTaxonomyDimension;
  value: string;
  memberKeys: string[];
};

export type PublicTaxonomyIndex = {
  postings: PublicTaxonomyPostingSeed[];
  vocabulary: PublicTaxonomyVocabulary;
  postingCount: number;
  memberCount: number;
};

const TAXONOMY_DIMENSIONS: readonly PublicTaxonomyDimension[] = ["category", "country", "language"];

/**
 * Build complete typed postings from the existing full public identity rows.
 * Channel rows use the published unanimous single-language fact; Feed rows use
 * only their own validated ISO-639-3 language codes. No route data is read.
 */
export function buildPublicTaxonomyIndex(identities: readonly PublicIdentityEntry[]): PublicTaxonomyIndex {
  if (identities.length > 300_000) throw new Error("taxonomy_identity_budget_exceeded");
  const postings = new Map<string, Set<string>>();
  const vocabulary = {
    language: new Set<string>(),
    category: new Set<string>(),
    country: new Set<string>()
  };
  const seenIdentities = new Set<string>();
  let memberCount = 0;
  const add = (dimension: PublicTaxonomyDimension, value: string, memberKey: string): void => {
    const key = `${dimension}\u001f${value}`;
    let members = postings.get(key);
    if (!members) {
      if (postings.size >= PUBLIC_EPG_LIMITS.maxPublicTaxonomyPostings) throw new Error("taxonomy_posting_budget_exceeded");
      members = new Set<string>();
      postings.set(key, members);
    }
    if (!members.has(memberKey)) {
      members.add(memberKey);
      if (++memberCount > PUBLIC_EPG_LIMITS.maxPublicTaxonomyMemberships) throw new Error("taxonomy_membership_budget_exceeded");
    }
    vocabulary[dimension].add(value);
  };

  for (const identity of identities) {
    if (!identity || identity.provider !== "iptv-org" || !/^[A-Za-z0-9._-]{1,128}$/u.test(identity.channelID)
      || !(identity.feedID === null || typeof identity.feedID === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(identity.feedID))) {
      throw new Error("taxonomy_identity_invalid");
    }
    const identityID = identityKey(identity);
    if (seenIdentities.has(identityID)) throw new Error("taxonomy_identity_duplicate");
    seenIdentities.add(identityID);
    const memberKey = taxonomyMemberKey(identity);
    const categories = identity.categoryIDs ?? [];
    if (!validPublicCategoryIDs(categories)
      || identity.country != null && !validPublicCountryCode(identity.country)
      || identity.channelLanguages !== undefined && !validPublicChannelLanguages(identity.channelLanguages)) {
      throw new Error("taxonomy_identity_metadata_invalid");
    }
    for (const category of categories) add("category", category, memberKey);
    if (identity.country) add("country", identity.country, memberKey);
    const languages = identity.feedID === null ? identity.channelLanguages ?? [] : identity.languages;
    if (!Array.isArray(languages) || languages.length > 32) throw new Error("taxonomy_identity_languages_invalid");
    for (const rawLanguage of languages) {
      if (typeof rawLanguage !== "string" || rawLanguage.length > 32) continue;
      const language = rawLanguage.trim().toLowerCase();
      if (/^[a-z]{3}$/u.test(language) && validPublicChannelLanguages([language])) {
        add("language", language, memberKey);
      }
    }
  }

  const sortedVocabulary = Object.fromEntries(TAXONOMY_DIMENSIONS.map((dimension) => [
    dimension, [...vocabulary[dimension]].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  ])) as PublicTaxonomyVocabulary;
  const vocabularyCount = TAXONOMY_DIMENSIONS.reduce((total, dimension) => total + sortedVocabulary[dimension].length, 0);
  if (vocabularyCount > 2_000) throw new Error("taxonomy_vocabulary_budget_exceeded");

  const rows: PublicTaxonomyPostingSeed[] = [];
  for (const [key, members] of postings) {
    const separator = key.indexOf("\u001f");
    const dimension = key.slice(0, separator) as PublicTaxonomyDimension;
    const value = key.slice(separator + 1);
    rows.push({ dimension, value, memberKeys: [...members].sort((left, right) => left < right ? -1 : left > right ? 1 : 0) });
  }
  rows.sort((left, right) => left.dimension < right.dimension ? -1 : left.dimension > right.dimension ? 1
    : left.value < right.value ? -1 : left.value > right.value ? 1 : 0);
  return { postings: rows, vocabulary: sortedVocabulary, postingCount: rows.length, memberCount };
}

function optionalHeader(value: unknown, maximum: number): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (CONTROL.test(candidate) || byteLength(candidate) > maximum) return null;
  return candidate || undefined;
}

function streamFromRow(raw: Record<string, unknown>, channelID: string, feedID: string | null): PublicStream | null {
  const url = publicURL(raw.url);
  if (!url) return null;
  const id = streamID(raw);
  const title = bounded(raw.title, 256) ?? id;
  const referrerValue = raw.referrer ?? raw.http_referrer;
  const referrer = referrerValue === undefined || referrerValue === null || referrerValue === ""
    ? undefined
    : publicURL(referrerValue);
  if (referrerValue !== undefined && referrerValue !== null && referrerValue !== "" && !referrer) return null;
  const userAgent = optionalHeader(raw.user_agent ?? raw.userAgent, 512);
  const quality = optionalHeader(raw.quality ?? raw.resolution ?? raw.bitrate, 64);
  const labels = cleanLabels(raw.labels ?? raw.categories);
  if (userAgent === null || quality === null || !labels) return null;
  const result: PublicStream = {
    streamId: id,
    providerChannelId: channelID,
    ...(feedID ? { feedId: feedID } : {}),
    title,
    url,
    ...(referrer ? { referrer } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(quality ? { quality } : {}),
    labels
  };
  return validPublicStreamsEntry({ channelID, feedID, streams: [result] }) ? result : null;
}

export function buildPublicStreams(value: unknown, seeds: readonly ChannelSeed[]): {
  entries: PublicStreamsEntry[];
  playableIdentityKeys: Set<string>;
} {
  if (!Array.isArray(value) || value.length > MAX_STREAM_ROWS) throw new Error("streams_dataset_invalid");
  const known = new Set(seeds.map((seed) => identityKey(seed.identity)));
  const rows = new Map<string, Map<string, PublicStream>>();
  const conflicts = new Map<string, Set<string>>();

  for (const item of value) {
    if (!isRecord(item)) continue;
    const channelID = bounded(item.channel, 128);
    const feedText = item.feed === undefined || item.feed === null || item.feed === "" ? null : bounded(item.feed, 128);
    if (!channelID || !/^[A-Za-z0-9._-]{1,128}$/u.test(channelID)
      || (item.feed !== undefined && item.feed !== null && item.feed !== "" && !feedText)
      || (feedText !== null && !/^[A-Za-z0-9._-]{1,128}$/u.test(feedText))) continue;
    const feedID = feedText;
    const key = identityKey({ channelID, feedID });
    if (!known.has(key)) continue;
    const stream = streamFromRow(item, channelID, feedID);
    if (!stream) continue;
    const ids = rows.get(key) ?? new Map<string, PublicStream>();
    const rejected = conflicts.get(key) ?? new Set<string>();
    if (rejected.has(stream.streamId)) continue;
    const previous = ids.get(stream.streamId);
    if (previous && stableJSON(previous) !== stableJSON(stream)) {
      ids.delete(stream.streamId);
      rejected.add(stream.streamId);
      conflicts.set(key, rejected);
      rows.set(key, ids);
      continue;
    }
    if (!previous) ids.set(stream.streamId, stream);
    rows.set(key, ids);
  }

  const entries: PublicStreamsEntry[] = [];
  for (const [key, values] of rows) {
    const [channelID, feedID] = key.split("\u001f");
    if (!channelID || !values.size) continue;
    const streams = [...values.values()].sort((left, right) =>
      (right.quality ?? "").localeCompare(left.quality ?? "") || left.streamId.localeCompare(right.streamId)
    ).slice(0, 32);
    const entry: PublicStreamsEntry = { channelID, feedID: feedID || null, streams };
    if (validPublicStreamsEntry(entry)) entries.push(entry);
  }
  entries.sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
  return {
    entries,
    playableIdentityKeys: new Set(entries.map((entry) => identityKey(entry)))
  };
}
