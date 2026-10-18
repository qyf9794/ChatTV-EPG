import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { normalizePublicName, identityKey, PUBLIC_EPG_LIMITS, PUBLIC_EPG_SOURCE_REGISTRY, validPublicCategoryIDs, validPublicChannelCandidate, validPublicChannelLanguages, validPublicCountryCode, validPublicProgrammeChannel } from "@vocaltv/public-epg-contract";
import { buildChannelSeeds, buildIdentityResolver, buildMetadataNameIndex, buildMetadataNameSuggestionIndex, buildNameIndex, matchXMLTVChannel, mergeIdentityEntry, mergeMetadataSuggestionIndexes } from "../src/identity.js";
import { buildSourceIndex } from "../src/programmes.js";
import { sha256 } from "../src/encoding.js";
import { boundedXMLTVBody, type FixedEpgSource } from "../src/xmltv.js";
import { categoriesFixture, channelsFixture, feedsFixture, MemoryObjectStore, xmlFixture } from "./fixtures.js";

const fixturePublicSource = PUBLIC_EPG_SOURCE_REGISTRY[0]!;

test("reused Feed IDs stay channel-scoped and composite Feed names resolve exactly", () => {
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const reused = seeds.filter((seed) => seed.identity.feedID === "shared");
  assert.equal(reused.length, 2);
  assert.notEqual(identityKey(reused[0]!.identity), identityKey(reused[1]!.identity));

  const resolver = buildIdentityResolver(seeds);
  assert.equal(matchXMLTVChannel({ id: "shared", names: ["HD"], languages: [] }, resolver), null);
  assert.equal(matchXMLTVChannel({ id: "news@shared", names: ["News HD"], languages: [] }, resolver)?.seed.identity.channelID, "news");

  const names = buildNameIndex(seeds);
  const composite = names.find((entry) => entry.term === "news english");
  assert.equal(composite?.ambiguous, false);
  assert.deepEqual(composite?.candidates.map((candidate) => [candidate.channelID, candidate.feedID, candidate.matchKind]), [["news", "en", "exact"]]);
  assert.ok(names.some((entry) => entry.term === "english" && entry.candidates.some((candidate) => candidate.feedID === "en")));
});

test("exact and alias name candidates carry a validated seed projection; old and gram rows stay compatible", () => {
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const names = buildNameIndex(seeds);
  const exact = names.find((entry) => entry.term === "news english")?.candidates[0];
  assert.deepEqual(exact, {
    provider: "iptv-org", channelID: "news", feedID: "en", matchKind: "exact",
    projection: {
      name: "News English", canonicalName: "News", feedName: "English",
      aliases: ["English", "News", "N"], languages: ["eng"],
      broadcastAreas: ["GB"], timezones: ["Europe/London"], country: "US", categoryIDs: ["news"], channelLanguages: ["eng"]
    }
  });
  assert.equal(validPublicChannelCandidate(exact), true);

  const legacy = { provider: "iptv-org", channelID: "news", feedID: "en", matchKind: "exact" };
  assert.equal(validPublicChannelCandidate(legacy), true);
  assert.equal(validPublicChannelCandidate({ ...exact, unexpected: "private" }), false);
  assert.equal(validPublicChannelCandidate({ ...exact, projection: { ...exact!.projection, feedName: null } }), false);
  assert.equal(validPublicChannelCandidate({ ...exact, projection: { ...exact!.projection, aliases: ["x".repeat(257)] } }), false);
  assert.equal(validPublicChannelCandidate({ ...exact, projection: { ...exact!.projection, country: "USA" } }), false);
  assert.equal(validPublicChannelCandidate({ ...exact, projection: { ...exact!.projection, categoryIDs: ["news", "news"] } }), false);
  assert.equal(validPublicCountryCode("US"), true);
  assert.equal(validPublicCountryCode("USA"), false);
  assert.equal(validPublicCategoryIDs(["news", "sports"]), true);
  assert.equal(validPublicCategoryIDs(Array(PUBLIC_EPG_LIMITS.maxChannelCategoryIDs + 1).fill("news")), false);
  assert.equal(validPublicChannelLanguages([]), true);
  assert.equal(validPublicChannelLanguages(["eng"]), true);
  assert.equal(validPublicChannelLanguages(["ENG"]), false);
  assert.equal(validPublicChannelLanguages(["eng", "spa"]), false);
  assert.equal(validPublicChannelLanguages(["und"]), false);
  assert.equal(validPublicChannelLanguages(["mul"]), false);
  assert.equal(validPublicChannelLanguages(["zxx"]), false);
  assert.equal(validPublicChannelCandidate({
    ...exact,
    projection: { ...exact!.projection, channelLanguages: ["ENG"] }
  }), false);

  const alias = names.find((entry) => entry.term === "english")?.candidates[0];
  assert.equal(alias?.matchKind, "alias");
  assert.deepEqual(alias?.projection, exact?.projection);
  const gram = names.find((entry) => entry.term.startsWith("gram:") && entry.candidates.some((candidate) => candidate.channelID === "news" && candidate.feedID === "en"))
    ?.candidates.find((candidate) => candidate.channelID === "news" && candidate.feedID === "en");
  assert.equal(gram?.matchKind, "gram");
  assert.equal(gram?.projection, undefined);
  const merged = mergeIdentityEntry(seeds.find((seed) => seed.identity.channelID === "news" && seed.identity.feedID === "en")!, []);
  assert.equal("metadataNameAliases" in merged, false, "publisher-only name hints must not leak into identity rows");
});

