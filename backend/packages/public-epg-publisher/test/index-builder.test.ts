import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_EPG_LIMITS,
  PUBLIC_EPG_SOURCE_IDS,
  identityKey,
  normalizePublicProgrammeName,
  taxonomyDirectoryKey,
  validPublicTaxonomyRoot,
  type PublicAccessEntry,
  type PublicProgrammeChannel,
  type PublicProgrammeNamePosting,
  type PublicTaxonomyPosting
} from "@vocaltv/public-epg-contract";
import { sha256 } from "../src/encoding.js";
import {
  accessRecords,
  programmeNameRecords,
  readRoutedDirectory,
  readTaxonomyPostingPages,
  taxonomyRecords,
  writeRoutedDirectory,
  writeTaxonomyDirectory
} from "../src/index-builder.js";
import { MemoryObjectStore } from "./fixtures.js";

test("index builder packs adjacent routed identity prefixes into bounded shared leaves", async () => {
  const records: Array<{ hash: string; value: { channelID: string; feedID: null; padding: string } }> = [];
  for (let candidate = 0; records.length < 256; candidate += 1) {
    const value = { channelID: `channel-${candidate}`, feedID: null as null, padding: "x".repeat(512) };
    const hash = sha256(identityKey(value));
    if (hash.startsWith("aa")) records.push({ hash, value });
  }

  const store = new MemoryObjectStore();
  const root = await writeRoutedDirectory(store, "identity", records);
  const restored = await readRoutedDirectory<typeof records[number]["value"]>(store, root, "identity", 40, 1024 * 1024);

  assert.equal(restored.length, records.length);
  assert.ok(restored.every((entry) => entry.hash.startsWith("aa")));
  assert.ok(store.puts.length <= 12, `expected packed tree, got ${store.puts.length} objects`);
  for (const object of store.objects.values()) {
    if (object.metadata.contentType !== "application/json") continue;
    const value: unknown = JSON.parse((await import("node:zlib")).gunzipSync(object.value).toString("utf8"));
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024);
  }
});

test("small roots and name leaves preserve every routed term including a larger single posting", async () => {
  const records = Array.from({ length: 1200 }, (_, index) => {
    const value = { term: `channel-${index}`, padding: "x".repeat(400) };
    return { hash: sha256(value.term), value };
  });
  const large = { term: "single-larger-posting", padding: "z".repeat(12 * 1024) };
  records.push({ hash: sha256(large.term), value: large });
  const store = new MemoryObjectStore();
  const rootRef = await writeRoutedDirectory(store, "name", records);
  const { gunzipSync } = await import("node:zlib");
  const root = JSON.parse(gunzipSync(store.objects.get(rootRef.key)!.value).toString("utf8"));
  assert.equal(root.entries.length, 16);
  assert.ok(root.entries.every((entry: { prefix: string }) => /^[a-f0-9]$/u.test(entry.prefix)));
  assert.ok(rootRef.bytes < 8 * 1024);
  let largerSingle = 0;
  for (const object of store.objects.values()) {
    const raw = gunzipSync(object.value), node = JSON.parse(raw.toString("utf8"));
    if (node.kind !== "name-bucket") continue;
    assert.ok(raw.byteLength <= 64 * 1024);
    if (raw.byteLength > 8 * 1024) {
      assert.equal(node.entries.length, 1);
      assert.equal(node.entries[0].term, large.term);
      largerSingle++;
    }
  }
  assert.equal(largerSingle, 1);
  const restored = await readRoutedDirectory<typeof large>(store, rootRef, "name", 500, 1024 * 1024);
  assert.deepEqual(restored.map((entry) => entry.value.term).sort(), records.map((entry) => entry.value.term).sort());
});

