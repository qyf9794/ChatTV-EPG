import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { test } from "node:test";
import {
  PUBLIC_EPG_CURRENT_KEY,
  PUBLIC_EPG_LIMITS,
  PUBLIC_EPG_METADATA_COMPACT_PREFIX,
  PUBLIC_EPG_PREFIX,
  PUBLIC_EPG_PUBLISHER_STATE_KEY,
  publicProgrammeNameDescriptorKey,
  validPublicChannelCandidate,
  validCurrentPointer,
  validManifest,
  validPublicAccessEntry,
  validPublicTaxonomyRoot,
  validPublicProgrammeNameDescriptor,
  type MetadataSuggestionBucketEntry,
  type ArtifactRef,
  type CurrentPointer,
  type PublicEpgManifest,
  type PublicProgrammeChannel,
  type PublicProgrammeNamePosting,
  type PublicAccessEntry,
  type PublicIdentityEntry,
  type PublicTaxonomyPosting,
  type PublicTaxonomyPage
} from "@vocaltv/public-epg-contract";
import { nameRecords, readRoutedDirectory, readTaxonomyPostingPages, writeRoutedDirectory } from "../src/index-builder.js";
import { getVerifiedJSON, jsonBytes, sha256 } from "../src/encoding.js";
import type { GeneratedSourceIndex } from "../src/programmes.js";
import type { NameEntryRecord } from "../src/identity.js";
import {
  CHANNEL_METADATA_GENERATOR_VERSION,
  PUBLISHER_RUN_LIMITS,
  channelMetadataRevision,
  backfillProgrammeNameCompanion,
  runPublisher,
  validateMetadataNameEntries,
  type PublisherProgress
} from "../src/publish.js";
import { publicEpgSources } from "../src/sources.js";
import { WIKIDATA_TV_CHANNEL_QUERY } from "../src/wikidata.js";
import {
  categoriesFixture,
  channelsFixture,
  feedsFixture,
  FixedPublicUpstream,
  MemoryObjectStore,
  streamsFixture
} from "./fixtures.js";
import { buildChannelSeeds } from "../src/identity.js";
import { parseXmltvDate } from "../src/xmltv.js";

function programmeCoverageSeconds(store: MemoryObjectStore, channel: PublicProgrammeChannel, from: number, to: number): number {
  const intervals = new Map<string, { start: number; end: number }>();
  for (const day of channel.days) {
    const dayStart = Date.parse(`${day.utcDay}T00:00:00.000Z`);
    if (dayStart >= to || dayStart + 86_400_000 <= from) continue;
    for (const part of day.parts) {
      const stored = store.objects.get(part.key)?.value;
      assert.ok(stored, "source-local part must be present in the immutable graph");
      const xml = gunzipSync(stored!).toString("utf8");
      for (const match of xml.matchAll(/<programme\b([^>]*)>/gu)) {
        const attributes = match[1]!;
        const programmeChannel = /\bchannel="([^"]+)"/u.exec(attributes)?.[1];
        const startText = /\bstart="([^"]+)"/u.exec(attributes)?.[1];
        const endText = /\bstop="([^"]+)"/u.exec(attributes)?.[1];
        if (programmeChannel !== channel.xmltvChannelID || !startText || !endText) continue;
        const start = parseXmltvDate(startText), end = parseXmltvDate(endText);
        if (start === null || end === null || end <= from || start >= to) continue;
        intervals.set(`${start}\u001f${end}`, { start: Math.max(start, from), end: Math.min(end, to) });
      }
    }
  }
  const ordered = [...intervals.values()].sort((left, right) => left.start - right.start || left.end - right.end);
  let covered = 0, rangeStart = -1, rangeEnd = -1;
  for (const interval of ordered) {
    if (rangeStart < 0) { rangeStart = interval.start; rangeEnd = interval.end; continue; }
    if (interval.start > rangeEnd) { covered += rangeEnd - rangeStart; rangeStart = interval.start; rangeEnd = interval.end; }
    else rangeEnd = Math.max(rangeEnd, interval.end);
  }
  if (rangeStart >= 0) covered += rangeEnd - rangeStart;
  return covered / 1_000;
}

async function publishedObjects(store: MemoryObjectStore): Promise<{ pointer: CurrentPointer; manifest: PublicEpgManifest }> {
  const pointerBytes = await store.get(PUBLIC_EPG_CURRENT_KEY, 2048);
  assert.ok(pointerBytes);
  const pointer = JSON.parse(new TextDecoder().decode(pointerBytes!)) as unknown;
  assert.ok(validCurrentPointer(pointer));
  const manifestBytes = await store.get(pointer.manifestKey, 32 * 1024);
  assert.ok(manifestBytes);
  return { pointer, manifest: JSON.parse(new TextDecoder().decode(manifestBytes!)) as PublicEpgManifest };
}

function publisherStateForRetentionTest(store: MemoryObjectStore): {
  sources: Record<string, Record<string, unknown>>;
  lastRetentionAt?: number;
} {
  const stored = store.objects.get(PUBLIC_EPG_PUBLISHER_STATE_KEY);
  assert.ok(stored);
  return JSON.parse(new TextDecoder().decode(stored.value));
}

function addRetainedFixtureGraph(store: MemoryObjectStore, count: number): ArtifactRef[] {
  const refs = Array.from({ length: count }, (_, index): ArtifactRef => {
    const raw = jsonBytes({ retentionRegressionLeaf: index });
    const value = new Uint8Array(gzipSync(raw));
    const digest = sha256(value);
    const key = PUBLIC_EPG_PREFIX + "objects/" + digest + ".json.gz";
    store.objects.set(key, {
      value,
      metadata: { contentType: "application/json", contentEncoding: "gzip", cacheControl: "public, immutable" },
      modifiedAt: 0
    });
    return { key, sha256: digest, bytes: raw.byteLength, compressedBytes: value.byteLength };
  });
  const stored = store.objects.get(PUBLIC_EPG_PUBLISHER_STATE_KEY)!;
  const state = publisherStateForRetentionTest(store);
  // Changing this source pins the fixture only in its prior snapshot, outside
  // the run cache. Cached source validation permits extra graph fields.
  state.sources[publicEpgSources[0]!.id]!.retentionRegressionRefs = refs;
  store.objects.set(PUBLIC_EPG_PUBLISHER_STATE_KEY, { ...stored, value: jsonBytes(state) });
  return refs;
}

function deleteReachableRoutedGraph(store: MemoryObjectStore, root: ArtifactRef): string[] {
  const visited = new Set<string>();
  const deleted: string[] = [];
  const visit = (ref: ArtifactRef): void => {
    if (visited.has(ref.key)) return;
    visited.add(ref.key);
    const object = store.objects.get(ref.key);
    assert.ok(object, `routed graph ref must exist before deletion: ${ref.key}`);
    const payload = JSON.parse(gunzipSync(object!.value).toString("utf8")) as { entries?: unknown };
    if (Array.isArray(payload.entries)) {
      for (const entry of payload.entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const child = (entry as { ref?: unknown }).ref;
        if (child && typeof child === "object" && !Array.isArray(child)) visit(child as ArtifactRef);
      }
    }
    store.objects.delete(ref.key);
    deleted.push(ref.key);
  };
  visit(root);
  return deleted;
}

async function removeProgrammeNameCompanion(store: MemoryObjectStore, programmeRoot: ArtifactRef): Promise<{
  descriptorKey: string;
  descriptorBytes: Uint8Array;
  graphKeys: string[];
}> {
  const descriptorKey = publicProgrammeNameDescriptorKey(programmeRoot.sha256);
  const descriptorBytes = await store.get(descriptorKey);
  assert.ok(descriptorBytes, "published companion descriptor must exist before removal");
  const descriptor = JSON.parse(new TextDecoder().decode(descriptorBytes!)) as unknown;
  assert.ok(validPublicProgrammeNameDescriptor(descriptor));
  assert.equal(descriptor.programmeRootSHA256, programmeRoot.sha256);
  const graphKeys = deleteReachableRoutedGraph(store, descriptor.root);
  store.objects.delete(descriptorKey);
  assert.ok(graphKeys.length > 0, "the pre-companion fixture removes reachable name graph objects");
  for (const key of graphKeys) assert.equal(await store.get(key), null);
  assert.equal(await store.get(descriptorKey), null);
  return { descriptorKey, descriptorBytes: descriptorBytes!, graphKeys };
}