test("identity rows retain more than three bounded route hints without duplicating dated shards", () => {
  const seed = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture)
    .find((item) => item.identity.channelID === "news" && item.identity.feedID === "en")!;
  const routes = PUBLIC_EPG_SOURCE_REGISTRY.slice(0, 5).map((source, index) => ({
    sourceID: source.id,
    sourceRevision: "c".repeat(64),
    sourcePriority: source.priority,
    xmltvChannelID: `news@en-${index}`,
    displayName: `News English ${index}`,
    days: [{ utcDay: "2026-10-01", parts: [] }]
  }));
  const identity = mergeIdentityEntry(seed, routes);
  assert.equal(identity.relations.length, 5, "the former three-relation clamp no longer removes valid source routes");
  assert.deepEqual(identity.relations.map((relation) => relation.sourceID),
    [...routes].sort((left, right) => left.sourcePriority - right.sourcePriority).map((relation) => relation.sourceID));
  assert.ok(identity.relations.every((relation) => relation.days.length === 0),
    "complete dated shard arrays stay in programmeRoot and are resolved by exact source/XMLTV identity");

  const overflow = Array.from({ length: PUBLIC_EPG_LIMITS.maxIdentityRelations + 1 }, (_, index) => ({
    sourceID: PUBLIC_EPG_SOURCE_REGISTRY[index % PUBLIC_EPG_SOURCE_REGISTRY.length]!.id,
    sourceRevision: "d".repeat(64),
    sourcePriority: PUBLIC_EPG_SOURCE_REGISTRY[index % PUBLIC_EPG_SOURCE_REGISTRY.length]!.priority,
    xmltvChannelID: `news@en-overflow-${index}`,
    displayName: `Overflow ${index}`,
    days: []
  }));
  assert.deepEqual(mergeIdentityEntry(seed, overflow).relations, [],
    "overflow omits this optional index surface rather than publishing a misleading partial route list");
});

