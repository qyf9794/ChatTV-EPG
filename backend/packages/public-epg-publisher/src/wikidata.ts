import {
  PUBLIC_EPG_LIMITS,
  PUBLIC_METADATA_SUGGESTION_CATEGORY_IDS,
  normalizePublicName,
  publicNameGrams,
  validMetadataSuggestionCandidate,
  type PublicMetadataSuggestionCandidate,
  type MetadataSuggestionBucketEntry
} from "@vocaltv/public-epg-contract";

/** Fixed Wikidata class export. It never includes user, playlist, or channel-query data. */
export const WIKIDATA_QUERY_URL = "https://query.wikidata.org/sparql";
export const WIKIDATA_REQUEST_TIMEOUT_MS = 12_000;
export const WIKIDATA_USER_AGENT = "VocalTV-public-metadata/1.0 (https://chattv.bqxb.org/)";

export const WIKIDATA_TV_CHANNEL_QUERY = `
SELECT ?item ?itemLabel
       (GROUP_CONCAT(DISTINCT STR(?countryCode); separator="|") AS ?countryCodes)
       (GROUP_CONCAT(DISTINCT STR(?languageCode); separator="|") AS ?languageCodes)
       (GROUP_CONCAT(DISTINCT STR(?genreLabel); separator="|") AS ?genreLabels)
       (GROUP_CONCAT(DISTINCT STR(?alias); separator="|") AS ?aliases)
WHERE {
  VALUES ?channelClass { wd:Q2001305 wd:Q1616075 }
  ?item wdt:P31 ?channelClass.
  OPTIONAL { ?item wdt:P17 ?country. ?country wdt:P297 ?countryCode. }
  OPTIONAL { ?item wdt:P2936 ?language. ?language wdt:P218 ?languageCode. }
  OPTIONAL {
    ?item wdt:P136 ?genre.
    ?genre rdfs:label ?genreLabel.
    FILTER(LANG(?genreLabel) = "en")
  }
  OPTIONAL {
    ?item skos:altLabel ?alias.
    FILTER(LANG(?alias) = "en")
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?item ?itemLabel
ORDER BY ?item
LIMIT ${PUBLIC_EPG_LIMITS.maxWikidataSuggestionEntities}
`.trim();

type BindingValue = { type?: unknown; value?: unknown };
type WikidataBinding = Record<string, BindingValue>;

function text(value: BindingValue | undefined, maximum: number): string | null {
  if (!value || typeof value.value !== "string") return null;
  const result = value.value.trim();
  if (!result || new TextEncoder().encode(result).byteLength > maximum
    || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) return null;
  return result;
}

function splitValues(value: BindingValue | undefined, maximum: number): string[] | null {
  if (!value || value.value === undefined || value.value === "") return [];
  if (typeof value.value !== "string" || new TextEncoder().encode(value.value).byteLength > 16_384) return null;
  const values = [...new Set(value.value.split("|").map((item) => item.trim()).filter(Boolean))].sort();
  if (values.length > maximum) return null;
  return values;
}

function itemID(value: BindingValue | undefined): string | null {
  const raw = value?.value;
  if (typeof raw !== "string") return null;
  const match = /^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9][0-9]{0,12})$/u.exec(raw);
  return match?.[1] ?? null;
}

const SUGGESTED_CATEGORY_IDS = new Set<string>(PUBLIC_METADATA_SUGGESTION_CATEGORY_IDS);

function categoryID(label: string): string | null {
  const slug = label.normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return SUGGESTED_CATEGORY_IDS.has(slug) ? slug : null;
}

function normalizedCountry(values: string[] | null): string | undefined {
  if (!values || values.length !== 1) return undefined;
  const country = values[0]!.toUpperCase();
  return /^[A-Z]{2}$/u.test(country) ? country : undefined;
}

function normalizedLanguages(values: string[] | null): string[] | undefined {
  if (!values || values.length === 0 || values.length > 4) return undefined;
  const languages = values.map((value) => value.toLowerCase());
  if (languages.some((value) => !/^[a-z]{2,3}$/u.test(value))) return undefined;
  return [...new Set(languages)].sort();
}

function normalizedCategories(values: string[] | null): string[] | undefined {
  if (!values || values.length === 0 || values.length > 8) return undefined;
  const categories = [...new Set(values.map(categoryID).filter((value): value is string => value !== null))].sort();
  return categories.length > 0 && categories.length <= 16 ? categories : undefined;
}