test("first publish emits bounded canonical artifacts; unchanged sources keep pointer stable", async () => {
  const store = new MemoryObjectStore();
  store.immutablePutDelayForKey = (key) => key.startsWith("public-epg/v1/") ? 2 : 0;
  const upstream = new FixedPublicUpstream();
  const agedOrphanKey = "public-epg/v1/objects/" + "f".repeat(64) + ".json.gz";
  store.objects.set(agedOrphanKey, {
    value: new Uint8Array([1, 2, 3]),
    metadata: { contentType: "application/json", contentEncoding: "gzip", cacheControl: "public, immutable" },
    modifiedAt: 0
  });
  const firstTime = new Date("2026-10-01T12:00:00.000Z");
  const first = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => firstTime });
  assert.equal(first.published, true);
  assert.equal(first.retentionStatus, "succeeded");
  assert.equal(first.retentionError, null);
  assert.equal(first.retentionErrorKey, null);
  assert.equal(first.retentionFailureStage, null);
  assert.equal(first.sourceCount, 18);
  assert.equal(first.metadataCount, 4);
  assert.equal(first.parsedSources, 18);
  assert.equal(first.reusedSources, 0);
  assert.equal(first.unavailableSources, 0);
  assert.equal(first.programmeCount, 18);
  assert.equal(first.shardCount, 36);
  assert.equal(first.r2ListRequests, 2); // storage admission plus retention
  assert.equal(first.r2DeleteObjects, 1);
  assert.ok(store.maxConcurrentImmutablePuts > 1, "independent immutable uploads should overlap");
  assert.ok(store.maxConcurrentImmutablePuts <= 8, "all publisher work shares the eight-upload cap");
  assert.equal(store.activeImmutablePuts, 0);
  assert.equal(store.objects.has(agedOrphanKey), false);
  assert.equal(store.objects.has(PUBLIC_EPG_PUBLISHER_STATE_KEY), true);

  const { pointer, manifest } = await publishedObjects(store);
  assert.equal(pointer.revision, first.revision);
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(manifest.programmeRoot, "v2 requires a source-local programme root independent of iptv-org identity rows");
  assert.match(manifest.channelMetadataRevision ?? "", /^[a-f0-9]{64}$/u);
  const legacyManifest = { ...manifest };
  delete legacyManifest.channelMetadataRevision;
  assert.equal(validManifest(legacyManifest), true, "legacy manifests remain valid without the independent metadata revision");
  assert.equal(validManifest({ ...manifest, channelMetadataRevision: "invalid" }), false);
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  assert.equal(channelMetadataRevision(seeds, manifest.metadataNameRoot!, manifest.metadataSuggestionRoot,
    CHANNEL_METADATA_GENERATOR_VERSION, manifest.taxonomyRoot), manifest.channelMetadataRevision);
  assert.notEqual(channelMetadataRevision(
    seeds, manifest.metadataNameRoot!, manifest.metadataSuggestionRoot, CHANNEL_METADATA_GENERATOR_VERSION + 1, manifest.taxonomyRoot
  ), manifest.channelMetadataRevision, "a metadata matching-rule version change advances the independent digest");
  assert.notEqual(channelMetadataRevision(seeds, manifest.metadataNameRoot!, manifest.metadataSuggestionRoot,
    CHANNEL_METADATA_GENERATOR_VERSION, { ...manifest.taxonomyRoot!, sha256: "e".repeat(64) }), manifest.channelMetadataRevision,
  "typed taxonomy root changes advance the independent channel metadata revision");
  assert.equal(manifest.sources.length, 22);
  assert.ok(manifest.streamsRoot);
  assert.ok(manifest.accessRoot);
  assert.ok(manifest.metadataNameRoot);
  assert.ok(manifest.taxonomyRoot);
  assert.ok(manifest.taxonomyRoot.bytes <= PUBLIC_EPG_LIMITS.maxRootUncompressedBytes);
  assert.ok(manifest.taxonomyRoot.compressedBytes <= PUBLIC_EPG_LIMITS.maxRootCompressedBytes);
  assert.ok(manifest.identityRoot.bytes <= 128 * 1024);
  assert.ok(manifest.identityRoot.compressedBytes <= 16 * 1024);

  const identities = await readRoutedDirectory<PublicIdentityEntry>(store, manifest.identityRoot, "identity", 128, 4 * 1024 * 1024);
  const sourceProgrammeChannels = await readRoutedDirectory<PublicProgrammeChannel>(store, manifest.programmeRoot!, "programme", 128, 4 * 1024 * 1024);
  assert.equal(sourceProgrammeChannels.length, 18);
  assert.ok(sourceProgrammeChannels.every(({ value }) => publicEpgSources.some((source) => source.id === value.sourceID
    && source.priority === value.sourcePriority)
    && manifest.sources.some((source) => source.sourceID === value.sourceID && source.sourceRevision === value.sourceRevision)));
  const sourceNameDescriptorKey = publicProgrammeNameDescriptorKey(manifest.programmeRoot!.sha256);
  const sourceNameDescriptorBytes = await store.get(sourceNameDescriptorKey, PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes);
  assert.ok(sourceNameDescriptorBytes, "the companion is published without changing the v2 manifest");
  assert.ok(sourceNameDescriptorBytes!.byteLength <= PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes);
  const sourceNameDescriptor = JSON.parse(new TextDecoder().decode(sourceNameDescriptorBytes!)) as unknown;
  assert.ok(validPublicProgrammeNameDescriptor(sourceNameDescriptor));
  assert.equal(sourceNameDescriptor.programmeRootSHA256, manifest.programmeRoot!.sha256);
  const sourceNameEntries = await readRoutedDirectory<PublicProgrammeNamePosting>(
    store, sourceNameDescriptor.root, "programme-names", 128, 4 * 1024 * 1024
  );
  const sourceNamePosting = sourceNameEntries.map(({ value }) => value).find(({ term }) => term === "news english");
  assert.equal(sourceNamePosting?.ambiguous, false);
  assert.equal(sourceNamePosting?.candidates.length, sourceProgrammeChannels.length);
  assert.ok(sourceNamePosting?.candidates.every((candidate) => sourceProgrammeChannels.some(({ value }) =>
    value.sourceID === candidate.sourceID && value.sourceRevision === candidate.sourceRevision
      && value.sourcePriority === candidate.sourcePriority && value.xmltvChannelID === candidate.xmltvChannelID)));
  assert.ok(sourceNameEntries.every(({ value }) => !JSON.stringify(value).includes("externalIdentity")
    && !JSON.stringify(value).includes("channelID") && !JSON.stringify(value).includes("feedID")));
  const taxonomyRoot = await getVerifiedJSON<unknown>(store, manifest.taxonomyRoot!, PUBLIC_EPG_LIMITS.maxRootUncompressedBytes);
  assert.ok(validPublicTaxonomyRoot(taxonomyRoot));
  assert.deepEqual(taxonomyRoot.vocabulary, { language: ["eng"], category: ["news"], country: ["US"] });
  const taxonomyEntries = await readRoutedDirectory<PublicTaxonomyPosting>(store, manifest.taxonomyRoot!, "taxonomy", 128, 4 * 1024 * 1024);
  assert.equal(first.taxonomyPostingCount, taxonomyEntries.length);
  assert.ok(first.taxonomyMemberCount > 0);
  assert.equal(first.taxonomyPageCount, taxonomyEntries.reduce((total, entry) => total + entry.value.pages.length, 0));
  assert.ok(taxonomyEntries.every(({ hash, value }) => hash === sha256(JSON.stringify([1, value.dimension, value.value]))));
  const englishPosting = taxonomyEntries.find((entry) => entry.value.dimension === "language" && entry.value.value === "eng")?.value;
  assert.ok(englishPosting);
  const englishPages = await readTaxonomyPostingPages(store, englishPosting!);
  const englishMembers = englishPages.flatMap((page: PublicTaxonomyPage) => page.memberKeys);
  assert.ok(englishMembers.includes("news@en"));
  assert.ok(englishMembers.includes("news@"), "channel identity carries only its unanimous language fact");
  assert.ok(taxonomyEntries.every(({ value }) => !JSON.stringify(value).includes("https://")
    && !JSON.stringify(value).includes("token")), "taxonomy postings carry typed metadata and identity keys only");
  const feed = identities.map((entry) => entry.value).find((entry) => entry.channelID === "news" && entry.feedID === "en");
  assert.ok(feed);
  assert.equal(feed!.canonicalName, "News");
  assert.equal(feed!.feedName, "English");
  assert.equal(feed!.name, "News English");
  assert.equal(feed!.country, "US");
  assert.deepEqual(feed!.categoryIDs, ["news"]);
  assert.deepEqual(feed!.channelLanguages, ["eng"]);
  assert.ok(feed!.relations.every((relation) => relation.xmltvChannelID === "news@en"));
  assert.ok(feed!.relations.every((relation) => relation.days.length === 0),
    "identity entries retain route hints while dated XML shards stay in programmeRoot");
  const feedProgrammeRows = sourceProgrammeChannels.map((entry) => entry.value)
    .filter((entry) => entry.xmltvChannelID === "news@en");
  assert.ok(feed!.relations.length > 3,
    "identity rows retain more than the former three-source route limit");
  assert.equal(feed!.relations.length, feedProgrammeRows.length,
    "every bounded source-local route hint remains represented in programmeRoot");
  assert.deepEqual(feed!.relations.map((relation) => relation.sourceID).sort(),
    feedProgrammeRows.map((relation) => relation.sourceID).sort());
  assert.ok(feedProgrammeRows.every((relation) =>
    relation.days.map((day) => day.utcDay).join(",") === "2026-10-01,2026-10-02"
    && relation.days.flatMap((day) => day.parts).every((part) => part.key.endsWith(".xml.gz"))));

  const nameBuckets = await readRoutedDirectory<{ term: string; candidates: Array<{ channelID: string; feedID: string | null; matchKind: string }>; ambiguous: boolean }>(
    store, manifest.nameRoot, "name", 128, 4 * 1024 * 1024
  );
  const exact = nameBuckets.map((entry) => entry.value).find((entry) => entry.term === "news english");
  assert.equal(exact?.ambiguous, false);
  assert.ok(nameBuckets.every((entry) => entry.value.candidates.length <= PUBLIC_EPG_LIMITS.maxIndexedCandidates));
  assert.ok(nameBuckets.every((entry) => entry.value.candidates.every((candidate) =>
    validPublicChannelCandidate(candidate)
      && (candidate.matchKind === "gram" ? candidate.projection === undefined : candidate.projection !== undefined))));
  assert.equal(nameBuckets.some((entry) => entry.value.candidates.some((candidate) =>
    candidate.channelID === "news" && candidate.feedID === "shared")), false, "only playable public identities are projected");
  assert.deepEqual(exact?.candidates, [{
    provider: "iptv-org", channelID: "news", feedID: "en", matchKind: "exact",
    projection: {
      name: "News English", canonicalName: "News", feedName: "English",
      aliases: ["English", "News", "N"], languages: ["eng"],
      broadcastAreas: ["GB"], timezones: ["Europe/London"], country: "US", categoryIDs: ["news"], channelLanguages: ["eng"]
    }
  }]);
  const metadataNameEntries = await readRoutedDirectory<{ term: string; candidates: Array<{ channelID: string; feedID: string | null; matchKind: string; projection?: unknown }>; ambiguous: boolean }>(
    store, manifest.metadataNameRoot!, "metadata-name", 128, 4 * 1024 * 1024
  );
  assert.ok(first.metadataNameTermCount > 0);
  assert.ok(metadataNameEntries.every((entry) => !entry.value.term.startsWith("gram:")
    && entry.value.candidates.length <= PUBLIC_EPG_LIMITS.maxMetadataNameCandidates
    && entry.value.candidates.every((candidate) => candidate.projection === undefined
      && candidate.matchKind !== "gram")));
  assert.ok(metadataNameEntries.some((entry) => entry.value.term === "hd"
    && entry.value.candidates.some((candidate) => candidate.channelID === "news" && candidate.feedID === null)),
  "metadata lookup includes names contributed by public identities without playable streams");
  assert.ok(metadataNameEntries.some((entry) => entry.value.term === `${PUBLIC_EPG_METADATA_COMPACT_PREFIX}newsenglish`
    && entry.value.candidates.some((candidate) => candidate.channelID === "news" && candidate.feedID === null
      && candidate.matchKind === "alias")), "compact variants stay in the metadata-only tree");
  assert.ok(nameBuckets.every((entry) => !entry.value.term.startsWith(PUBLIC_EPG_METADATA_COMPACT_PREFIX)),
    "playable discovery keeps its original name terms");
  const channelOnlyIdentity = identities.map((entry) => entry.value)
    .find((entry) => entry.channelID === "news" && entry.feedID === null);
  assert.equal(channelOnlyIdentity?.country, "US");
  assert.deepEqual(channelOnlyIdentity?.categoryIDs, ["news"]);
  assert.deepEqual(channelOnlyIdentity?.channelLanguages, ["eng"]);
  let nameArtifactCount = 0, nameBucketCount = 0, largestNameBucketBytes = 0;
  for (const object of store.objects.values()) {
    if (object.metadata.contentType !== "application/json" || object.metadata.contentEncoding !== "gzip") continue;
    const raw = gunzipSync(object.value);
    const artifact = JSON.parse(raw.toString("utf8")) as { kind?: unknown };
    if (typeof artifact.kind !== "string" || !artifact.kind.startsWith("name-")) continue;
    nameArtifactCount += 1;
    if (artifact.kind === "name-bucket") {
      nameBucketCount += 1;
      largestNameBucketBytes = Math.max(largestNameBucketBytes, raw.byteLength);
    }
  }
  assert.ok(nameArtifactCount > 0);
  assert.ok(nameBucketCount > 0);
  assert.ok(largestNameBucketBytes <= PUBLIC_EPG_LIMITS.maxIndexNodeUncompressedBytes);
  const streamEntries = await readRoutedDirectory<{ channelID: string; feedID: string | null; streams: Array<{ streamId: string; feedId?: string }> }>(
    store, manifest.streamsRoot!, "streams", 128, 4 * 1024 * 1024
  );
  const newsEnglish = streamEntries.map((entry) => entry.value).find((entry) => entry.channelID === "news" && entry.feedID === "en");
  assert.equal(newsEnglish?.streams[0]?.streamId, "news-en-1080p");
  assert.equal(newsEnglish?.streams[0]?.feedId, "en");
  assert.equal(streamEntries.some((entry) => entry.value.channelID === "news" && entry.value.feedID === "shared"), false);
  const accessEntries = await readRoutedDirectory<PublicAccessEntry>(store, manifest.accessRoot!, "access", 128, 4 * 1024 * 1024);
  assert.ok(accessEntries.every(({ hash, value }) => hash === value.accessDigest && validPublicAccessEntry(value)));
  assert.ok(accessEntries.every(({ value }) => !("url" in value) && !("headers" in value)));
  assert.equal(first.accessDigestCount, accessEntries.length);
  assert.ok(first.accessMemberCount > 0);
  assert.equal(first.accessAmbiguousCount, 0);
  const newsAccess = accessEntries.map((entry) => entry.value).find((entry) =>
    entry.members.some((member) => member.channelID === "news" && member.feedID === "en"));
  assert.ok(newsAccess);
  assert.deepEqual(newsAccess!.members, [{ channelID: "news", feedID: "en" }]);

  const pointerBytesBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);
  const putCountBefore = store.puts.length;
  const next = await runPublisher({
    store,
    fetchImpl: upstream.fetch,
    now: () => new Date("2026-10-01T18:00:00.000Z")
  });
  const pointerBytesAfter = await store.get(PUBLIC_EPG_CURRENT_KEY);
  assert.equal(next.published, false);
  assert.equal(next.parsedSources, 0);
  assert.equal(next.reusedSources, 18);
  assert.deepEqual(pointerBytesAfter, pointerBytesBefore);
  assert.deepEqual(store.puts.slice(putCountBefore).filter((key) => !key.endsWith("publisher/lease.json")), []);
  assert.ok(next.httpRequests >= 22);
  assert.ok(next.r2GetRequests < 100, "no-change run avoids loading the full artifact graph");
  assert.ok(next.r2PutRequests > 0, "the bounded lease still renews");
  assert.equal(next.retentionRan, false);
  assert.equal(next.retentionStatus, "skipped");
  assert.equal(next.retentionError, null);
  assert.equal(next.retentionErrorKey, null);
  assert.equal(next.retentionFailureStage, null);
  assert.equal(next.r2ListRequests, 1); // storage admission; no retention enumeration
  assert.equal(next.r2DeleteRequests, 0);
  assert.equal([...upstream.conditionalRequests.values()].reduce((sum, count) => sum + count, 0), 22);
});