test("metadata name index includes channel-only and non-playable Feed identities without grams or projections", () => {
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const metadata = buildMetadataNameIndex(seeds);
  const channel = metadata.find((entry) => entry.term === "news");
  assert.ok(channel?.candidates.some((candidate) => candidate.channelID === "news" && candidate.feedID === null));
  assert.ok(channel!.candidates.every((candidate) => candidate.matchKind === "exact"));
  const feedAlias = metadata.find((entry) => entry.term === "english");
  assert.ok(feedAlias?.candidates.some((candidate) => candidate.channelID === "news" && candidate.feedID === null));
  assert.ok(metadata.some((entry) => entry.term === "international"
    && entry.candidates.some((candidate) => candidate.channelID === "other" && candidate.feedID === null)),
  "metadata lookup indexes terms from feeds that have no published playable stream");
  assert.ok(metadata.every((entry) => !entry.term.startsWith("gram:")
    && entry.candidates.length <= PUBLIC_EPG_LIMITS.maxMetadataNameCandidates
    && entry.candidates.every((candidate) => candidate.projection === undefined)));
  const channelSeed = seeds.find((seed) => seed.identity.channelID === "news" && seed.identity.feedID === null)!;
  const identity = mergeIdentityEntry(channelSeed, []);
  assert.equal(identity.country, "US");
  assert.deepEqual(identity.categoryIDs, ["news"]);
  assert.deepEqual(identity.channelLanguages, ["eng"]);
  assert.ok(channel);
  assert.equal(validPublicChannelCandidate(channel!.candidates[0]), true);
});

test("metadata name overflow is marked ambiguous and never publishes a partial eight-item list", () => {
  const channels = Array.from({ length: PUBLIC_EPG_LIMITS.maxMetadataNameCandidates + 1 }, (_, index) => ({
    id: `metadata-${index}`, name: "Shared Metadata Name", alt_names: []
  }));
  const entries = buildMetadataNameIndex(buildChannelSeeds(channels, []));
  for (const term of ["shared metadata name", "compact:sharedmetadataname"]) {
    const entry = entries.find((item) => item.term === term);
    assert.equal(entry?.ambiguous, true, `${term} overflows without truncating candidates`);
    assert.deepEqual(entry?.candidates, []);
  }
});

test("metadata compact variants match generic spacing while preserving numbers and signed shifts", () => {
  const seeds = buildChannelSeeds([
    { id: "france-compact", name: "France24" },
    { id: "france-spaced", name: "France 24" },
    { id: "news-compact", name: "NewsWorld" },
    { id: "news-spaced", name: "News World" },
    { id: "world-24", name: "World 24" },
    { id: "station-one", name: "Station 1" },
    { id: "station-plus", name: "Station +1" },
    { id: "station-minus", name: "Station -1" },
    { id: "station-unicode-minus", name: "Station −1" },
    { id: "bad/id", name: "Invalid identity" },
    { id: "bad-name", name: "\u0000" }
  ], []);
  const entries = buildMetadataNameIndex(seeds);
  const compact = (term: string) => entries.find((entry) => entry.term === `compact:${term}`);
  assert.equal(compact("france24")?.ambiguous, false);
  assert.deepEqual(compact("france24")?.candidates.map((candidate) => candidate.channelID), ["france-compact", "france-spaced"]);
  assert.equal(compact("newsworld")?.ambiguous, false);
  assert.deepEqual(compact("newsworld")?.candidates.map((candidate) => candidate.channelID), ["news-compact", "news-spaced"]);
  assert.deepEqual(compact("world24")?.candidates.map((candidate) => candidate.channelID), ["world-24"]);
  assert.ok(compact("france24")?.candidates.every((candidate) =>
    candidate.matchKind === "alias" && candidate.feedID === null && candidate.projection === undefined));
  assert.deepEqual(compact("station1")?.candidates.map((candidate) => candidate.channelID), ["station-one"],
    "the unsigned numbered channel keeps its digits without absorbing shifted identities");
  assert.equal(compact("invalididentity"), undefined, "invalid channel IDs cannot contribute compact postings");
  assert.equal(compact(""), undefined, "blank sanitized names cannot contribute compact postings");
  assert.deepEqual(entries.find((entry) => entry.term === "france24")?.candidates.map((candidate) => candidate.channelID), ["france-compact"],
    "the original exact posting remains separate from compact candidates");
  assert.equal(entries.some((entry) => entry.term.startsWith("gram:")), false);
});