test("root bucket writes overlap within a bound and keep identical output order", async () => {
  const records = Array.from({ length: 256 }, (_, index) => {
    const value = { channelID: `bounded-${index}`, feedID: null as null };
    return { hash: sha256(identityKey(value)), value };
  });
  const delayed = new MemoryObjectStore();
  delayed.immutablePutDelayForKey = (key) => {
    const tail = key.match(/([0-9a-f]{2})\.json\.gz$/u)?.[1] ?? "00";
    return 1 + Number.parseInt(tail, 16) % 5;
  };
  const delayedRoot = await writeRoutedDirectory(delayed, "identity", records);

  const immediate = new MemoryObjectStore();
  const immediateRoot = await writeRoutedDirectory(immediate, "identity", records);
  assert.equal(delayedRoot.sha256, immediateRoot.sha256);
  assert.ok(delayed.maxConcurrentImmutablePuts > 1);
  assert.ok(delayed.maxConcurrentImmutablePuts <= 8);
  assert.equal(delayed.activeImmutablePuts, 0);

  const restored = await readRoutedDirectory<typeof records[number]["value"]>(
    delayed, delayedRoot, "identity", 300, 1024 * 1024
  );
  assert.deepEqual(restored.map((entry) => entry.value).sort((a, b) => a.channelID.localeCompare(b.channelID)),
    records.map((entry) => entry.value).sort((a, b) => a.channelID.localeCompare(b.channelID)));
});

test("access directory routes directly by the versioned public access digest", async () => {
  const entries: PublicAccessEntry[] = Array.from({ length: 256 }, (_, index) => {
    const accessDigest = sha256(`public-access-${index}`);
    return {
      accessDigest,
      members: [{ channelID: `channel-${index}`, feedID: null }],
      ambiguous: false
    };
  });
  const store = new MemoryObjectStore();
  const root = await writeRoutedDirectory(store, "access", accessRecords(entries));
  const restored = await readRoutedDirectory<PublicAccessEntry>(store, root, "access", 300, 1024 * 1024);
  assert.equal(restored.length, entries.length);
  assert.ok(restored.every(({ hash, value }) => hash === value.accessDigest));
  assert.deepEqual(restored.map(({ value }) => value.accessDigest).sort(), entries.map(({ accessDigest }) => accessDigest).sort());
});

test("source-name postings preserve complete XMLTV tuples and fail closed on bounded overflow", async () => {
  const day = "2026-10-01", digest = sha256("synthetic-part");
  const makeChannel = (xmltvChannelID: string, displayNames: string[]): PublicProgrammeChannel => ({
    sourceID: PUBLIC_EPG_SOURCE_IDS[0]!,
    sourceRevision: sha256("synthetic-source-revision"),
    sourcePriority: 0,
    xmltvChannelID,
    displayNames,
    displayNameLanguages: [],
    days: [{ utcDay: day, parts: [{
      key: `public-epg/v1/objects/${digest}.xml.gz`, sha256: digest, bytes: 1, compressedBytes: 1,
      xmlSha256: digest, utcDay: day, part: 0
    }] }]
  });
  const unique = makeChannel("local-no-external-id", ["  No External Identity+ HD  ", "No   External Identity+ HD"]);
  const duplicateA = makeChannel("same-source-a", ["City/News + 1080p"]);
  const duplicateB = makeChannel("same-source-b", ["City/News + 1080p"]);
  const overflow = Array.from({ length: PUBLIC_EPG_LIMITS.maxProgrammeNameCandidates + 1 }, (_, index) =>
    makeChannel(`overflow-${index}`, ["Shared Region+ HD"]));

  assert.equal(normalizePublicProgrammeName("City/News + 1080p"), "city/news + 1080p");
  assert.equal(normalizePublicProgrammeName("  Foo   Bar  "), "foo bar");
  const records = programmeNameRecords([unique, duplicateA, duplicateB, ...overflow]);
  const store = new MemoryObjectStore();
  const root = await writeRoutedDirectory(store, "programme-names", records);
  const restored = await readRoutedDirectory<PublicProgrammeNamePosting>(store, root, "programme-names", 128, 4 * 1024 * 1024);
  const posting = (term: string) => restored.find((entry) => entry.value.term === term)?.value;

  assert.deepEqual(posting("no external identity+ hd")?.candidates, [{
    sourceID: unique.sourceID,
    sourceRevision: unique.sourceRevision,
    sourcePriority: unique.sourcePriority,
    xmltvChannelID: unique.xmltvChannelID
  }], "source-local XMLTV names remain discoverable when no external identity exists");
  assert.equal(posting("city/news + 1080p")?.ambiguous, false);
  assert.deepEqual(posting("city/news + 1080p")?.candidates.map((candidate) => candidate.xmltvChannelID), ["same-source-a", "same-source-b"]);
  assert.deepEqual(posting("shared region+ hd"), { term: "shared region+ hd", candidates: [], ambiguous: true },
    "overflow is represented as an explicit ambiguity, never a truncated candidate set");
  assert.ok(records.every((record) => record.value.candidates.length <= PUBLIC_EPG_LIMITS.maxProgrammeNameCandidates));
  assert.ok(records.every((record) => Buffer.byteLength(JSON.stringify(record.value)) <= PUBLIC_EPG_LIMITS.maxProgrammeNamePostingBytes));
});