test("fixed Wikidata suggestions publish as an optional root and retain last-good on source failure", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  const wikidataRequests: URL[] = [];
  let wikidataUnavailable = false;
  let wikidataCandidateName = "World News";
  const fetchImpl: typeof fetch = async (input, init) => {
    const rawURL = input instanceof Request ? input.url : input.toString();
    const url = new URL(rawURL);
    if (url.hostname === "query.wikidata.org") {
      wikidataRequests.push(url);
      if (wikidataUnavailable) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({
        head: { vars: ["item", "itemLabel", "countryCodes", "languageCodes", "genreLabels", "aliases"] },
        results: { bindings: [{
          item: { type: "uri", value: "http://www.wikidata.org/entity/Q876" },
          itemLabel: { type: "literal", value: wikidataCandidateName },
          countryCodes: { type: "literal", value: "US" },
          languageCodes: { type: "literal", value: "en" },
          genreLabels: { type: "literal", value: "News" },
          aliases: { type: "literal", value: "World News International" }
        }] }
      }), { headers: { "content-type": "application/sparql-results+json" } });
    }
    return upstream.fetch(input, init);
  };

  const first = await runPublisher({
    store, fetchImpl, now: () => new Date("2026-10-02T12:00:00.000Z")
  });
  assert.equal(first.wikidataSuggestionStatus, "ready");
  assert.ok(first.metadataSuggestionTermCount > 0);
  const firstManifest = (await publishedObjects(store)).manifest;
  assert.ok(firstManifest.metadataSuggestionRoot);
  assert.ok(firstManifest.channelMetadataRevision);
  const firstEntries = await readRoutedDirectory<MetadataSuggestionBucketEntry>(
    store, firstManifest.metadataSuggestionRoot!, "metadata-suggestion", 256, 8 * 1024 * 1024
  );
  assert.ok(firstEntries.some(({ value }) => value.candidates.some((candidate) =>
    "sourceID" in candidate && candidate.itemID === "Q876")));

  wikidataCandidateName = "World News International";
  const changedCandidate = await runPublisher({
    store, fetchImpl, now: () => new Date("2026-10-02T18:00:00.000Z")
  });
  assert.equal(changedCandidate.wikidataSuggestionStatus, "ready");
  const changedManifest = (await publishedObjects(store)).manifest;
  assert.notEqual(changedManifest.metadataSuggestionRoot?.sha256, firstManifest.metadataSuggestionRoot?.sha256);
  assert.notEqual(changedManifest.channelMetadataRevision, firstManifest.channelMetadataRevision,
    "a changed metadata suggestion candidate advances the independent metadata fence");
  const changedEntries = await readRoutedDirectory<MetadataSuggestionBucketEntry>(
    store, changedManifest.metadataSuggestionRoot!, "metadata-suggestion", 256, 8 * 1024 * 1024
  );
  assert.ok(changedEntries.some(({ value }) => value.candidates.some((candidate) =>
    "sourceID" in candidate && candidate.candidateName === "World News International")));

  wikidataUnavailable = true;
  const second = await runPublisher({
    store, fetchImpl, now: () => new Date("2026-10-03T00:00:00.000Z")
  });
  assert.equal(second.wikidataSuggestionStatus, "stale");
  assert.ok(second.httpRequests <= PUBLISHER_RUN_LIMITS.maxHTTPRequests, "the unavailable optional source remains inside the shared request budget");
  assert.ok(second.httpBytes <= PUBLISHER_RUN_LIMITS.maxHTTPBytes, "the unavailable optional source remains inside the shared byte budget");
  const secondManifest = (await publishedObjects(store)).manifest;
  assert.equal(secondManifest.metadataSuggestionRoot?.sha256, changedManifest.metadataSuggestionRoot?.sha256);
  assert.equal(secondManifest.channelMetadataRevision, changedManifest.channelMetadataRevision);
  const secondEntries = await readRoutedDirectory<MetadataSuggestionBucketEntry>(
    store, secondManifest.metadataSuggestionRoot!, "metadata-suggestion", 256, 8 * 1024 * 1024
  );
  assert.deepEqual(secondEntries, changedEntries, "a failed optional fetch keeps the complete last-good suggestion artifact");
  assert.equal(wikidataRequests.length, 3, "one fixed request is made per publication attempt");
  assert.ok(wikidataRequests.every((url) => url.searchParams.get("query") === WIKIDATA_TV_CHANNEL_QUERY));
  assert.ok(wikidataRequests.every((url) => !url.searchParams.has("channel") && !url.searchParams.has("name")));
});

test("legacy manifests without accessRoot or taxonomyRoot remain readable and gain both roots on republish", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const { pointer, manifest } = await publishedObjects(store);
  const legacyManifest = { ...manifest };
  delete legacyManifest.accessRoot;
  delete legacyManifest.taxonomyRoot;
  assert.equal(validManifest(legacyManifest), true);
  const bytes = jsonBytes(legacyManifest);
  const digest = sha256(bytes);
  const key = `${PUBLIC_EPG_PREFIX}manifests/${digest}.json`;
  await store.put(key, bytes, { contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" });
  const legacyPointer: CurrentPointer = {
    ...pointer,
    manifestKey: key,
    manifestSha256: digest
  };
  await store.put(PUBLIC_EPG_CURRENT_KEY, jsonBytes(legacyPointer), { contentType: "application/json", cacheControl: "no-cache" });

  const republished = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  const current = await publishedObjects(store);
  assert.equal(republished.published, true);
  assert.ok(current.manifest.accessRoot);
  assert.ok(current.manifest.taxonomyRoot);
  const access = await readRoutedDirectory<PublicAccessEntry>(store, current.manifest.accessRoot!, "access", 128, 4 * 1024 * 1024);
  assert.ok(access.length > 0);
  const taxonomy = await readRoutedDirectory<PublicTaxonomyPosting>(store, current.manifest.taxonomyRoot!, "taxonomy", 128, 4 * 1024 * 1024);
  assert.ok(taxonomy.length > 0);
});

test("a stream URL change does not advance the channel metadata revision", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const previous = await publishedObjects(store);

  const updatedStreams = streamsFixture.map((stream, index) => index === 0
    ? { ...stream, url: "https://cdn.example/news-updated.m3u8" }
    : stream);
  upstream.metadataOverrides.set("iptv-org:streams", updatedStreams);
  upstream.changedMetadataSourceIDs.add("iptv-org:streams");
  const changed = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  const latest = await publishedObjects(store);

  assert.equal(changed.parsedSources, 0);
  assert.notEqual(latest.manifest.streamsRoot?.sha256, previous.manifest.streamsRoot?.sha256);
  assert.notEqual(latest.manifest.accessRoot?.sha256, previous.manifest.accessRoot?.sha256);
  assert.notEqual(latest.pointer.revision, previous.pointer.revision);
  assert.equal(latest.manifest.channelMetadataRevision, previous.manifest.channelMetadataRevision,
    "playable-source URL changes do not invalidate channel attributes or metadata candidates");
});