test("fuzzy suggestion grams use only public channel labels, stay bounded, and fail closed", () => {
  const seeds = buildChannelSeeds([
    { id: "sample-channel", name: "Sample Channel", alt_names: ["Sample International"] },
    { id: "shifted", name: "Sample +1" }
  ], [
    { id: "feed", channel: "sample-channel", name: "Private Feed Label", alt_names: ["Feed Alias"] }
  ]);
  const suggestions = buildMetadataNameSuggestionIndex(seeds);
  const sample = suggestions.find((entry) => entry.term === "fuzzy:sam");
  assert.equal(sample?.ambiguous, false);
  assert.deepEqual(sample?.candidates, [{
    provider: "iptv-org", channelID: "sample-channel", feedID: null, matchKind: "gram"
  }]);
  assert.equal(suggestions.some((entry) => entry.term === "fuzzy:fee" || entry.term === "fuzzy:pri"), false,
    "Feed-only names never enter the suggestion tree");
  assert.equal(suggestions.some((entry) => entry.candidates.some((candidate) =>
    "provider" in candidate && candidate.channelID === "shifted")), false,
  "signed numeric labels never publish fuzzy channel candidates");
  assert.ok(suggestions.every((entry) => entry.candidates.length <= PUBLIC_EPG_LIMITS.maxMetadataSuggestionCandidates
    && entry.candidates.every((candidate) => "provider" in candidate
      && candidate.feedID === null && candidate.projection === undefined)));

  const denseSeeds = buildChannelSeeds(Array.from({ length: PUBLIC_EPG_LIMITS.maxMetadataSuggestionCandidates + 1 }, (_, index) => ({
    id: `dense-${index}`, name: "Shared Metadata Channel"
  })), []);
  const dense = buildMetadataNameSuggestionIndex(denseSeeds).find((entry) => entry.term === "fuzzy:sha");
  assert.equal(dense?.ambiguous, true);
  assert.deepEqual(dense?.candidates, [], "dense postings never expose a partial candidate list");

  const wiki = {
    sourceID: "wikidata" as const,
    itemID: "Q123",
    candidateName: "Sample Channel",
    aliases: [],
    country: "US",
    fieldProvenance: { title: ["wikidata:item-label"], country: ["wikidata:P17"] }
  };
  const conflictingWiki = { ...wiki, country: "CA" };
  const merged = mergeMetadataSuggestionIndexes(
    [{ term: "fuzzy:sam", candidates: [wiki], ambiguous: false }],
    [{ term: "fuzzy:sam", candidates: [conflictingWiki], ambiguous: false }]
  );
  assert.equal(merged[0]?.ambiguous, true);
  assert.deepEqual(merged[0]?.candidates, [], "same-source identity conflicts suppress the whole gram posting");
});

test("signed Feed labels do not publish sign-erased metadata terms; channel canonicals remain row-verifiable", () => {
  const feedEntries = buildMetadataNameIndex(buildChannelSeeds([
    { id: "plain-channel", name: "Plain Channel" },
    { id: "station-one", name: "Station 1" }
  ], [
    { id: "signed-feed", channel: "plain-channel", name: "Station +1", alt_names: ["Station −1"] }
  ]));
  assert.deepEqual(feedEntries.find((entry) => entry.term === "station 1")?.candidates.map((candidate) => candidate.channelID), ["station-one"],
    "a shifted Feed label cannot leak into the normalized primary posting");
  assert.deepEqual(feedEntries.find((entry) => entry.term === "compact:station1")?.candidates.map((candidate) => candidate.channelID), ["station-one"],
    "shifted Feed aliases cannot join the unshifted compact posting");

  const signedChannelEntries = buildMetadataNameIndex(buildChannelSeeds([
    { id: "signed-channel", name: "Station +1" }
  ], []));
  assert.deepEqual(signedChannelEntries.find((entry) => entry.term === "station 1")?.candidates.map((candidate) => candidate.channelID), ["signed-channel"],
    "the canonical channel label remains available for native signed-offset row verification");
});

