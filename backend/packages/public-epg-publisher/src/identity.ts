import {
  PUBLIC_EPG_LIMITS,
  PUBLIC_EPG_METADATA_COMPACT_PREFIX,
  identityKey,
  normalizePublicName,
  publicNameGrams,
  validPublicCategoryIDs,
  validPublicChannelLanguages,
  validPublicCountryCode,
  type NameBucketEntry,
  type PublicChannelCandidate,
  type PublicChannelIdentity,
  type PublicChannelProjection,
  type MetadataSuggestionBucketEntry,
  type PublicIdentityEntry,
  type PublicProgrammeRelation
} from "@vocaltv/public-epg-contract";
import type { XMLTVChannel } from "./xmltv.js";

export type ChannelSeed = {
  logoURL?: string;
  identity: PublicChannelIdentity;
  canonicalName: string;
  feedName: string | null;
  name: string;
  aliases: string[];
  metadataNameAliases: string[];
  languages: string[];
  broadcastAreas: string[];
  timezones: string[];
  country: string | null;
  categoryIDs: string[];
  channelLanguages: string[];
};

export type NameEntryRecord = { term: string; candidates: PublicChannelCandidate[]; ambiguous: boolean };
export type MatchedXMLTVChannel = { seed: ChannelSeed; channel: XMLTVChannel; matchRank: number };

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;

// Identity admission must match the public candidate contract. Never truncate
// an upstream ID: doing so can alias two different channels or Feeds.
function publicID(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return SAFE_ID.test(id) ? id : "";
}
const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const UTF8_ENCODER = new TextEncoder();
const COUNTRY_CODE = /^[A-Z]{2}$/u;
const ISO3_LANGUAGE = /^[A-Za-z]{3}$/u;
const NON_FACT_LANGUAGES = new Set(["und", "mul", "zxx"]);
const INVALID_LANGUAGE_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_PUBLIC_CATEGORIES = 512;

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.trim().replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum)
    : "";
}

function boundedList(value: unknown, maxItems: number, maxLength = 256): string[] {
  if (!Array.isArray(value)) return [];
  const output = new Set<string>();
  for (const item of value) {
    const candidate = boundedText(item, maxLength);
    if (candidate) output.add(candidate);
    if (output.size >= maxItems) break;
  }
  return [...output];
}

function normalizedSingleFeedLanguage(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const raw = value[0];
  if (typeof raw !== "string" || raw.length > 32 || INVALID_LANGUAGE_TEXT.test(raw)) return null;
  const normalized = raw.trim().toLowerCase();
  return ISO3_LANGUAGE.test(normalized) && !NON_FACT_LANGUAGES.has(normalized) ? normalized : null;
}