test("changed source reparses only that source and publishes a new logical revision", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const old = await publishedObjects(store);
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
  const changed = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  const latest = await publishedObjects(store);
  assert.equal(changed.parsedSources, 1);
  assert.equal(changed.reusedSources, 17);
  assert.equal(changed.published, true);
  assert.notEqual(latest.pointer.revision, old.pointer.revision);
  assert.equal(latest.manifest.previousRevision, old.pointer.revision);
  assert.deepEqual(latest.manifest.nameRoot, old.manifest.nameRoot);
  assert.deepEqual(latest.manifest.streamsRoot, old.manifest.streamsRoot);
  assert.deepEqual(latest.manifest.metadataNameRoot, old.manifest.metadataNameRoot);
  assert.equal(latest.manifest.channelMetadataRevision, old.manifest.channelMetadataRevision,
    "an EPG-only publication keeps the channel metadata fence stable");
  assert.equal(latest.manifest.accessRoot?.sha256, old.manifest.accessRoot?.sha256,
    "an EPG-only publication reuses the access reverse index");
  assert.equal(latest.manifest.taxonomyRoot?.sha256, old.manifest.taxonomyRoot?.sha256,
    "an EPG-only publication reuses the typed metadata taxonomy");
  assert.notEqual(latest.manifest.generatedAt, old.manifest.generatedAt);
  assert.notEqual(
    latest.manifest.sources.find((source) => source.sourceID === publicEpgSources[0]!.id)?.lastGoodAt,
    old.manifest.sources.find((source) => source.sourceID === publicEpgSources[0]!.id)?.lastGoodAt,
    "programme-source freshness advances independently of the channel metadata fence"
  );
  assert.notDeepEqual(latest.manifest.identityRoot, old.manifest.identityRoot);

  const stateBytes = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY, 1024 * 1024);
  assert.ok(stateBytes);
  const state = JSON.parse(new TextDecoder().decode(stateBytes!)) as {
    previousPointers?: CurrentPointer[];
    previousStates?: Array<{ sources?: Record<string, { sourceRevision: string }> }>;
  };
  assert.equal(state.previousPointers?.[0]?.revision, old.pointer.revision);
  assert.equal(state.previousStates?.length, 1);
  assert.notEqual(
    state.previousStates?.[0]?.sources?.[publicEpgSources[0]!.id]?.sourceRevision,
    JSON.parse(new TextDecoder().decode(stateBytes!)).sources[publicEpgSources[0]!.id].sourceRevision
  );
});

test("metadata generator changes rebuild metadata-name roots with unchanged EPG inputs", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const previous = await publishedObjects(store);

  // Simulate a prior metadata generator: its EPG input digest is current, while
  // its metadata-name root and generator-bound digest are stale.
  const currentEntries = await readRoutedDirectory<NameEntryRecord>(store, previous.manifest.metadataNameRoot!, "metadata-name");
  const legacyRoot = await writeRoutedDirectory(store, "metadata-name", nameRecords(
    currentEntries.map((entry) => entry.value).filter((entry) => !entry.term.startsWith(PUBLIC_EPG_METADATA_COMPACT_PREFIX))
  ));
  const legacyManifest = {
    ...previous.manifest,
    metadataNameRoot: legacyRoot,
    revision: "1".repeat(64)
  };
  const legacyManifestBytes = jsonBytes(legacyManifest);
  const legacyManifestHash = sha256(legacyManifestBytes);
  const legacyManifestKey = `${PUBLIC_EPG_PREFIX}manifests/${legacyManifestHash}.json`;
  const jsonMetadata = { contentType: "application/json" as const, cacheControl: "public, max-age=300" };
  await store.put(legacyManifestKey, legacyManifestBytes, jsonMetadata);
  const currentPointer = await store.getWithETag(PUBLIC_EPG_CURRENT_KEY, 2048);
  assert.ok(currentPointer);
  await store.putConditional(PUBLIC_EPG_CURRENT_KEY, jsonBytes({
    schemaVersion: 1,
    revision: legacyManifest.revision,
    manifestKey: legacyManifestKey,
    manifestSha256: legacyManifestHash
  }), jsonMetadata, { ifMatch: currentPointer!.etag });

  const stateBytes = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY, 1024 * 1024);
  assert.ok(stateBytes);
  const state = JSON.parse(new TextDecoder().decode(stateBytes!)) as Record<string, unknown>;
  state.metadataNameInputDigest = "b".repeat(64);
  await store.put(PUBLIC_EPG_PUBLISHER_STATE_KEY, jsonBytes(state), jsonMetadata);

  let repeatedKnownRootPuts = 0;
  store.beforeConditionalPut = (key) => {
    if (key === previous.manifest.identityRoot.key) repeatedKnownRootPuts += 1;
  };
  const rebuilt = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  assert.equal(repeatedKnownRootPuts, 0, "a root read and verified in this run needs no duplicate conditional PUT");
  const latest = await publishedObjects(store);
  assert.equal(rebuilt.parsedSources, 0, "generator invalidation reuses unchanged parsed source bodies");
  assert.equal(rebuilt.reusedSources, 18);
  assert.equal(rebuilt.published, true, "the new index root changes the logical revision");
  assert.notEqual(latest.pointer.revision, legacyManifest.revision);
  assert.notDeepEqual(latest.manifest.metadataNameRoot, legacyRoot);
  const metadataEntries = await readRoutedDirectory<NameEntryRecord>(store, latest.manifest.metadataNameRoot!, "metadata-name");
  assert.ok(metadataEntries.some((entry) => entry.value.term.startsWith(PUBLIC_EPG_METADATA_COMPACT_PREFIX)));
});

test("category taxonomy changes refresh channel projections without reparsing EPG or rebuilding name identities", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const previous = await publishedObjects(store);
  const previousIdentities = await readRoutedDirectory<PublicIdentityEntry>(
    store, previous.manifest.identityRoot, "identity", 128, 4 * 1024 * 1024
  );
  const previousNewsFeed = previousIdentities.map((entry) => entry.value)
    .find((entry) => entry.channelID === "news" && entry.feedID === "en");
  assert.ok(previousNewsFeed);

  upstream.metadataOverrides.set("iptv-org:categories", [{ id: "sports", name: "Sports" }]);
  upstream.changedMetadataSourceIDs.add("iptv-org:categories");
  const changed = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  const latest = await publishedObjects(store);
  assert.equal(changed.parsedSources, 0);
  assert.equal(latest.manifest.identityRoot.sha256 === previous.manifest.identityRoot.sha256, false);
  assert.equal(latest.manifest.nameRoot.sha256 === previous.manifest.nameRoot.sha256, false);
  assert.equal(latest.manifest.metadataNameRoot?.sha256, previous.manifest.metadataNameRoot?.sha256);
  assert.notEqual(latest.manifest.taxonomyRoot?.sha256, previous.manifest.taxonomyRoot?.sha256,
    "category fact changes rebuild the complete taxonomy graph");
  assert.notEqual(latest.manifest.channelMetadataRevision, previous.manifest.channelMetadataRevision,
    "a category projection change advances the channel metadata fence");

  const identities = await readRoutedDirectory<PublicIdentityEntry>(store, latest.manifest.identityRoot, "identity", 128, 4 * 1024 * 1024);
  const newsFeed = identities.map((entry) => entry.value).find((entry) => entry.channelID === "news" && entry.feedID === "en");
  assert.ok(newsFeed);
  assert.equal(newsFeed!.categoryIDs, undefined, "unknown category IDs are omitted after taxonomy revision");
  assert.deepEqual(newsFeed!.relations, previousNewsFeed!.relations,
    "all existing EPG relations remain attached to the same identity");
  assert.ok(newsFeed!.relations.every((relation) => relation.days.length === 0),
    "dated parts remain independently available from the unchanged programme root");
});