test("many Feed aliases for one channel collapse before the eight-channel bound", () => {
  const feeds = Array.from({ length: PUBLIC_EPG_LIMITS.maxMetadataNameCandidates + 1 }, (_, index) => ({
    id: `english-${index}`, channel: "cnn", name: "English"
  }));
  const entry = buildMetadataNameIndex(buildChannelSeeds([
    { id: "cnn", name: "CNN", country: "US", categories: ["news"] }
  ], feeds, categoriesFixture)).find((item) => item.term === "english");
  assert.equal(entry?.ambiguous, false);
  assert.deepEqual(entry?.candidates, [{
    provider: "iptv-org", channelID: "cnn", feedID: null, matchKind: "alias"
  }]);
});

test("metadata matches keep exact channel names over same-channel Feed aliases and retain other channel aliases", () => {
  const seeds = buildChannelSeeds([
    { id: "cnn", name: "CNN", country: "US", categories: ["news"] },
    { id: "intl", name: "CNN International", alt_names: ["CNN"] }
  ], [
    { id: "english", channel: "cnn", name: "CNN English", alt_names: ["CNN"], languages: ["eng"] }
  ], categoriesFixture);
  const candidates = buildMetadataNameIndex(seeds).find((entry) => entry.term === "cnn")?.candidates;
  assert.deepEqual(candidates, [
    { provider: "iptv-org", channelID: "cnn", feedID: null, matchKind: "exact" },
    { provider: "iptv-org", channelID: "intl", feedID: null, matchKind: "alias" }
  ]);
  assert.ok(candidates!.every((candidate) => candidate.projection === undefined));
});

test("country and category metadata is accepted only when bounded and taxonomy-backed", () => {
  const seeds = buildChannelSeeds([
    { id: "known", name: "Known", country: "us", categories: ["news", "unlisted"] },
    { id: "bad-country", name: "Bad country", country: "USA", categories: ["news"] }
  ], [], categoriesFixture);
  const known = seeds.find((seed) => seed.identity.channelID === "known")!;
  assert.equal(known.country, "US");
  assert.deepEqual(known.categoryIDs, ["news"]);
  const badCountry = seeds.find((seed) => seed.identity.channelID === "bad-country")!;
  assert.equal(badCountry.country, null);
  assert.deepEqual(badCountry.categoryIDs, ["news"]);
  assert.throws(() => buildChannelSeeds([], [], Array.from({ length: 513 }, (_, index) => ({ id: `cat-${index}` }))), /categories_dataset_invalid/u);
});

test("channel language consensus requires every raw Feed to have the same single normalized ISO-3 language", () => {
  const channel = [{ id: "c", name: "Channel" }];
  const consensus = (feeds: unknown[]) => buildChannelSeeds(channel, feeds).find((seed) => seed.identity.feedID === null)!.channelLanguages;
  assert.deepEqual(consensus([
    { id: "one", channel: "c", name: "One", languages: ["eng"] },
    { id: "two", channel: "c", name: "Two", languages: ["ENG"] }
  ]), ["eng"]);
  assert.deepEqual(consensus([
    { id: "one", channel: "c", name: "One", languages: ["eng"] },
    { id: "missing", channel: "c", name: "Missing", languages: [] }
  ]), []);
  assert.deepEqual(consensus([
    { id: "one", channel: "c", name: "One", languages: ["eng", "spa"] }
  ]), []);
  assert.deepEqual(consensus([
    { id: "one", channel: "c", name: "One", languages: ["eng"] },
    { id: "two", channel: "c", name: "Two", languages: ["spa"] }
  ]), []);
  assert.deepEqual(consensus([
    { id: "one", channel: "c", name: "One", languages: ["eng"] },
    { channel: "c", languages: ["spa"] }
  ]), [], "an invalid-identity raw Feed still participates in unanimity");
  for (const unknown of ["und", "mul", "zxx"]) {
    assert.deepEqual(consensus([{ id: "one", channel: "c", name: "One", languages: [unknown] }]), [], `${unknown} is not a known single-language fact`);
  }
  assert.deepEqual(consensus([]), []);
});