/** Parse one capped SPARQL result page and reject malformed/incomplete rows. */
export function parseWikidataSuggestionResults(value: unknown): PublicMetadataSuggestionCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("wikidata_results_invalid");
  const results = (value as Record<string, unknown>).results;
  if (!results || typeof results !== "object" || Array.isArray(results)) throw new Error("wikidata_results_invalid");
  const bindings = (results as Record<string, unknown>).bindings;
  if (!Array.isArray(bindings) || bindings.length === 0
    || bindings.length > PUBLIC_EPG_LIMITS.maxWikidataSuggestionEntities) throw new Error("wikidata_results_invalid");

  const candidates: PublicMetadataSuggestionCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of bindings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("wikidata_binding_invalid");
    const binding = raw as WikidataBinding;
    const id = itemID(binding.item);
    const name = text(binding.itemLabel, 256);
    if (!id || !name || seen.has(id)) throw new Error("wikidata_binding_invalid");
    seen.add(id);

    const countryValues = splitValues(binding.countryCodes, 8);
    const languageValues = splitValues(binding.languageCodes, 16);
    const genreValues = splitValues(binding.genreLabels, 8);
    const aliasValues = splitValues(binding.aliases, 64);
    if (!countryValues || !languageValues || !genreValues || !aliasValues) throw new Error("wikidata_field_invalid");

    const aliases = [...new Set(aliasValues
      .map((alias) => text({ value: alias }, 256))
      .filter((alias): alias is string => alias !== null && normalizePublicName(alias) !== normalizePublicName(name)))]
      .sort().slice(0, PUBLIC_EPG_LIMITS.maxWikidataSuggestionAliases);
    const country = normalizedCountry(countryValues);
    const languages = normalizedLanguages(languageValues);
    const categoryIDs = normalizedCategories(genreValues);
    const candidate: PublicMetadataSuggestionCandidate = {
      sourceID: "wikidata",
      itemID: id,
      candidateName: name,
      aliases,
      fieldProvenance: {
        title: ["wikidata:item-label"],
        ...(country ? { country: ["wikidata:P17"] } : {}),
        ...(languages ? { languages: ["wikidata:P2936"] } : {}),
        ...(categoryIDs ? { categoryIDs: ["wikidata:P136"] } : {})
      },
      ...(country ? { country } : {}),
      ...(languages ? { languages } : {}),
      ...(categoryIDs ? { categoryIDs } : {})
    };
    if (!validMetadataSuggestionCandidate(candidate)) throw new Error("wikidata_candidate_invalid");
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => left.itemID.localeCompare(right.itemID));
}

/** Build bounded 3-gram postings; a dense term is marked ambiguous and carries no partial candidates. */
export function buildWikidataSuggestionIndex(
  candidates: readonly PublicMetadataSuggestionCandidate[]
): MetadataSuggestionBucketEntry[] {
  if (candidates.length === 0 || candidates.length > PUBLIC_EPG_LIMITS.maxWikidataSuggestionEntities) {
    throw new Error("wikidata_entity_budget_exceeded");
  }
  type Posting = { candidates: Map<string, PublicMetadataSuggestionCandidate>; ambiguous: boolean };
  const terms = new Map<string, Posting>();
  let pairs = 0;
  for (const candidate of candidates) {
    if (!validMetadataSuggestionCandidate(candidate)) throw new Error("wikidata_candidate_invalid");
    const grams = new Set<string>();
    for (const label of [candidate.candidateName, ...candidate.aliases]) {
      // Signed numeric labels are identity-bearing and must not be normalized
      // into fuzzy candidates for a different channel/time-shift.
      if (/[+\-\u2212]\s*\p{N}+/u.test(label.normalize("NFKC"))) continue;
      const normalized = normalizePublicName(label);
      for (const gram of publicNameGrams(normalized)) if (gram.length === 3) grams.add(gram);
    }
    for (const gram of [...grams].sort()) {
      const term = `fuzzy:${gram}`;
      let posting = terms.get(term);
      if (!posting) {
        if (terms.size >= PUBLIC_EPG_LIMITS.maxMetadataSuggestionTerms) throw new Error("wikidata_term_budget_exceeded");
        posting = { candidates: new Map(), ambiguous: false };
        terms.set(term, posting);
      }
      if (posting.ambiguous || posting.candidates.has(candidate.itemID)) continue;
      if (++pairs > PUBLIC_EPG_LIMITS.maxMetadataSuggestionTerms * 8) throw new Error("wikidata_posting_budget_exceeded");
      if (posting.candidates.size >= PUBLIC_EPG_LIMITS.maxMetadataSuggestionCandidates) {
        posting.candidates.clear();
        posting.ambiguous = true;
      } else {
        posting.candidates.set(candidate.itemID, candidate);
      }
    }
  }
  return [...terms.entries()].map(([term, posting]) => ({
    term,
    candidates: posting.ambiguous ? [] : [...posting.candidates.values()].sort((left, right) => left.itemID.localeCompare(right.itemID)),
    ambiguous: posting.ambiguous
  })).sort((left, right) => left.term.localeCompare(right.term));
}

async function readLimited(response: Response, onBytes?: (bytes: number) => void): Promise<Uint8Array> {
  if (!response.body) throw new Error("wikidata_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PUBLIC_EPG_LIMITS.maxWikidataSuggestionResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("wikidata_response_oversized");
      }
      onBytes?.(value.byteLength);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

/** Exactly one fixed, public export request. Failure is optional and is handled by the publisher's LKG artifact. */
export async function fetchWikidataSuggestions(
  fetchImpl: typeof fetch,
  usage: { onRequest?: () => void; onBytes?: (bytes: number) => void } = {}
): Promise<PublicMetadataSuggestionCandidate[]> {
  const url = new URL(WIKIDATA_QUERY_URL);
  url.searchParams.set("query", WIKIDATA_TV_CHANNEL_QUERY);
  url.searchParams.set("format", "json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIKIDATA_REQUEST_TIMEOUT_MS);
  try {
    usage.onRequest?.();
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": WIKIDATA_USER_AGENT
      },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`wikidata_http_${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/sparql-results+json") && !contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("wikidata_content_type_invalid");
    }
    const bytes = await readLimited(response, usage.onBytes);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (decoded.length * 2 > PUBLIC_EPG_LIMITS.maxWikidataSuggestionDecodedBytes) {
      throw new Error("wikidata_decoded_response_oversized");
    }
    return parseWikidataSuggestionResults(JSON.parse(decoded) as unknown);
  } catch (error) {
    if (error instanceof Error && /^(?:wikidata_|publisher_)/u.test(error.message)) throw error;
    throw new Error("wikidata_request_failed");
  } finally {
    clearTimeout(timer);
  }
}