test("Feed language consensus changes invalidate channel metadata and unchanged metadata reuses it", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const previous = await publishedObjects(store);
  const priorIdentities = await readRoutedDirectory<PublicIdentityEntry>(store, previous.manifest.identityRoot, "identity", 128, 4 * 1024 * 1024);
  const priorNewsFeed = priorIdentities.map((entry) => entry.value)
    .find((entry) => entry.channelID === "news" && entry.feedID === "en");
  assert.deepEqual(priorNewsFeed?.channelLanguages, ["eng"]);

  const changedFeeds = [
    { id: "en", channel: "news", name: "English", languages: ["spa"], broadcast_area: ["GB"], timezones: ["Europe/London"] },
    { id: "shared", channel: "news", name: "HD", languages: ["eng"], broadcast_area: ["GB"], timezones: ["Europe/London"] },
    { id: "shared", channel: "other", name: "International", languages: ["eng"], broadcast_area: ["US"], timezones: ["America/New_York"] }
  ];
  upstream.metadataOverrides.set("iptv-org:feeds", changedFeeds);
  upstream.changedMetadataSourceIDs.add("iptv-org:feeds");
  const changed = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  const latest = await publishedObjects(store);
  assert.equal(changed.parsedSources, 18, "Feed metadata changes invalidate source identity mappings during offline publication");
  assert.equal(changed.published, true);
  assert.notEqual(latest.pointer.revision, previous.pointer.revision);
  assert.notDeepEqual(latest.manifest.identityRoot, previous.manifest.identityRoot);
  assert.notDeepEqual(latest.manifest.nameRoot, previous.manifest.nameRoot);
  assert.notEqual(latest.manifest.taxonomyRoot?.sha256, previous.manifest.taxonomyRoot?.sha256,
    "Feed-language facts rebuild typed postings rather than depending on channel consensus");
  assert.deepEqual(latest.manifest.metadataNameRoot, previous.manifest.metadataNameRoot,
    "metadata name IDs are reusable when only Feed language facts change");
  assert.notEqual(latest.manifest.channelMetadataRevision, previous.manifest.channelMetadataRevision,
    "changed Feed facts advance the channel metadata fence even when the lookup root is reusable");

  const identities = await readRoutedDirectory<PublicIdentityEntry>(store, latest.manifest.identityRoot, "identity", 128, 4 * 1024 * 1024);
  const entries = identities.map((entry) => entry.value);
  const newsFeed = entries.find((entry) => entry.channelID === "news" && entry.feedID === "en");
  const newsChannel = entries.find((entry) => entry.channelID === "news" && entry.feedID === null);
  const otherFeed = entries.find((entry) => entry.channelID === "other" && entry.feedID === "shared");
  assert.equal(newsFeed?.channelLanguages, undefined, "conflicting raw Feed languages suppress channel consensus");
  assert.equal(newsChannel?.channelLanguages, undefined, "channel-only rows use the same all-Feed consensus");
  assert.deepEqual(newsFeed?.languages, ["spa"], "Feed language facts remain Feed-specific and unchanged in meaning");
  assert.deepEqual(otherFeed?.channelLanguages, ["eng"], "unrelated unanimous channel consensus is retained");

  const nameEntries = await readRoutedDirectory<{ term: string; candidates: Array<{ channelID: string; feedID: string | null; projection?: { channelLanguages?: string[] } }>; ambiguous: boolean }>(
    store, latest.manifest.nameRoot, "name", 128, 4 * 1024 * 1024
  );
  const exactNews = nameEntries.map((entry) => entry.value).find((entry) => entry.term === "news english");
  assert.equal(exactNews?.candidates[0]?.projection?.channelLanguages, undefined);

  const rootBeforeReuse = latest.manifest.identityRoot;
  const nameRootBeforeReuse = latest.manifest.nameRoot;
  const metadataNameRootBeforeReuse = latest.manifest.metadataNameRoot;
  const taxonomyRootBeforeReuse = latest.manifest.taxonomyRoot;
  const unchanged = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-02T00:00:00.000Z") });
  const reused = await publishedObjects(store);
  assert.equal(unchanged.published, false);
  assert.equal(unchanged.parsedSources, 0);
  assert.deepEqual(reused.manifest.identityRoot, rootBeforeReuse);
  assert.deepEqual(reused.manifest.nameRoot, nameRootBeforeReuse);
  assert.deepEqual(reused.manifest.metadataNameRoot, metadataNameRootBeforeReuse);
  assert.deepEqual(reused.manifest.taxonomyRoot, taxonomyRootBeforeReuse);
});

test("removing iptv-org metadata preserves exact source/channel/time programme coverage", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  const baseline = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const beforeManifest = (await publishedObjects(store)).manifest;
  const sourceID = publicEpgSources[0]!.id;
  const xmltvChannelID = "news@en";
  const beforeRows = await readRoutedDirectory<PublicProgrammeChannel>(store, beforeManifest.programmeRoot!, "programme");
  const before = beforeRows.map((entry) => entry.value).find((entry) => entry.sourceID === sourceID && entry.xmltvChannelID === xmltvChannelID);
  assert.ok(before);
  assert.deepEqual(before!.externalIdentity, { provider: "iptv-org", channelID: "news", feedID: "en" });
  const beforeNameDescriptorBytes = await store.get(
    publicProgrammeNameDescriptorKey(beforeManifest.programmeRoot!.sha256), PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes
  );
  assert.ok(beforeNameDescriptorBytes);
  const beforeNameDescriptor = JSON.parse(new TextDecoder().decode(beforeNameDescriptorBytes!)) as unknown;
  assert.ok(validPublicProgrammeNameDescriptor(beforeNameDescriptor));
  const beforeNameRows = await readRoutedDirectory<PublicProgrammeNamePosting>(store, beforeNameDescriptor.root, "programme-names");
  const beforeNewsPosting = beforeNameRows.find((entry) => entry.value.term === "news english")?.value;
  assert.ok(beforeNewsPosting?.candidates.some((candidate) => candidate.sourceID === sourceID
    && candidate.xmltvChannelID === xmltvChannelID));
  const from = Date.parse("2026-10-01T23:45:00.000Z"), to = Date.parse("2026-10-02T00:15:00.000Z");
  const coverageBefore = programmeCoverageSeconds(store, before!, from, to);
  assert.equal(coverageBefore, 1_800);

  upstream.metadataOverrides.set("iptv-org:channels", []);
  upstream.metadataOverrides.set("iptv-org:feeds", []);
  upstream.changedMetadataSourceIDs.add("iptv-org:channels");
  upstream.changedMetadataSourceIDs.add("iptv-org:feeds");
  const removed = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  assert.equal(removed.sourceProgrammeChannelCount, baseline.sourceProgrammeChannelCount);
  assert.equal(removed.programmeCount, baseline.programmeCount);
  assert.ok(baseline.externallyLinkedProgrammeChannelCount > 0);
  assert.equal(removed.externallyLinkedProgrammeChannelCount, 0);
  assert.equal(removed.externallyUnconfirmedProgrammeChannelCount, removed.sourceProgrammeChannelCount);
  const afterManifest = (await publishedObjects(store)).manifest;
  const afterRows = await readRoutedDirectory<PublicProgrammeChannel>(store, afterManifest.programmeRoot!, "programme");
  const after = afterRows.map((entry) => entry.value).find((entry) => entry.sourceID === sourceID && entry.xmltvChannelID === xmltvChannelID);
  assert.ok(after, "external deletion cannot remove the source-local tuple");
  assert.equal(after!.externalIdentity, undefined, "deleted external Channel/Feed IDs are not fabricated");
  assert.equal(after!.sourceRevision, before!.sourceRevision);
  assert.deepEqual(after!.days, before!.days, "programme shard routing stays tied to source bytes and source-local XMLTV ID");
  const afterNameDescriptorBytes = await store.get(
    publicProgrammeNameDescriptorKey(afterManifest.programmeRoot!.sha256), PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes
  );
  assert.ok(afterNameDescriptorBytes);
  const afterNameDescriptor = JSON.parse(new TextDecoder().decode(afterNameDescriptorBytes!)) as unknown;
  assert.ok(validPublicProgrammeNameDescriptor(afterNameDescriptor));
  assert.equal(afterNameDescriptor.programmeRootSHA256, afterManifest.programmeRoot!.sha256);
  assert.equal(afterNameDescriptor.root.sha256, beforeNameDescriptor.root.sha256,
    "source-name evidence is unchanged when only external Channel/Feed association disappears");
  const afterNameRows = await readRoutedDirectory<PublicProgrammeNamePosting>(store, afterNameDescriptor.root, "programme-names");
  const afterNewsPosting = afterNameRows.find((entry) => entry.value.term === "news english")?.value;
  assert.ok(afterNewsPosting?.candidates.some((candidate) => candidate.sourceID === sourceID
    && candidate.xmltvChannelID === xmltvChannelID));
  assert.equal(programmeCoverageSeconds(store, after!, from, to), coverageBefore,
    "programme coverage remains unchanged over the same source/channel/window");
});

test("source failure keeps last-good programme refs and stable stale status without pointer churn", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const beforeFailure = await publishedObjects(store);
  upstream.failingSourceIDs.add(publicEpgSources[0]!.id);
  const failed = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  const { pointer, manifest } = await publishedObjects(store);
  assert.equal(failed.staleSources, 1);
  assert.equal(failed.published, true);
  const relationSource = manifest.sources.find((source) => source.sourceID === publicEpgSources[0]!.id);
  assert.equal(relationSource?.status, "stale");
  assert.ok(relationSource?.sourceRevision);
  const beforeRows = await readRoutedDirectory<PublicProgrammeChannel>(store, (await publishedObjects(store)).manifest.programmeRoot!, "programme");
  assert.ok(beforeRows.some(({ value }) => value.sourceID === publicEpgSources[0]!.id
    && value.sourceRevision === relationSource?.sourceRevision));
  assert.equal(manifest.programmeRoot?.sha256, beforeFailure.manifest.programmeRoot?.sha256,
    "a fixed source request failure cannot erase its last-good source-local route");
  const pointerBytesBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);
  const repeated = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-02T00:00:00.000Z") });
  const pointerBytesAfter = await store.get(PUBLIC_EPG_CURRENT_KEY);
  assert.equal(repeated.published, false);
  assert.deepEqual(pointerBytesAfter, pointerBytesBefore);
  assert.equal((await publishedObjects(store)).pointer.revision, pointer.revision);
});

test("partial immutable upload failure never switches the current pointer", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  store.activeImmutablePuts = 0;
  store.maxConcurrentImmutablePuts = 0;
  store.immutablePutDelayMs = 2;
  const pointerBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);
  const stateBefore = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY);
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
  store.failPut = (key) => key.endsWith(".xml.gz");
  await assert.rejects(
    runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") }),
    /r2_put_failed/u
  );
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointerBefore);
  assert.deepEqual(await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY), stateBefore);
  assert.ok(store.maxConcurrentImmutablePuts <= 8);
  assert.equal(store.activeImmutablePuts, 0, "failed publication drains every active immutable write before release");
});

test("a PUT-budget interruption resumes missing artifacts within the same ceiling on the next run", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  const progress: Array<{ r2Puts?: number }> = [];
  const run = (clock: number) => runPublisher({ store, fetchImpl: upstream.fetch,
    now: () => new Date("2026-10-01T12:00:00.000Z"), leaseClock: () => clock,
    budgets: { maxR2PutRequests: 96 }, onProgress: (value) => progress.push(value) });
  await assert.rejects(run(0), /publisher_r2_write_budget_exceeded/u);
  assert.equal(progress.at(-1)?.r2Puts, 96);
  assert.equal(await store.get(PUBLIC_EPG_CURRENT_KEY), null);
  const stagedKeys = new Set(store.objects.keys());
  let repeatedImmutableAttempts = 0;
  store.beforeConditionalPut = (key) => {
    if (stagedKeys.has(key) && (key.startsWith(PUBLIC_EPG_PREFIX + "objects/")
      || key.startsWith(PUBLIC_EPG_PREFIX + "manifests/")
      || key.startsWith(PUBLIC_EPG_PREFIX + "publisher/source-cache/"))) repeatedImmutableAttempts += 1;
  };
  // An exhausted write budget may leave the lease unreleased; the next normal
  // scheduled invocation must reclaim it only after its existing TTL expires.
  const recovered = await run(31 * 60 * 1_000);
  assert.equal(recovered.published, true);
  assert.ok(recovered.r2PutRequests <= 96);
  assert.ok(recovered.r2GetRequests <= PUBLISHER_RUN_LIMITS.maxR2GetRequests);
  assert.ok(recovered.r2GetBytes <= PUBLISHER_RUN_LIMITS.maxR2GetBytes);
  assert.equal(repeatedImmutableAttempts, 0);
  assert.equal((await publishedObjects(store)).pointer.revision, recovered.revision);
});