test("highly reused bare Feed IDs use constant-size ambiguity evidence while composite identities stay exact", () => {
  const channels = Array.from({ length: 29_027 }, (_, index) => ({
    id: `channel-${index}`,
    name: `Channel ${index}`,
    alt_names: []
  }));
  const feeds = channels.map((channel) => ({
    id: "shared-feed",
    channel: channel.id,
    name: "English",
    languages: ["eng"]
  }));
  const seeds = buildChannelSeeds(channels, feeds);
  const resolver = buildIdentityResolver(seeds);
  const bare = resolver.byID.get("shared-feed") ?? [];
  assert.equal(bare.length, 2);
  assert.equal(matchXMLTVChannel({ id: "shared-feed", names: ["English"], languages: [] }, resolver), null);
  const exact = matchXMLTVChannel({ id: "channel-29026@shared-feed", names: [], languages: [] }, resolver);
  assert.equal(exact?.seed.identity.channelID, "channel-29026");
  assert.equal(exact?.seed.identity.feedID, "shared-feed");
});

test("source shards preserve XMLTV channel IDs, deduplicate, and duplicate cross-UTC-day programmes", async () => {
  const store = new MemoryObjectStore();
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const source: FixedEpgSource & { priority: number } = {
    id: fixturePublicSource.id,
    publicURL: "https://guide.example/guide.xml",
    maximumCompressedBytes: 1024 * 1024,
    maximumDecompressedBytes: 4 * 1024 * 1024,
    priority: fixturePublicSource.priority
  };
  const duplicate = xmlFixture().replace("</tv>", xmlFixture().slice(xmlFixture().indexOf("<programme"), xmlFixture().lastIndexOf("</tv>")) + "</tv>");
  const body = new TextEncoder().encode(duplicate);
  const result = await buildSourceIndex(store, source, body, sha256(body), seeds);
  assert.equal(result.programmeCount, 1);
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0]!;
  assert.equal(entry.externalIdentity?.channelID, "news");
  assert.equal(entry.externalIdentity?.feedID, "en");
  assert.equal(entry.xmltvChannelID, "news@en");
  assert.equal(entry.displayNames[0], "News English");
  assert.equal(validPublicProgrammeChannel(entry), true);
  assert.deepEqual(entry.days.map((day) => day.utcDay), ["2026-10-01", "2026-10-02"]);
  assert.ok(entry.days.every((day) => day.parts.length === 1));
  assert.ok(result.shardCount <= PUBLIC_EPG_LIMITS.maxIdentityXmlParts);

  for (const day of entry.days) {
    const part = day.parts[0]!;
    assert.match(part.key, new RegExp("/objects/" + part.sha256 + "\\.xml\\.gz$"));
    const compressed = store.objects.get(part.key)?.value;
    assert.ok(compressed);
    const xml = gunzipSync(compressed!).toString("utf8");
    assert.equal((xml.match(/<channel\b/gu) ?? []).length, 1);
    assert.equal((xml.match(/<programme\b/gu) ?? []).length, 1);
    assert.match(xml, /<channel id="news@en">/u);
    assert.match(xml, /channel="news@en"/u);
  }
});