function requireDataset(value: unknown, maxItems: number, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name}_dataset_invalid`);
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

/** Index only currently used, supported bitmap Logos at their exact identity. */
export function publicLogoURLs(logosJSON: unknown): Map<string, string> {
  const rows = requireDataset(logosJSON, 300_000, "logos");
  const selected = new Map<string, { url: string; distance: number }>();
  for (const row of rows) {
    const channelID = publicID(row.channel);
    const feedID = row.feed == null ? null : publicID(row.feed);
    if (!channelID || (row.feed != null && !feedID) || row.in_use !== true
      || typeof row.format !== "string" || !/^(PNG|JPEG|JPG|WEBP|AVIF|APNG|GIF)$/iu.test(row.format)
      || typeof row.url !== "string" || row.url.length > 4096) continue;
    let url: URL;
    try { url = new URL(row.url); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) continue;
    const key = identityKey({ channelID, feedID });
    const size = Math.max(Number(row.width) || 0, Number(row.height) || 0);
    const distance = size > 0 ? Math.abs(size - 512) : 1e9;
    const previous = selected.get(key);
    if (!previous || distance < previous.distance || (distance === previous.distance && url.href < previous.url)) {
      selected.set(key, { url: url.href, distance });
    }
  }
  return new Map([...selected].map(([key, value]) => [key, value.url]));
}

export function buildChannelSeeds(
  channelsJSON: unknown,
  feedsJSON: unknown,
  categoriesJSON: unknown = [],
  logosJSON: unknown = []
): ChannelSeed[] {
  const logoURLs = publicLogoURLs(logosJSON);
  const channelRows = requireDataset(channelsJSON, 100_000, "channels");
  const feedRows = requireDataset(feedsJSON, 200_000, "feeds");
  const categoryRows = requireDataset(categoriesJSON, MAX_PUBLIC_CATEGORIES, "categories");
  const knownCategoryIDs = new Set<string>();
  for (const row of categoryRows) {
    const categoryID = boundedText(row.id, 64);
    if (CATEGORY_ID.test(categoryID)) knownCategoryIDs.add(categoryID);
  }
  const channels = new Map<string, {
    name: string;
    aliases: string[];
    country: string | null;
    categoryIDs: string[];
  }>();
  for (const row of channelRows) {
    const id = publicID(row.id), name = boundedText(row.name, 256);
    if (!SAFE_ID.test(id) || !name) continue;
    const countryText = boundedText(row.country, 4).toUpperCase();
    const country = COUNTRY_CODE.test(countryText) && validPublicCountryCode(countryText)
      ? countryText
      : null;
    const categoryIDs: string[] = [];
    for (const categoryID of boundedList(row.categories, 64, 64)) {
      if (CATEGORY_ID.test(categoryID) && knownCategoryIDs.has(categoryID)
        && !categoryIDs.includes(categoryID)) {
        categoryIDs.push(categoryID);
      }
      if (categoryIDs.length === PUBLIC_EPG_LIMITS.maxChannelCategoryIDs) break;
    }
    if (!validPublicCategoryIDs(categoryIDs)) throw new Error("channel_categories_invalid");
    const value = {
      name,
      aliases: boundedList(row.alt_names, 32),
      country,
      categoryIDs
    };
    const prior = channels.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error("channels_duplicate_identity_conflict");
    channels.set(id, value);
  }
  const channelLanguageConsensus = new Map<string, { language: string | null; unanimous: boolean }>();
  for (const row of feedRows) {
    const channelID = publicID(row.channel);
    if (!SAFE_ID.test(channelID) || !channels.has(channelID)) continue;
    const language = normalizedSingleFeedLanguage(row.languages);
    const previous = channelLanguageConsensus.get(channelID);
    if (!previous) {
      channelLanguageConsensus.set(channelID, { language, unanimous: language !== null });
    } else if (!language || !previous.unanimous || previous.language !== language) {
      channelLanguageConsensus.set(channelID, { language: null, unanimous: false });
    }
  }
  const channelLanguagesFor = (channelID: string): string[] => {
    const consensus = channelLanguageConsensus.get(channelID);
    const languages = consensus?.unanimous && consensus.language ? [consensus.language] : [];
    if (!validPublicChannelLanguages(languages)) throw new Error("channel_languages_invalid");
    return languages;
  };
  const output: ChannelSeed[] = [];
  for (const [channelID, value] of channels) {
    output.push({
      identity: { provider: "iptv-org", channelID, feedID: null },
      logoURL: logoURLs.get(identityKey({ channelID, feedID: null })),
      canonicalName: value.name, feedName: null, name: value.name,
      aliases: value.aliases, metadataNameAliases: value.aliases,
      languages: [], broadcastAreas: [], timezones: [],
      country: value.country, categoryIDs: value.categoryIDs,
      channelLanguages: channelLanguagesFor(channelID)
    });
  }
  const feedIdentities = new Map<string, ChannelSeed>();
  for (const row of feedRows) {
    const feedID = publicID(row.id), channelID = publicID(row.channel), name = boundedText(row.name, 256);
    const channel = channels.get(channelID);
    if (!SAFE_ID.test(feedID) || !SAFE_ID.test(channelID) || !name || !channel) continue;
    // IPTV-org Feed IDs are not globally unique. Composite channel+Feed is
    // the only published identity; a bare Feed lookup remains ambiguous.
    const key = identityKey({ channelID, feedID });
    const feedName = name;
    const normalizedChannel = normalizePublicName(channel.name);
    const normalizedFeed = normalizePublicName(feedName);
    const displayName = normalizedChannel && normalizedFeed.startsWith(`${normalizedChannel} `)
      ? feedName
      : normalizedChannel === normalizedFeed ? channel.name : `${channel.name} ${feedName}`;
    const candidate: ChannelSeed = {
      identity: { provider: "iptv-org", channelID, feedID },
      logoURL: logoURLs.get(identityKey({ channelID, feedID }))
        ?? logoURLs.get(identityKey({ channelID, feedID: null })),
      canonicalName: channel.name,
      feedName,
      name: displayName,
      aliases: [...new Set([feedName, channel.name, ...channel.aliases, ...boundedList(row.alt_names, 32)])].slice(0, 32),
      metadataNameAliases: [...new Set([feedName, ...boundedList(row.alt_names, 32)])].slice(0, 32),
      languages: boundedList(row.languages, 32, 32),
      broadcastAreas: boundedList(row.broadcast_area, 64, 32),
      timezones: boundedList(row.timezones, 64, 64),
      country: channel.country,
      categoryIDs: channel.categoryIDs,
      channelLanguages: channelLanguagesFor(channelID)
    };
    const prior = feedIdentities.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(candidate)) throw new Error("feeds_duplicate_identity_conflict");
    feedIdentities.set(key, candidate);
  }
  output.push(...feedIdentities.values());
  return output.sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
}

export function buildNameIndex(seeds: readonly ChannelSeed[]): NameEntryRecord[] {
  return buildNameIndexWithGrams(seeds, true);
}

/** Exact and alias lookup for metadata completion, collapsed to canonical channel IDs. */
export function buildMetadataNameIndex(seeds: readonly ChannelSeed[]): NameEntryRecord[] {
  type Entry = { candidates: Map<string, PublicChannelCandidate>; ambiguous: boolean };
  const terms = new Map<string, Entry>();
  const add = (term: string, seed: ChannelSeed, matchKind: "exact" | "alias") => {
    if (!term) return;
    let entry = terms.get(term);
    if (!entry) {
      if (terms.size >= PUBLIC_EPG_LIMITS.maxMetadataNameTerms) throw new Error("metadata_name_term_budget_exceeded");
      entry = { candidates: new Map(), ambiguous: false };
      terms.set(term, entry);
    }
    if (entry.ambiguous) return;
    const candidate: PublicChannelCandidate = {
      provider: "iptv-org",
      channelID: seed.identity.channelID,
      feedID: null,
      matchKind
    };
    const previous = entry.candidates.get(seed.identity.channelID);
    if (previous) {
      if (previous.matchKind === "alias" && matchKind === "exact") {
        entry.candidates.set(seed.identity.channelID, candidate);
      }
      return;
    }
    if (entry.candidates.size >= PUBLIC_EPG_LIMITS.maxMetadataNameCandidates) {
      entry.candidates.clear();
      entry.ambiguous = true;
      return;
    }
    entry.candidates.set(seed.identity.channelID, candidate);
  };
  for (const seed of seeds) {
    const exactName = normalizePublicName(seed.name);
    const labels = new Map<string, "exact" | "alias">();
    for (const label of [seed.name, ...seed.metadataNameAliases]) {
      // Feed names and aliases are not necessarily present on the canonical
      // channel row used by the reader to verify a signed offset. Omitting
      // these labels prevents normalizePublicName from erasing +1/-1 and
      // making a Feed alias look like an unshifted channel name. Channel-row
      // labels remain available to native raw-label verification.
      if (seed.identity.feedID !== null && hasExplicitNumericShift(label)) continue;
      const term = normalizePublicName(label);
      if (!term) continue;
      const kind = term === exactName ? "exact" : "alias";
      if (kind === "exact" || !labels.has(term)) labels.set(term, kind);

      // Compact matching is metadata-only. Keep the original exact/alias term
      // intact and route this generic whitespace variant through a separate
      // namespace so it cannot override an exact-name posting. Do not erase an
      // explicit signed number: it may be a time-shift offset (+1/-1).
      const compact = compactMetadataNameTerm(label);
      if (compact) add(compact, seed, "alias");
    }
    for (const [term, matchKind] of labels) add(term, seed, matchKind);
  }
  return [...terms.entries()].map(([term, entry]) => ({
    term,
    candidates: entry.ambiguous
      ? []
      : [...entry.candidates.values()].sort((left, right) => identityKey(left).localeCompare(identityKey(right))),
    ambiguous: entry.ambiguous
  })).sort((left, right) => left.term.localeCompare(right.term));
}

/** Build a distinct fuzzy suggestion index from public channel names only.
 * It contains no Feed identities and is never queried by automatic attribute
 * resolution. */
export function buildMetadataNameSuggestionIndex(
  seeds: readonly ChannelSeed[]
): MetadataSuggestionBucketEntry[] {
  const terms = new Map<string, {
    candidates: Map<string, PublicChannelCandidate>;
    ambiguous: boolean;
  }>();
  let pairs = 0;
  for (const seed of seeds) {
    if (seed.identity.feedID !== null) continue;
    const candidate: PublicChannelCandidate = {
      provider: "iptv-org", channelID: seed.identity.channelID,
      feedID: null, matchKind: "gram"
    };
    const grams = new Set<string>();
    for (const label of [seed.name, ...seed.aliases]) {
      if (/[+\-\u2212]\s*\p{N}+/u.test(label.normalize("NFKC"))) continue;
      // Match the on-device UTF-16 gram contract; skip labels with surrogate
      // pairs because Swift intentionally refuses to route those grams.
      if ([...label].some((scalar) => scalar.codePointAt(0)! > 0xFFFF)) continue;
      for (const gram of publicNameGrams(label)) if (gram.length === 3) grams.add(gram);
    }
    for (const gram of [...grams].sort()) {
      const term = `fuzzy:${gram}`;
      let posting = terms.get(term);
      if (!posting) {
        if (terms.size >= PUBLIC_EPG_LIMITS.maxMetadataSuggestionTerms) throw new Error("metadata_suggestion_term_budget_exceeded");
        posting = { candidates: new Map(), ambiguous: false };
        terms.set(term, posting);
      }
      if (posting.ambiguous || posting.candidates.has(seed.identity.channelID)) continue;
      if (++pairs > PUBLIC_EPG_LIMITS.maxMetadataSuggestionTerms * 8) throw new Error("metadata_suggestion_posting_budget_exceeded");
      if (posting.candidates.size >= PUBLIC_EPG_LIMITS.maxMetadataSuggestionCandidates) {
        posting.candidates.clear();
        posting.ambiguous = true;
      } else {
        posting.candidates.set(seed.identity.channelID, candidate);
      }
    }
  }
  return [...terms.entries()].map(([term, posting]) => ({
    term,
    candidates: posting.ambiguous ? [] : [...posting.candidates.values()].sort((left, right) => identityKey(left).localeCompare(identityKey(right))),
    ambiguous: posting.ambiguous
  })).sort((left, right) => left.term.localeCompare(right.term));
}

/** Merge independent public-source postings; any overflowing source bucket fails closed. */
export function mergeMetadataSuggestionIndexes(
  ...indexes: readonly (readonly MetadataSuggestionBucketEntry[])[]
): MetadataSuggestionBucketEntry[] {
  const terms = new Map<string, { candidates: Map<string, MetadataSuggestionBucketEntry["candidates"][number]>; ambiguous: boolean }>();
  for (const entries of indexes) {
    for (const entry of entries) {
      let posting = terms.get(entry.term);
      if (!posting) {
        posting = { candidates: new Map(), ambiguous: false };
        terms.set(entry.term, posting);
      }
      if (entry.ambiguous) {
        posting.candidates.clear();
        posting.ambiguous = true;
        continue;
      }
      if (posting.ambiguous) continue;
      for (const candidate of entry.candidates) {
        const key = "sourceID" in candidate
          ? `wikidata:${candidate.itemID}`
          : `iptv-org:${candidate.channelID}`;
        const previous = posting.candidates.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) {
          posting.candidates.clear();
          posting.ambiguous = true;
          break;
        }
        posting.candidates.set(key, candidate);
        if (posting.candidates.size > PUBLIC_EPG_LIMITS.maxMetadataSuggestionCandidates) {
          posting.candidates.clear();
          posting.ambiguous = true;
          break;
        }
      }
    }
  }
  return [...terms.entries()].map(([term, posting]) => ({
    term,
    candidates: posting.ambiguous ? [] : [...posting.candidates.entries()]
      .sort(([left], [right]) => left.localeCompare(right)).map(([, candidate]) => candidate),
    ambiguous: posting.ambiguous
  })).sort((left, right) => left.term.localeCompare(right.term));
}

/** Metadata-only compact key shared by the publisher and native readers. */
export function compactMetadataNameTerm(value: string): string | null {
  if (hasExplicitNumericShift(value)) return null;
  const compact = normalizePublicName(value).replace(/\s+/gu, "");
  if (!compact) return null;
  const term = `${PUBLIC_EPG_METADATA_COMPACT_PREFIX}${compact}`;
  if (UTF8_ENCODER.encode(term).byteLength > 256) return null;
  return term;
}

function hasExplicitNumericShift(value: string): boolean {
  return /[+\-\u2212]\s*\p{N}+/u.test(value.normalize("NFKC"));
}

function buildNameIndexWithGrams(
  seeds: readonly ChannelSeed[],
  includeGrams: boolean,
  includeProjection = true
): NameEntryRecord[] {
  const candidates = new Map<string, { rank: number; rows: Map<string, PublicChannelCandidate>; ambiguous: boolean }>();
  const add = (term: string, seed: ChannelSeed, kind: PublicChannelCandidate["matchKind"], projection?: PublicChannelProjection) => {
    if (!term) return;
    const key = identityKey(seed.identity);
    const rank = (value: PublicChannelCandidate["matchKind"]) => value === "exact" ? 0 : value === "alias" ? 1 : 2;
    const candidateRank = rank(kind);
    const candidate = { ...seed.identity, matchKind: kind, ...(projection ? { projection } : {}) } satisfies PublicChannelCandidate;
    const entry = candidates.get(term);
    if (!entry || candidateRank < entry.rank) {
      candidates.set(term, { rank: candidateRank, rows: new Map([[key, candidate]]), ambiguous: false });
      return;
    }
    if (candidateRank > entry.rank || entry.rows.has(key) || entry.ambiguous) return;
    if (entry.rows.size >= PUBLIC_EPG_LIMITS.maxIndexedCandidates) {
      entry.rows.clear();
      entry.ambiguous = true;
      return;
    }
    entry.rows.set(key, candidate);
  };
  for (const seed of seeds) {
    // Name/alias hits can publish directly from the name tree. Gram postings
    // retain compact identity-only candidates to avoid repeating this metadata
    // for every lexical narrowing token.
    const projection: PublicChannelProjection | undefined = includeProjection ? {
      name: seed.name.slice(0, 256),
      canonicalName: seed.canonicalName.slice(0, 256),
      feedName: seed.feedName?.slice(0, 256) ?? null,
      aliases: seed.aliases.slice(0, 32).map((alias) => alias.slice(0, 256)),
      languages: seed.languages.slice(0, 32).map((language) => language.slice(0, 32)),
      broadcastAreas: seed.broadcastAreas.slice(0, 64).map((area) => area.slice(0, 64)),
      timezones: seed.timezones.slice(0, 64).map((timezone) => timezone.slice(0, 64)),
      ...(seed.country ? { country: seed.country } : {}),
      ...(seed.categoryIDs.length
        ? { categoryIDs: seed.categoryIDs.slice(0, PUBLIC_EPG_LIMITS.maxChannelCategoryIDs) }
        : {}),
      ...(seed.channelLanguages.length ? { channelLanguages: seed.channelLanguages.slice(0, 1) } : {})
    } : undefined;
    const labels = new Map<string, "exact" | "alias">();
    for (const label of [seed.name, ...seed.aliases]) {
      const term = normalizePublicName(label);
      if (!term) continue;
      const kind = term === normalizePublicName(seed.name) ? "exact" : "alias";
      if (kind === "exact" || !labels.has(term)) labels.set(term, kind);
    }
    for (const [term, kind] of labels) {
      add(term, seed, kind, projection);
      if (includeGrams) {
        for (const gram of publicNameGrams(term)) add(`gram:${gram}`, seed, "gram");
      }
    }
  }
  return [...candidates.entries()].map(([term, entry]) => {
    const ordered = [...entry.rows.values()].sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
    return {
      term,
      candidates: entry.ambiguous ? [] : ordered,
      ambiguous: entry.ambiguous
    };
  }).sort((left, right) => left.term.localeCompare(right.term));
}

export type IdentityResolver = {
  byID: Map<string, Array<{ seed: ChannelSeed; rank: number }>>;
  byName: Map<string, Array<{ seed: ChannelSeed; rank: number }>>;
};

export function buildIdentityResolver(seeds: readonly ChannelSeed[]): IdentityResolver {
  const byID = new Map<string, Array<{ seed: ChannelSeed; rank: number }>>();
  const byName = new Map<string, Array<{ seed: ChannelSeed; rank: number }>>();
  const add = (map: Map<string, Array<{ seed: ChannelSeed; rank: number }>>, key: string, seed: ChannelSeed, rank: number) => {
    const rows = map.get(key) ?? [];
    const bestRank = rows[0]?.rank;
    if (bestRank !== undefined && rank > bestRank) return;
    const id = identityKey(seed.identity);
    if (bestRank !== undefined && rank < bestRank) {
      map.set(key, [{ seed, rank }]);
      return;
    }
    if (rows.some((item) => identityKey(item.seed.identity) === id)) return;
    // Exact resolution only needs to distinguish one candidate from two or
    // more. Keep the list constant-size for heavily reused bare Feed IDs.
    if (rows.length < 2) rows.push({ seed, rank });
    map.set(key, rows);
  };
  for (const seed of seeds) {
    const { channelID, feedID } = seed.identity;
    if (!feedID) add(byID, channelID, seed, 0);
    else {
      add(byID, `${channelID}@${feedID}`, seed, 0);
      add(byID, feedID, seed, 1);
    }
    const exactName = normalizePublicName(seed.name);
    if (exactName) add(byName, exactName, seed, 2);
    for (const alias of seed.aliases) {
      const term = normalizePublicName(alias);
      if (term && term !== exactName) add(byName, term, seed, 3);
    }
  }
  return { byID, byName };
}

function uniqueBest(candidates: Array<{ seed: ChannelSeed; rank: number }>): { seed: ChannelSeed; rank: number } | null {
  if (!candidates.length) return null;
  const bestRank = candidates[0]!.rank;
  const bestByIdentity = new Map<string, ChannelSeed>();
  for (const item of candidates) {
    if (item.rank !== bestRank) break;
    bestByIdentity.set(identityKey(item.seed.identity), item.seed);
  }
  return bestByIdentity.size === 1 ? { seed: [...bestByIdentity.values()][0]!, rank: bestRank } : null;
}

export function matchXMLTVChannel(channel: XMLTVChannel, resolver: IdentityResolver): MatchedXMLTVChannel | null {
  const exactID = uniqueBest(resolver.byID.get(channel.id) ?? []);
  // Optional external metadata association requires the exact composite
  // channel/feed ID. Names and bare reusable Feed IDs are not source identity.
  if (!exactID || exactID.rank !== 0) return null;
  return { seed: exactID.seed, channel, matchRank: exactID.rank };
}

export function mergeIdentityEntry(seed: ChannelSeed, relations: readonly PublicProgrammeRelation[]): PublicIdentityEntry {
  const ordered = [...new Map(relations.map((relation) => [
    `${relation.sourceID}\u001f${relation.xmltvChannelID}`, relation
  ])).values()].sort((left, right) => left.sourcePriority - right.sourcePriority
    || left.sourceID.localeCompare(right.sourceID)
    || left.xmltvChannelID.localeCompare(right.xmltvChannelID));
  if (ordered.some((relation) => relation.days.length > 32
    || relation.days.some((day) => day.parts.length > 64))) {
    throw new Error("identity_day_budget_exceeded");
  }
  // The identity directory is a route index, not a second copy of every
  // programme shard. Keep all bounded source-local identity hints and let the
  // exact programmeRoot route supply date shards on demand. If a malformed or
  // future source exceeds the hint bound, omit this optional mapping surface
  // rather than publish a silently truncated identity relation set.
  const kept = ordered.length <= PUBLIC_EPG_LIMITS.maxIdentityRelations
    ? ordered.map((relation) => ({ ...relation, days: [] }))
    : [];
  return {
    ...seed.identity,
    ...(seed.logoURL ? { logoURL: seed.logoURL } : {}),
    canonicalName: seed.canonicalName,
    feedName: seed.feedName,
    name: seed.name,
    aliases: seed.aliases,
    languages: seed.languages,
    broadcastAreas: seed.broadcastAreas,
    timezones: seed.timezones,
    relations: kept,
    ...(seed.country ? { country: seed.country } : {}),
    ...(seed.categoryIDs.length
      ? { categoryIDs: seed.categoryIDs.slice(0, PUBLIC_EPG_LIMITS.maxChannelCategoryIDs) }
      : {}),
    ...(seed.channelLanguages.length ? { channelLanguages: seed.channelLanguages.slice(0, 1) } : {})
  };
}

export function nameCandidateKey(identity: PublicChannelIdentity): string {
  return `${identity.provider}\u001f${identityKey(identity)}`;
}
