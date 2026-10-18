import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_EPG_LIMITS,
  validMetadataSuggestionCandidate,
  validPublicMetadataSuggestionCategoryIDs
} from "@vocaltv/public-epg-contract";
import {
  fetchWikidataSuggestions,
  parseWikidataSuggestionResults,
  WIKIDATA_QUERY_URL,
  WIKIDATA_TV_CHANNEL_QUERY
} from "../src/wikidata.js";

function binding(
  id: string,
  fields: Record<string, string> = {}
): Record<string, { type: string; value: string }> {
  return {
    item: { type: "uri", value: `http://www.wikidata.org/entity/${id}` },
    itemLabel: { type: "literal", value: "World News" },
    ...(fields.countryCodes ? { countryCodes: { type: "literal", value: fields.countryCodes } } : {}),
    ...(fields.languageCodes ? { languageCodes: { type: "literal", value: fields.languageCodes } } : {}),
    ...(fields.genreLabels ? { genreLabels: { type: "literal", value: fields.genreLabels } } : {}),
    ...(fields.aliases ? { aliases: { type: "literal", value: fields.aliases } } : {})
  };
}

test("Wikidata projection preserves per-field provenance, omits conflicts, and uses known categories only", () => {
  const candidates = parseWikidataSuggestionResults({
    results: { bindings: [binding("Q123", {
      countryCodes: "CA|US",
      languageCodes: "en|fr",
      genreLabels: "News|Special Exhibition Channel",
      aliases: "World News HD|Global World News"
    })] }
  });
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate?.itemID, "Q123");
  assert.equal(candidate?.country, undefined, "conflicting country values are omitted");
  assert.deepEqual(candidate?.languages, ["en", "fr"]);
  assert.deepEqual(candidate?.categoryIDs, ["news"], "unknown genre slugs never enter the existing taxonomy");
  assert.deepEqual(candidate?.aliases, ["Global World News"],
    "an alias which normalizes to the canonical label is omitted");
  assert.deepEqual(candidate?.fieldProvenance, {
    title: ["wikidata:item-label"],
    languages: ["wikidata:P2936"],
    categoryIDs: ["wikidata:P136"]
  });
  assert.equal(validMetadataSuggestionCandidate(candidate), true);
  assert.equal(validPublicMetadataSuggestionCategoryIDs(["news", "sports"]), true);
  assert.equal(validPublicMetadataSuggestionCategoryIDs(["news-channel"]), false);
});

test("fixed Wikidata adapter makes one bounded public request without channel text", async () => {
  const requested: Array<{ url: URL; init: RequestInit | undefined }> = [];
  let requestCount = 0;
  let byteCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestCount += 1;
    requested.push({ url: new URL(input instanceof Request ? input.url : input.toString()), init });
    return new Response(JSON.stringify({
      results: { bindings: [binding("Q123", { countryCodes: "US", languageCodes: "en", genreLabels: "News" })] }
    }), {
      status: 200,
      headers: { "content-type": "application/sparql-results+json; charset=utf-8" }
    });
  };
  const candidates = await fetchWikidataSuggestions(fetchImpl, {
    onRequest: () => { requestCount += 0; },
    onBytes: (bytes) => { byteCount += bytes; }
  });
  assert.equal(candidates.length, 1);
  assert.equal(requestCount, 1);
  assert.equal(requested.length, 1);
  const request = requested[0]!;
  assert.equal(request.url.origin + request.url.pathname, WIKIDATA_QUERY_URL);
  assert.equal(request.url.searchParams.get("query"), WIKIDATA_TV_CHANNEL_QUERY);
  assert.match(WIKIDATA_TV_CHANNEL_QUERY, new RegExp(`LIMIT ${PUBLIC_EPG_LIMITS.maxWikidataSuggestionEntities}`));
  assert.equal(request.url.searchParams.has("cursor"), false);
  assert.equal(request.url.searchParams.has("offset"), false);
  assert.equal(request.url.searchParams.get("query")?.includes("Private subscriber name"), false);
  assert.equal(request.init?.method, "GET");
  assert.equal(request.init?.redirect, "error");
  assert.equal(new Headers(request.init?.headers).get("user-agent"), "VocalTV-public-metadata/1.0 (https://chattv.bqxb.org/)");
  assert.equal(new Headers(request.init?.headers).get("accept"), "application/sparql-results+json");
  assert.ok(request.init?.signal instanceof AbortSignal, "the fixed adapter carries its bounded timeout signal");
  assert.ok(byteCount > 0 && byteCount <= PUBLIC_EPG_LIMITS.maxWikidataSuggestionResponseBytes);
});

test("Wikidata parser rejects duplicate identities and entity overflows", () => {
  assert.throws(() => parseWikidataSuggestionResults({
    results: { bindings: [binding("Q123"), binding("Q123")] }
  }), /wikidata_binding_invalid/u);
  assert.throws(() => parseWikidataSuggestionResults({
    results: { bindings: Array(PUBLIC_EPG_LIMITS.maxWikidataSuggestionEntities + 1).fill(binding("Q123")) }
  }), /wikidata_results_invalid/u);
});