test("large channel-day staging spills in bounded files but emits a bounded set of shared shards", async () => {
  const store = new MemoryObjectStore();
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const source: FixedEpgSource & { priority: number } = {
    id: fixturePublicSource.id,
    publicURL: "https://guide.example/large.xml",
    maximumCompressedBytes: 16 * 1024 * 1024,
    maximumDecompressedBytes: 16 * 1024 * 1024,
    priority: fixturePublicSource.priority
  };
  const description = "description-" + "x".repeat(3_000);
  const timestamp = (seconds: number): string => {
    const hour = Math.floor(seconds / 3_600);
    const minute = Math.floor((seconds % 3_600) / 60);
    const second = seconds % 60;
    return `20261001${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}${String(second).padStart(2, "0")} +0000`;
  };
  const programmes = Array.from({ length: 1_500 }, (_, index) =>
    `<programme start="${timestamp(index)}" stop="${timestamp(index + 30)}" channel="news@en"><title>Programme ${index}</title><desc>${description}</desc></programme>`
  ).join("");
  const body = new TextEncoder().encode(
    `<tv><channel id="news@en"><display-name>News English</display-name></channel>${programmes}</tv>`
  );
  assert.ok(body.byteLength > 4 * 1024 * 1024);
  const result = await buildSourceIndex(store, source, body, sha256(body), seeds);
  assert.equal(result.programmeCount, 1_500);
  assert.equal(result.entries.length, 1);
  const day = result.entries[0]!.days[0]!;
  assert.equal(day.utcDay, "2026-10-01");
  assert.ok(day.parts.length > 1 && day.parts.length < 16);
  assert.equal(result.shardCount, day.parts.length);
});

test("unassociated XMLTV channels stay source-local when an ID happens to resemble a Feed", async () => {
  const store = new MemoryObjectStore();
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const source = {
    id: fixturePublicSource.id,
    publicURL: "https://guide.example/guide.xml",
    maximumCompressedBytes: 1024 * 1024,
    maximumDecompressedBytes: 4 * 1024 * 1024,
    priority: fixturePublicSource.priority
  };
  const xml = xmlFixture().replaceAll("news@en", "shared");
  const body = new TextEncoder().encode(xml);
  const result = await buildSourceIndex(store, source, body, sha256(body), seeds);
  assert.equal(result.entries.length, 1, "iptv-org ambiguity cannot discard valid source-local programme evidence");
  assert.equal(result.entries[0]?.xmltvChannelID, "shared");
  assert.equal(result.entries[0]?.externalIdentity, undefined);
  assert.equal(result.programmeCount, 1);
});

test("XMLTV programmes remain eligible without a channel declaration or exact external identity", async () => {
  const store = new MemoryObjectStore();
  const source: FixedEpgSource & { priority: number } = {
    id: fixturePublicSource.id,
    publicURL: "https://guide.example/guide.xml",
    maximumCompressedBytes: 1024 * 1024,
    maximumDecompressedBytes: 4 * 1024 * 1024,
    priority: fixturePublicSource.priority
  };
  const xml = '<tv><programme start="20261001093000 +0000" stop="20261001100000 +0000" channel="source-only-42"><title>Fixture</title></programme></tv>';
  const body = new TextEncoder().encode(xml);
  const result = await buildSourceIndex(store, source, body, sha256(body), []);
  assert.equal(result.programmeCount, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.xmltvChannelID, "source-only-42");
  assert.equal(result.entries[0]?.externalIdentity, undefined);
  const compressed = store.objects.get(result.entries[0]!.days[0]!.parts[0]!.key)?.value;
  assert.ok(compressed);
  const shard = gunzipSync(compressed!).toString("utf8");
  assert.match(shard, /<channel id="source-only-42">/u);
  assert.match(shard, /channel="source-only-42"/u);
});