test("the complete source-local graph can publish more than 10,000 XML parts without external matches", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  const count = 5_100;
  const xml = "<tv>" + Array.from({ length: count }, (_, index) => {
    const id = `budget-${index}`;
    return `<channel id="${id}"><display-name>Budget ${index}</display-name></channel>`
      + `<programme channel="${id}" start="20261001090000 +0000" stop="20261001100000 +0000"><title>First day</title></programme>`
      + `<programme channel="${id}" start="20261002090000 +0000" stop="20261002100000 +0000"><title>Second day</title></programme>`;
  }).join("") + "</tv>";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url === publicEpgSources[0]!.publicURL
      ? new Response(publicEpgSources[0]!.publicURL.endsWith(".gz") ? gzipSync(xml) : xml,
        { headers: { etag: '"large-source-local-fixture"' } })
      : upstream.fetch(input, init);
  };
  const result = await runPublisher({ store, fetchImpl, now: () => new Date("2026-10-01T12:00:00.000Z") });
  assert.equal(result.published, true);
  assert.ok(result.r2PutRequests > 10_000 && result.r2PutRequests <= PUBLISHER_RUN_LIMITS.maxR2PutRequests);
  const { manifest } = await publishedObjects(store);
  const channels = await readRoutedDirectory<PublicProgrammeChannel>(store, manifest.programmeRoot!, "programme", 100_000, 64 * 1024 * 1024);
  const rows = channels.filter(({ value }) => value.sourceID === publicEpgSources[0]!.id);
  assert.equal(rows.length, count);
  assert.ok(rows.every(({ value }) => !value.externalIdentity && value.days.length === 2));
  assert.equal(rows.reduce((sum, { value }) => sum + value.days.reduce((total, day) => total + day.parts.length, 0), 0), count * 2);
});

test("write-budget exhaustion preserves an existing current pointer and committed state", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const pointer = await store.get(PUBLIC_EPG_CURRENT_KEY);
  const state = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY);
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
  const progress: Array<{ r2Puts?: number; limits?: typeof PUBLISHER_RUN_LIMITS }> = [];
  const writesBefore = store.puts.length;
  await assert.rejects(runPublisher({ store, fetchImpl: upstream.fetch,
    now: () => new Date("2026-10-01T18:00:00.000Z"), budgets: { maxR2PutRequests: 16 },
    onProgress: (value) => progress.push(value) }), /publisher_r2_write_budget_exceeded/u);
  assert.equal(progress[0]?.limits?.maxR2PutRequests, 16);
  assert.equal(progress.at(-1)?.r2Puts, 16);
  assert.equal(store.puts.length - writesBefore, 16);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointer);
  assert.deepEqual(await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY), state);
});

test("a failed pointer commit resumes its complete staged graph within a small PUT budget", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const priorPointer = await store.get(PUBLIC_EPG_CURRENT_KEY);
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
  store.failPut = (key) => key === PUBLIC_EPG_CURRENT_KEY;
  await assert.rejects(runPublisher({ store, fetchImpl: upstream.fetch,
    now: () => new Date("2026-10-01T18:00:00.000Z") }), /r2_put_failed/u);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), priorPointer);

  store.failPut = null;
  let immutableAttempts = 0;
  store.beforeConditionalPut = (key) => {
    if (key.startsWith(PUBLIC_EPG_PREFIX + "objects/") || key.startsWith(PUBLIC_EPG_PREFIX + "manifests/")
      || key.startsWith(PUBLIC_EPG_PREFIX + "source-names/")
      || key.startsWith(PUBLIC_EPG_PREFIX + "publisher/source-cache/")) immutableAttempts += 1;
  };
  const recovered = await runPublisher({ store, fetchImpl: upstream.fetch,
    now: () => new Date("2026-10-01T18:00:00.000Z"), budgets: { maxR2PutRequests: 64 } });
  assert.equal(recovered.published, true);
  assert.equal(immutableAttempts, 0, "existing XML/JSON, raw source cache and manifest must all avoid PUT attempts");
  assert.ok(recovered.r2PutRequests <= 64);
  assert.notDeepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), priorPointer);
  assert.equal((await publishedObjects(store)).pointer.revision, recovered.revision);
});

test("source-name companion is recreated from a reused programmeRoot without changing the manifest", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const before = await publishedObjects(store);
  const descriptorKey = publicProgrammeNameDescriptorKey(before.manifest.programmeRoot!.sha256);
  const descriptorBefore = await store.get(descriptorKey, PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes);
  assert.ok(descriptorBefore);
  store.objects.delete(descriptorKey);

  const rebuilt = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  const after = await publishedObjects(store);
  assert.equal(rebuilt.published, false);
  assert.equal(rebuilt.parsedSources, 0);
  assert.equal(rebuilt.reusedSources, 18);
  assert.deepEqual(after.pointer, before.pointer);
  assert.deepEqual(after.manifest, before.manifest, "the companion is not a manifest field or revision input");
  const descriptorAfter = await store.get(descriptorKey, PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes);
  assert.ok(descriptorAfter, "reuseExistingRoots still reconstructs the companion from the verified programmeRoot");
  assert.deepEqual(descriptorAfter, descriptorBefore, "the rebuilt descriptor is deterministic for the same programmeRoot digest");
  const descriptor = JSON.parse(new TextDecoder().decode(descriptorAfter!)) as unknown;
  assert.ok(validPublicProgrammeNameDescriptor(descriptor));
  assert.equal(descriptor.programmeRootSHA256, before.manifest.programmeRoot!.sha256);
});

test("a failed source-name companion write cannot publish a new current pointer", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const pointerBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
  store.failPut = (key) => key.startsWith(PUBLIC_EPG_PREFIX + "source-names/");

  await assert.rejects(runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") }), /r2_put_failed/u);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointerBefore,
    "all companion artifacts must validate before the mutable current pointer can move");
});

test("a missing reused XML object blocks a changed pointer publication", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const pointerBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);
  const stateBytes = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY, 1024 * 1024);
  assert.ok(stateBytes);
  const state = JSON.parse(new TextDecoder().decode(stateBytes!)) as {
    sources: Record<string, { indexRef: ArtifactRef }>;
  };
  const unchangedSource = publicEpgSources[1]!;
  const index = await getVerifiedJSON<GeneratedSourceIndex>(store, state.sources[unchangedSource.id]!.indexRef, 64 * 1024 * 1024);
  const missingXMLKey = index.entries.flatMap((entry) => entry.days.flatMap((day) => day.parts)).at(0)?.key;
  assert.ok(missingXMLKey);
  store.objects.delete(missingXMLKey!);
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);

  await assert.rejects(
    runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") }),
    /published_xml_hash_invalid/u
  );
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointerBefore);
});

test("R2 read-budget exhaustion leaves the current pointer unchanged", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const pointerBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);

  await assert.rejects(
    runPublisher({
      store,
      fetchImpl: upstream.fetch,
      now: () => new Date("2026-10-01T18:00:00.000Z"),
      budgets: { maxR2GetRequests: 1 }
    }),
    /publisher_r2_get_budget_exceeded/u
  );
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointerBefore);
});

test("a competing publisher cannot take the active R2 lease", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  const attempts = await Promise.allSettled([
    runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") }),
    runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") })
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /publisher_lease_busy/u);
  assert.ok(await store.get(PUBLIC_EPG_CURRENT_KEY, 2048));
});

test("an expired publisher lease is fenced before it can switch the pointer, then safely reclaimed", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  let clockCalls = 0;
  await assert.rejects(runPublisher({
    store,
    fetchImpl: upstream.fetch,
    leaseClock: () => clockCalls++ === 0 ? 0 : 30 * 60 * 1000 + 1,
    now: () => new Date("2026-10-01T12:00:00.000Z")
  }), /publisher_lease_lost/u);
  assert.equal(await store.get(PUBLIC_EPG_CURRENT_KEY, 2048), null);
  const recovered = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") });
  assert.equal(recovered.published, true);
  assert.ok(await store.get(PUBLIC_EPG_CURRENT_KEY, 2048));
});

test("pointer compare-and-swap preserves a concurrent current pointer", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
  const concurrentValue = new TextEncoder().encode('{"writer":"other"}');
  let changed = false;
  upstream.beforeFetch = (url) => {
    if (changed || url !== publicEpgSources[0]!.publicURL) return;
    changed = true;
    store.objects.set(PUBLIC_EPG_CURRENT_KEY, {
      value: concurrentValue,
      metadata: { contentType: "application/json", cacheControl: "no-cache" },
      modifiedAt: Date.now()
    });
  };
  await assert.rejects(
    runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T18:00:00.000Z") }),
    /publisher_pointer_conflict/u
  );
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), concurrentValue);
});

test("compressed XML objects contain one canonical channel and no source-private metadata", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const xmlObjects = [...store.objects.entries()].filter(([key]) => key.startsWith("public-epg/v1/objects/") && key.endsWith(".xml.gz"));
  assert.ok(xmlObjects.length > 0);
  for (const [, object] of xmlObjects.slice(0, 2)) {
    const xml = gunzipSync(object.value).toString("utf8");
    assert.equal((xml.match(/<channel\b/gu) ?? []).length, 1);
    assert.match(xml, /<channel id="news@en">/u);
    assert.doesNotMatch(xml, /https?:|stream|referrer|user_agent/iu);
  }
});