test("taxonomy key version and hash stay byte-for-byte reproducible for Native", () => {
  const key = taxonomyDirectoryKey("language", "eng");
  assert.equal(key, '[1,"language","eng"]');
  assert.equal(sha256(key), "070fb3e7f51036142426173b802f111e4ca03f0e4b27da3cada136a5ade05636");
});

test("taxonomy pages retain a full 76,302-member posting while a bounded reader can take only the first page", async () => {
  const memberKeys = Array.from({ length: 76_302 }, (_, index) => `channel-${index.toString().padStart(6, "0")}@feed`);
  const store = new MemoryObjectStore();
  const built = await writeTaxonomyDirectory(store, [{ dimension: "language", value: "eng", memberKeys }], {
    language: ["eng"], category: [], country: []
  });
  const [record] = await readRoutedDirectory<PublicTaxonomyPosting>(store, built.root, "taxonomy", 40, 1024 * 1024);
  assert.ok(record);
  assert.equal(record.value.memberCount, memberKeys.length);
  assert.ok(record.value.pages.length > 1);
  assert.ok(record.value.pages.length <= PUBLIC_EPG_LIMITS.maxTaxonomyPagesPerPosting);
  assert.deepEqual(record.value.pages.map((page) => page.count).reduce((sum, count) => sum + count, 0), memberKeys.length);
  assert.equal(record.value.pages[0]!.firstKey, memberKeys[0]);
  assert.equal(record.value.pages.at(-1)!.lastKey, memberKeys.at(-1));

  const firstPageOnly = await readTaxonomyPostingPages(store, record.value, [0], 1024 * 1024);
  assert.equal(firstPageOnly.length, 1);
  assert.equal(firstPageOnly[0]!.pageIndex, 0);
  assert.ok(firstPageOnly[0]!.count < record.value.memberCount,
    "an incomplete bounded scan can report remaining pages instead of presenting a truncated posting as complete");
  assert.ok(record.value.pages.length - firstPageOnly.length > 0);
  const objects = [...store.objects.values()].filter((object) => object.metadata.contentType === "application/json");
  const taxonomyRootRaw = (await import("node:zlib")).gunzipSync(store.objects.get(built.root.key)!.value);
  assert.ok(built.root.bytes <= PUBLIC_EPG_LIMITS.maxRootUncompressedBytes);
  assert.ok(validPublicTaxonomyRoot(JSON.parse(taxonomyRootRaw.toString("utf8"))));
  for (const object of objects) {
    const raw = (await import("node:zlib")).gunzipSync(object.value);
    const parsed = JSON.parse(raw.toString("utf8")) as { kind?: string };
    if (parsed.kind === "taxonomy-page") assert.ok(raw.byteLength <= PUBLIC_EPG_LIMITS.maxTaxonomyPageBytes);
  }
  assert.equal(built.pageCount, record.value.pages.length);
  const restored = await readTaxonomyPostingPages(store, record.value);
  assert.deepEqual(restored.flatMap((page) => page.memberKeys), memberKeys);
});