test("XMLTV body and identity part limits reject oversized or malformed source data", () => {
  const source: FixedEpgSource = {
    id: fixturePublicSource.id, publicURL: "https://guide.example/feed.xml.gz",
    maximumCompressedBytes: 8, maximumDecompressedBytes: 16
  };
  assert.throws(() => boundedXMLTVBody(source, new Uint8Array(9)), /source_compressed_size_exceeded/u);
  assert.throws(() => boundedXMLTVBody(source, new TextEncoder().encode("not gzip")), /source_gzip_invalid_or_oversized/u);

  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const seed = seeds.find((item) => item.identity.channelID === "news" && item.identity.feedID === "en")!;
  const tooManyParts = Array.from({ length: 65 }, (_, index) => ({
    key: "public-epg/v1/objects/" + "a".repeat(64) + ".xml.gz",
    sha256: "a".repeat(64), bytes: 1, compressedBytes: 1, xmlSha256: "b".repeat(64), utcDay: "2026-10-01", part: index
  }));
  assert.throws(() => mergeIdentityEntry(seed, [{
    sourceID: fixturePublicSource.id, sourceRevision: "c".repeat(64), sourcePriority: fixturePublicSource.priority,
    xmltvChannelID: "news@en", displayName: "News English",
    days: [{ utcDay: "2026-10-01", parts: tooManyParts }]
  }]), /identity_day_budget_exceeded/u);
});

test("name candidate overflow is explicitly ambiguous and never truncated into a winner", () => {
  const channels = Array.from({ length: 18 }, (_, index) => ({ id: "ch" + index, name: "Same Public Name", alt_names: [] }));
  const names = buildNameIndex(buildChannelSeeds(channels, []));
  const exact = names.find((entry) => entry.term === "same public name");
  assert.equal(exact?.ambiguous, true);
  assert.deepEqual(exact?.candidates, []);
});

test("name candidates retain the complete bounded 16-item projection set", () => {
  const channels = Array.from({ length: PUBLIC_EPG_LIMITS.maxIndexedCandidates }, (_, index) => ({
    id: "ch" + index, name: "Shared Public Name", alt_names: []
  }));
  const exact = buildNameIndex(buildChannelSeeds(channels, [])).find((entry) => entry.term === "shared public name");
  assert.equal(exact?.ambiguous, false);
  assert.equal(exact?.candidates.length, 16);
  assert.ok(exact?.candidates.every(validPublicChannelCandidate));
  assert.ok(exact?.candidates.every((candidate) => candidate.projection?.name === "Shared Public Name"));
});


test("repeated terminal quality labels normalize idempotently, including composed Feed names", () => {
  for (const [raw, expected] of [
    ["Station HD HD", "station"], ["Station (HD) / UHD 1080p", "station"],
    ["Station 24 HD SD", "station 24"], ["Station +1 HD HD", "station 1"],
    ["Station -1 HD UHD", "station 1"], ["HD HD", "hd"], ["HD", "hd"],
    ["Station HD English HD", "station hd english"], ["Ｓｔａｔｉｏｎ ＨＤ ＨＤ", "station"]
  ]) {
    const term = normalizePublicName(raw!);
    assert.equal(term, expected);
    assert.equal(normalizePublicName(term), term);
  }
  const seeds = buildChannelSeeds([{ id: "station", name: "Station HD" }],
    [{ id: "feed", channel: "station", name: "English HD HD" }]);
  for (const entry of buildMetadataNameIndex(seeds)) {
    const term = entry.term.replace(/^compact:/u, "");
    assert.equal(normalizePublicName(term), term);
  }
});

test("public seed IDs use the candidate contract limit and never truncate distinct identities", () => {
  const accepted = "a".repeat(128);
  const seeds = buildChannelSeeds([
    { id: accepted, name: "Accepted" },
    ...[129, 160, 161, 200].map((size) => ({ id: "a".repeat(size), name: "Oversized" }))
  ], [
    { id: accepted, channel: accepted, name: "Accepted Feed" },
    ...[129, 160, 161, 200].map((size) => ({ id: "a".repeat(size), channel: accepted, name: "Oversized Feed" })),
    { id: "foreign", channel: accepted + "a", name: "Foreign Channel" }
  ]);
  assert.equal(seeds.length, 2);
  assert.ok(seeds.every((seed) => seed.identity.channelID === accepted));
  assert.deepEqual(seeds.map((seed) => seed.identity.feedID), [null, accepted]);
  assert.ok(buildMetadataNameIndex(seeds).every((entry) => entry.candidates.every(validPublicChannelCandidate)));
});