test("transient conditional writes charge each retry and reconcile committed lost acknowledgements", async () => {
  const upstream = new FixedPublicUpstream();
  const baselineStore = new MemoryObjectStore();
  const baseline = await runPublisher({ store: baselineStore, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const store = new MemoryObjectStore();
  const write = store.putConditional.bind(store);
  let transient = false, lostCreate = false, lostCAS = false;
  store.putConditional = async (key, value, metadata, condition) => {
    if (!transient && key.startsWith("public-epg/v1/objects/")) {
      transient = true; throw new Error("r2_put_failed:502:Error");
    }
    const etag = await write(key, value, metadata, condition);
    if (!lostCreate && key === "public-epg/v1/publisher/lease.json" && "ifNoneMatch" in condition) {
      lostCreate = true; throw new Error("r2_put_failed:0:TimeoutError");
    }
    if (!lostCAS && key === "public-epg/v1/publisher/lease.json" && "ifMatch" in condition) {
      lostCAS = true; throw new Error("r2_put_failed:503:Error");
    }
    return etag;
  };
  const result = await runPublisher({ store, fetchImpl: new FixedPublicUpstream().fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  assert.ok(transient && lostCreate && lostCAS); assert.equal(result.published, true);
  assert.equal(result.r2PutRequests, baseline.r2PutRequests + 1);
  assert.equal(result.r2GetRequests, baseline.r2GetRequests + 3);
  assert.equal((await publishedObjects(store)).manifest.revision, (await publishedObjects(baselineStore)).manifest.revision);
});

test("transient retries preserve budget ceilings and never retry a foreign mutable CAS", async () => {
  const store = new MemoryObjectStore(), write = store.putConditional.bind(store);
  const progress: Array<{ r2Puts?: number }> = [];
  let calls = 0;
  store.putConditional = async (key, value, metadata, condition) => {
    if (key.startsWith("public-epg/v1/objects/")) { calls++; throw new Error("r2_put_failed:502:Error"); }
    return write(key, value, metadata, condition);
  };
  await assert.rejects(runPublisher({ store, fetchImpl: new FixedPublicUpstream().fetch,
    now: () => new Date("2026-10-01T12:00:00.000Z"), budgets: { maxR2PutRequests: 3 },
    onProgress: (value) => progress.push(value) }), /publisher_r2_write_budget_exceeded/);
  assert.equal(progress.at(-1)?.r2Puts, 3, "budget failures report actual attempts without charging an unissued PUT");
  assert.ok(calls <= 2); assert.equal(await store.get(PUBLIC_EPG_CURRENT_KEY), null);
  const foreignStore = new MemoryObjectStore(), foreignWrite = foreignStore.putConditional.bind(foreignStore);
  let foreignCASAttempts = 0;
  foreignStore.putConditional = async (key, value, metadata, condition) => {
    if (key === "public-epg/v1/publisher/lease.json" && "ifMatch" in condition && foreignCASAttempts++ === 0) {
      await foreignWrite(key, new TextEncoder().encode('{"schemaVersion":1,"owner":"foreign-owner","expiresAt":9999999999999}'), metadata, condition);
      throw new Error("r2_put_failed:502:Error");
    }
    return foreignWrite(key, value, metadata, condition);
  };
  await assert.rejects(runPublisher({ store: foreignStore, fetchImpl: new FixedPublicUpstream().fetch,
    now: () => new Date("2026-10-01T12:00:00.000Z") }), /publisher_lease_lost/);
  assert.equal(foreignCASAttempts, 1); assert.equal(await foreignStore.get(PUBLIC_EPG_CURRENT_KEY), null);
});


test("publication accepts repeated quality labels and rejects oversized seed IDs without moving identity", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  upstream.metadataOverrides.set("iptv-org:channels", [
    { id: "station", name: "Station HD HD" },
    { id: "x".repeat(129), name: "Invalid" }
  ]);
  upstream.metadataOverrides.set("iptv-org:feeds", [{ id: "main", channel: "station", name: "English HD HD" }]);
  const result = await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  assert.equal(result.published, true);
  const { manifest } = await publishedObjects(store);
  const entries = await readRoutedDirectory<NameEntryRecord>(store, manifest.metadataNameRoot!, "metadata-name");
  assert.ok(entries.some((entry) => entry.value.term === "station"));
  assert.ok(entries.every((entry) => entry.value.candidates.every((candidate) =>
    validPublicChannelCandidate(candidate) && candidate.channelID === "station")));
});

test("metadata validation fails closed with a single bounded structural diagnostic", () => {
  for (const entry of [
    { term: "station hd", ambiguous: false, candidates: [{ provider: "iptv-org" as const, channelID: "station", feedID: null, matchKind: "exact" as const }] },
    { term: "station", ambiguous: false, candidates: [{ provider: "iptv-org" as const, channelID: "x".repeat(129), feedID: null, matchKind: "exact" as const }] }
  ]) {
    const diagnostics: unknown[] = [];
    assert.throws(() => validateMetadataNameEntries([entry, entry], (diagnostic) => diagnostics.push(diagnostic)),
      /^Error: metadata_name_index_invalid$/u);
    assert.equal(diagnostics.length, 1);
    const diagnostic = diagnostics[0] as { reason: string; termSha256: string };
    assert.equal(diagnostic.reason, entry.term === "station hd" ? "term_not_normalized" : "candidate_invalid");
    assert.equal(diagnostic.termSha256, sha256(entry.term));
    assert.ok(JSON.stringify(diagnostic).length < 256);
    assert.equal(JSON.stringify(diagnostic).includes(entry.term), false);
    assert.equal(JSON.stringify(diagnostic).includes(entry.candidates[0]!.channelID), false);
  }
});


test("backfill repairs a pre-companion publication without upstream, pointer or state mutation", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const before = await publishedObjects(store);
  const upstreamRequests = new Map(upstream.requests);
  const pointer = await store.get(PUBLIC_EPG_CURRENT_KEY), state = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY);
  const oldCompanion = await removeProgrammeNameCompanion(store, before.manifest.programmeRoot!);
  const result = await backfillProgrammeNameCompanion({ store });
  assert.ok(result.channelCount > 0);
  assert.equal(result.programmeRootSHA256, before.manifest.programmeRoot!.sha256);
  assert.deepEqual(await store.get(oldCompanion.descriptorKey), oldCompanion.descriptorBytes);
  const repairedDescriptorBytes = await store.get(oldCompanion.descriptorKey);
  assert.ok(repairedDescriptorBytes);
  const repairedDescriptor = JSON.parse(new TextDecoder().decode(repairedDescriptorBytes!)) as unknown;
  assert.ok(validPublicProgrammeNameDescriptor(repairedDescriptor));
  assert.equal(repairedDescriptor.programmeRootSHA256, before.manifest.programmeRoot!.sha256);
  const repairedRows = await readRoutedDirectory<PublicProgrammeNamePosting>(
    store, repairedDescriptor.root, "programme-names", 128, 4 * 1024 * 1024
  );
  assert.ok(repairedRows.length > 0, "the descriptor's complete reachable name graph is readable after backfill");
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointer);
  assert.deepEqual(await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY), state);
  assert.deepEqual(new Map(upstream.requests), upstreamRequests, "backfill performs no upstream fetches");
  assert.ok(oldCompanion.graphKeys.every((key) => store.objects.has(key)), "backfill restores the removed graph refs");
  const repeat = await backfillProgrammeNameCompanion({ store });
  assert.equal(repeat.usage.r2Puts, 3, "only acquire/renew/renew lease writes; immutable objects need no PUT");
  assert.deepEqual(await store.get(oldCompanion.descriptorKey), repairedDescriptorBytes);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointer);
  assert.deepEqual(await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY), state);
});

test("backfill exits on a busy lease without changing pointer, state, or a missing companion", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const before = await publishedObjects(store);
  const pointer = await store.get(PUBLIC_EPG_CURRENT_KEY), state = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY);
  const missing = await removeProgrammeNameCompanion(store, before.manifest.programmeRoot!);
  const leaseKey = PUBLIC_EPG_PREFIX + "publisher/lease.json";
  const priorLease = await store.getWithETag(leaseKey, 2048);
  assert.ok(priorLease);
  await store.putConditional(leaseKey, jsonBytes({ schemaVersion: 1, owner: "busy-test-owner", expiresAt: Date.now() + 60_000 }),
    { contentType: "application/json", cacheControl: "no-store" }, { ifMatch: priorLease!.etag });
  const putsBeforeBackfill = [...store.puts];

  await assert.rejects(backfillProgrammeNameCompanion({ store }), /publisher_lease_busy/u);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointer);
  assert.deepEqual(await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY), state);
  assert.equal(await store.get(missing.descriptorKey), null);
  assert.ok(missing.graphKeys.every((key) => !store.objects.has(key)));
  assert.deepEqual(store.puts, putsBeforeBackfill, "a busy backfill makes no R2 writes");
});

test("backfill budget abort leaves pointer, state, and missing companion unchanged", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const before = await publishedObjects(store);
  const pointer = await store.get(PUBLIC_EPG_CURRENT_KEY), state = await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY);
  const missing = await removeProgrammeNameCompanion(store, before.manifest.programmeRoot!);

  await assert.rejects(backfillProgrammeNameCompanion({ store, budgets: { maxR2PutRequests: 2 } }),
    /publisher_r2_write_budget_exceeded/u);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointer);
  assert.deepEqual(await store.get(PUBLIC_EPG_PUBLISHER_STATE_KEY), state);
  assert.equal(await store.get(missing.descriptorKey), null);
  assert.ok(missing.graphKeys.every((key) => !store.objects.has(key)),
    "the first immutable graph write is rejected after lease writes exhaust the budget");
});

test("backfill fails closed on corrupt programme bytes and retains the current publication", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  await runPublisher({ store, fetchImpl: upstream.fetch, now: () => new Date("2026-10-01T12:00:00.000Z") });
  const before = await publishedObjects(store);
  const pointer = await store.get(PUBLIC_EPG_CURRENT_KEY);
  const key = publicProgrammeNameDescriptorKey(before.manifest.programmeRoot!.sha256);
  store.objects.delete(key);
  store.objects.get(before.manifest.programmeRoot!.key)!.value = new Uint8Array([0, 1, 2]);
  await assert.rejects(backfillProgrammeNameCompanion({ store }));
  assert.equal(await store.get(key), null);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointer);
});


test("retention timeout after publication drains active reads before releasing the lease", { timeout: 10_000 }, async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  const now = () => new Date("2026-10-01T12:00:00.000Z");
  await runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => 0 });
  const pointerBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);
  const refs = addRetainedFixtureGraph(store, 20);
  const fixtureKeys = new Set(refs.map((ref) => ref.key));
  upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
  const clock = 60 * 60 * 60 * 1_000;
  let startAllReads!: () => void, releaseInFlight!: () => void, reportFailure!: () => void;
  const allReadsStarted = new Promise<void>((resolve) => { startAllReads = resolve; });
  const inFlight = new Promise<void>((resolve) => { releaseInFlight = resolve; });
  const failure = new Promise<void>((resolve) => { reportFailure = resolve; });
  const read = store.get.bind(store), write = store.putConditional.bind(store);
  const requested: string[] = [];
  let active = 0, maxActive = 0, failures = 0, leaseReleased = false, settled = false;
  store.get = async (key, maximum) => {
    if (!fixtureKeys.has(key)) return read(key, maximum);
    requested.push(key);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 8) startAllReads();
    try {
      if (key === refs[0]!.key) {
        await allReadsStarted;
        if (++failures === 3) reportFailure();
        throw new Error("r2_get_failed:0:TimeoutError");
      }
      await inFlight;
      return await read(key, maximum);
    } finally { active -= 1; }
  };
  store.putConditional = async (key, value, metadata, condition) => {
    if (key === PUBLIC_EPG_PREFIX + "publisher/lease.json"
      && JSON.parse(new TextDecoder().decode(value)).expiresAt === clock) {
      leaseReleased = true;
      assert.equal(active, 0, "release must wait for every active retention GET to settle");
    }
    return write(key, value, metadata, condition);
  };
  const progress: PublisherProgress[] = [];
  const publication = runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => clock,
    onProgress: (value) => progress.push(value) });
  void publication.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([failure, publication.then(() => { throw new Error("retention fixture was not read"); })]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(active, 7, "other reads remain in flight when the timeout retry limit is reached");
    assert.equal(settled, false, "the failed run must join its active reads before returning");
    assert.equal(leaseReleased, false);
    assert.equal(requested.length, 10, "eight initial GETs plus two timeout retries exhaust the active batch only");
    assert.ok(requested.every((key) => refs.slice(0, 8).some((ref) => ref.key === key)),
      "the failed read must stop dispatching queued prior-graph GETs");
  } finally { releaseInFlight(); }
  const result = await publication;
  assert.equal(maxActive, 8);
  assert.equal(active, 0);
  assert.equal(leaseReleased, true);
  assert.equal(requested.length, 10, "no GET may escape after the retention failure or lease release");
  assert.equal(result.published, true);
  assert.equal(result.retentionRan, true);
  assert.equal(result.retentionStatus, "failed");
  assert.equal(result.retentionError, "r2_get_failed:0:TimeoutError");
  assert.equal(result.retentionErrorKey, refs[0]!.key);
  assert.equal(result.retentionFailureStage, "mark");
  assert.equal(result.r2DeleteRequests, 0);
  assert.equal(result.r2DeleteObjects, 0);
  assert.equal(publisherStateForRetentionTest(store).lastRetentionAt, 0);
  assert.notDeepEqual(await read(PUBLIC_EPG_CURRENT_KEY), pointerBefore);
  assert.equal((await publishedObjects(store)).pointer.revision, result.revision);
  assert.ok(progress.some((value) => value.phase === "publication" && value.published === true
    && value.revision === result.revision));
  assert.ok(progress.some((value) => value.phase === "retention" && value.retentionStatus === "failed"
    && value.retentionError === result.retentionError && value.retentionErrorKey === refs[0]!.key
    && value.retentionFailureStage === "mark"));

  store.get = read;
  const recovered = await runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => clock + 1 });
  assert.equal(recovered.published, false);
  assert.equal(recovered.retentionStatus, "succeeded");
  assert.equal(recovered.retentionError, null);
  assert.equal(recovered.retentionErrorKey, null);
  assert.equal(recovered.retentionFailureStage, null);
  assert.equal(publisherStateForRetentionTest(store).lastRetentionAt, clock + 1);
  assert.equal(recovered.revision, result.revision);
});

for (const changed of [true, false]) {
  test(`retention list failure remains visible after ${changed ? "new" : "unchanged"} publication and recovers`, async () => {
    const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
    const now = () => new Date("2026-10-01T12:00:00.000Z");
    await runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => 0 });
    const pointerBefore = await store.get(PUBLIC_EPG_CURRENT_KEY);
    if (changed) upstream.changedSourceIDs.add(publicEpgSources[0]!.id);
    const orphanKey = PUBLIC_EPG_PREFIX + "objects/" + "f".repeat(64) + ".json.gz";
    store.objects.set(orphanKey, {
      value: new Uint8Array([1, 2, 3]),
      metadata: { contentType: "application/json", contentEncoding: "gzip", cacheControl: "public, immutable" },
      modifiedAt: 0
    });
    const list = store.list.bind(store);
    let lists = 0;
    store.list = async (prefix, cursor) => {
      if (++lists === 2) throw new Error("r2_list_failed:503:Error");
      return list(prefix, cursor);
    };
    const clock = 60 * 60 * 60 * 1_000;
    const result = await runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => clock });
    assert.equal(result.published, changed);
    assert.equal(result.retentionRan, true);
    assert.equal(result.retentionStatus, "failed");
    assert.equal(result.retentionError, "r2_list_failed:503:Error");
    assert.equal(result.retentionErrorKey, null);
    assert.equal(result.retentionFailureStage, "list");
    assert.equal(result.r2DeleteRequests, 0);
    assert.equal(result.r2DeleteObjects, 0);
    assert.equal(store.objects.has(orphanKey), true, "incomplete enumeration must not delete any candidate");
    assert.equal(publisherStateForRetentionTest(store).lastRetentionAt, 0);
    const pointerAfter = await store.get(PUBLIC_EPG_CURRENT_KEY);
    if (changed) assert.notDeepEqual(pointerAfter, pointerBefore);
    else assert.deepEqual(pointerAfter, pointerBefore);
    assert.equal((await publishedObjects(store)).pointer.revision, result.revision);

    store.list = list;
    const recovered = await runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => clock + 1 });
    assert.equal(recovered.published, false);
    assert.equal(recovered.retentionRan, true);
    assert.equal(recovered.retentionStatus, "succeeded");
    assert.equal(recovered.retentionError, null);
    assert.equal(recovered.retentionErrorKey, null);
    assert.equal(recovered.retentionFailureStage, null);
    assert.ok(recovered.retentionObjects > 0);
    assert.ok((recovered.retentionNamespaceBytes ?? 0) > 0);
    assert.equal(recovered.r2DeleteObjects, 1);
    assert.equal(store.objects.has(orphanKey), false);
    assert.equal(publisherStateForRetentionTest(store).lastRetentionAt, clock + 1);
    assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointerAfter);
  });
}

test("a completed retention sweep with a failed checkpoint preserves publication and retries the checkpoint next run", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  const now = () => new Date("2026-10-01T12:00:00.000Z");
  const orphanKey = PUBLIC_EPG_PREFIX + "objects/" + "f".repeat(64) + ".json.gz";
  store.objects.set(orphanKey, {
    value: new Uint8Array([1, 2, 3]),
    metadata: { contentType: "application/json", contentEncoding: "gzip", cacheControl: "public, immutable" },
    modifiedAt: 0
  });
  const write = store.putConditional.bind(store);
  store.putConditional = async (key, value, metadata, condition) => {
    if (key === PUBLIC_EPG_PUBLISHER_STATE_KEY
      && JSON.parse(new TextDecoder().decode(value)).lastRetentionAt !== undefined) {
      throw new Error("r2_put_failed");
    }
    return write(key, value, metadata, condition);
  };
  const clock = 60 * 60 * 60 * 1_000;
  const progress: PublisherProgress[] = [];
  const result = await runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => clock,
    onProgress: (value) => progress.push(value) });
  assert.equal(result.published, true);
  assert.equal(result.retentionRan, true);
  assert.equal(result.retentionStatus, "failed");
  assert.equal(result.retentionError, "r2_put_failed");
  assert.equal(result.retentionErrorKey, PUBLIC_EPG_PUBLISHER_STATE_KEY);
  assert.equal(result.retentionFailureStage, "checkpoint");
  assert.equal(result.r2DeleteObjects, 1);
  assert.ok(result.retentionObjects > 0, "completed sweep measurements survive checkpoint failure");
  assert.ok((result.retentionNamespaceBytes ?? 0) > 0);
  assert.equal(store.objects.has(orphanKey), false);
  assert.equal(publisherStateForRetentionTest(store).lastRetentionAt, undefined,
    "a failed checkpoint cannot suppress the next scheduled retention attempt");
  const pointerAfter = await store.get(PUBLIC_EPG_CURRENT_KEY);
  assert.equal((await publishedObjects(store)).pointer.revision, result.revision);
  assert.ok(progress.some((value) => value.phase === "retention" && value.retentionStatus === "failed"
    && value.retentionFailureStage === "checkpoint" && value.retentionErrorKey === PUBLIC_EPG_PUBLISHER_STATE_KEY));

  store.putConditional = write;
  const recovered = await runPublisher({ store, fetchImpl: upstream.fetch, now, leaseClock: () => clock + 1 });
  assert.equal(recovered.published, false);
  assert.equal(recovered.retentionStatus, "succeeded");
  assert.equal(recovered.retentionError, null);
  assert.equal(recovered.retentionErrorKey, null);
  assert.equal(recovered.retentionFailureStage, null);
  assert.equal(publisherStateForRetentionTest(store).lastRetentionAt, clock + 1);
  assert.deepEqual(await store.get(PUBLIC_EPG_CURRENT_KEY), pointerAfter);
});

test("a lease renewal failure after sweeping is not attributed to the state checkpoint", async () => {
  const store = new MemoryObjectStore(), upstream = new FixedPublicUpstream();
  const list = store.list.bind(store), read = store.getWithETag.bind(store);
  let lists = 0, failedRenewal = false;
  store.list = async (...args) => { const page = await list(...args); lists++; return page; };
  store.getWithETag = async (key, maximum) => {
    if (lists >= 2 && !failedRenewal && key === PUBLIC_EPG_PREFIX + "publisher/lease.json") {
      failedRenewal = true;
      throw new Error("r2_get_failed:0:TimeoutError");
    }
    return read(key, maximum);
  };
  const result = await runPublisher({ store, fetchImpl: upstream.fetch,
    now: () => new Date("2026-10-01T12:00:00.000Z") });
  assert.equal(result.published, true);
  assert.equal(result.retentionStatus, "failed");
  assert.equal(result.retentionFailureStage, "checkpoint");
  assert.equal(result.retentionError, "r2_get_failed:0:TimeoutError");
  assert.equal(result.retentionErrorKey, null);
  assert.ok(result.retentionObjects > 0);
  assert.equal(publisherStateForRetentionTest(store).lastRetentionAt, undefined);
  assert.equal((await publishedObjects(store)).pointer.revision, result.revision);
});
