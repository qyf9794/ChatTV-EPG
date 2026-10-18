import assert from "node:assert/strict";
import { test } from "node:test";
import {
  identityKey,
  validPublicAccessEntry,
  validPublicStreamsEntry,
  type PublicIdentityEntry,
  type PublicStreamsEntry
} from "@vocaltv/public-epg-contract";
import { buildChannelSeeds } from "../src/identity.js";
import {
  buildPublicAccessIndex,
  buildPublicStreams,
  buildPublicTaxonomyIndex,
  publicAccessDigest,
  publicAccessGraphMatches
} from "../src/streams.js";
import { categoriesFixture, channelsFixture, feedsFixture, streamsFixture } from "./fixtures.js";

test("public stream index keeps exact channel+Feed rows and rejects private or unknown routes", () => {
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const built = buildPublicStreams(streamsFixture, seeds);
  const byIdentity = new Map(built.entries.map((entry) => [identityKey(entry), entry]));

  const news = byIdentity.get(identityKey({ channelID: "news", feedID: "en" }));
  assert.ok(news);
  assert.equal(news!.streams.length, 1);
  assert.equal(news!.streams[0]!.providerChannelId, "news");
  assert.equal(news!.streams[0]!.feedId, "en");
  assert.equal(news!.streams[0]!.userAgent, "VocalTV-Test/1.0");
  assert.equal(validPublicStreamsEntry(news), true);

  assert.equal(byIdentity.has(identityKey({ channelID: "news", feedID: "missing" })), false);
  assert.equal(byIdentity.has(identityKey({ channelID: "news", feedID: null })), false);
  assert.equal(byIdentity.has(identityKey({ channelID: "other", feedID: "shared" })), true);
});

test("duplicate stream IDs with conflicting content fail closed for that ID", () => {
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const built = buildPublicStreams([
    { id: "same", channel: "news", feed: "en", title: "First", url: "https://cdn.example/one.m3u8" },
    { id: "same", channel: "news", feed: "en", title: "Second", url: "https://cdn.example/two.m3u8" },
    { id: "kept", channel: "news", feed: "en", title: "Kept", url: "https://cdn.example/kept.m3u8" }
  ], seeds);
  assert.deepEqual(built.entries[0]?.streams.map((stream) => stream.streamId), ["kept"]);
});

test("public access digests preserve the full route and frame delimiter-like header values", () => {
  const vector = publicAccessDigest({
    url: "https://media.example.invalid/live?b=2&a=1",
    referrer: "https://site.example.invalid/watch",
    userAgent: "Fixture Player/1"
  });
  assert.equal(vector, "13d713aec3ccb54d061b2e572b3a0b8ad6813b84df29fb089957777bdd8153d4",
    "this pinned vector is shared with Swift to lock the field framing and header order");
  assert.notEqual(vector, publicAccessDigest({
    url: "https://media.example.invalid/live?a=1&b=2",
    referrer: "https://site.example.invalid/watch",
    userAgent: "Fixture Player/1"
  }), "query order is retained in the access identity");

  const baseURL = "https://cdn.example/live/path.m3u8?token=keep&part=one";
  const delimiterCollisionA = publicAccessDigest({
    url: baseURL,
    userAgent: "Agent/1&referer=https://referer.example/"
  });
  const delimiterCollisionB = publicAccessDigest({
    url: baseURL,
    userAgent: "Agent/1",
    referrer: "https://referer.example/"
  });
  assert.notEqual(delimiterCollisionA, delimiterCollisionB,
    "length-prefixed fields keep '&' and '=' inside values from colliding with header boundaries");
  assert.notEqual(delimiterCollisionA, publicAccessDigest({
    url: "https://cdn.example/live/other.m3u8?token=keep&part=one",
    userAgent: "Agent/1&referer=https://referer.example/"
  }), "path differences affect access identity");
  assert.notEqual(delimiterCollisionA, publicAccessDigest({
    url: "https://cdn.example/live/path.m3u8?token=changed&part=one",
    userAgent: "Agent/1&referer=https://referer.example/"
  }), "query and token differences affect access identity");
});

test("access postings deduplicate exact identities and retain distinct Feed identities", () => {
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture);
  const built = buildPublicStreams([
    { id: "news-en", channel: "news", feed: "en", title: "English", url: "https://cdn.example/shared.m3u8?token=public" },
    { id: "news-shared", channel: "news", feed: "shared", title: "Shared", url: "https://cdn.example/shared.m3u8?token=public" },
    { id: "news-en-duplicate", channel: "news", feed: "en", title: "English backup", url: "https://cdn.example/shared.m3u8?token=public" }
  ], seeds);
  const access = buildPublicAccessIndex(built.entries);
  assert.equal(access.accessDigestCount, 1);
  assert.equal(access.accessMemberCount, 2);
  assert.equal(access.accessAmbiguousCount, 0);
  assert.deepEqual(access.entries[0]?.members, [
    { channelID: "news", feedID: "en" },
    { channelID: "news", feedID: "shared" }
  ]);
  assert.equal(validPublicAccessEntry(access.entries[0]), true);
  const graph = access.entries.map((value) => ({ hash: value.accessDigest, value }));
  assert.equal(publicAccessGraphMatches(built.entries, graph), true);
  assert.equal(publicAccessGraphMatches(built.entries, [{
    hash: graph[0]!.hash,
    value: { ...graph[0]!.value, members: [{ channelID: "other", feedID: "shared" }] }
  }]), false, "reference validation rejects a valid-shaped but unrelated Channel+Feed posting");
  assert.equal(JSON.stringify(access.entries).includes("cdn.example"), false,
    "the reverse-index value carries only the digest and exact public identity pairs");
});

test("access posting overflow publishes an empty ambiguous sentinel", () => {
  const entries: PublicStreamsEntry[] = Array.from({ length: 17 }, (_, index) => ({
    channelID: `channel-${index.toString().padStart(2, "0")}`,
    feedID: null,
    streams: [{
      streamId: `stream-${index}`,
      providerChannelId: `channel-${index.toString().padStart(2, "0")}`,
      title: "Shared public access",
      url: "https://cdn.example/shared.m3u8?token=public",
      labels: []
    }]
  }));
  const access = buildPublicAccessIndex(entries);
  assert.equal(access.accessDigestCount, 1);
  assert.equal(access.accessMemberCount, 0);
  assert.equal(access.accessAmbiguousCount, 1);
  assert.deepEqual(access.entries[0]?.members, []);
  assert.equal(access.entries[0]?.ambiguous, true);
  assert.equal(validPublicAccessEntry(access.entries[0]), true);
  assert.equal(validPublicAccessEntry({ ...access.entries[0]!, ambiguous: true, members: [{ channelID: "channel-00", feedID: null }] }), false,
    "overflow cannot publish a partial identity list");
  assert.equal(validPublicAccessEntry({ ...access.entries[0]!, url: "https://private.example/" }), false,
    "access rows reject fields that could carry route data");
});

test("typed taxonomy covers channel and Feed identities independently and keeps complete sorted vocabulary", () => {
  const makeIdentity = (channelID: string, feedID: string | null, languages: string[], channelLanguages?: string[]): PublicIdentityEntry => ({
    provider: "iptv-org",
    channelID,
    feedID,
    canonicalName: "News",
    feedName: feedID,
    name: feedID ? `News ${feedID}` : "News",
    aliases: [],
    languages,
    broadcastAreas: [],
    timezones: [],
    country: "US",
    categoryIDs: ["news", "sports"],
    ...(channelLanguages ? { channelLanguages } : {}),
    relations: []
  });
  const index = buildPublicTaxonomyIndex([
    makeIdentity("news", null, []),
    makeIdentity("news", "en", ["eng"]),
    makeIdentity("news", "fr", ["fra"])
  ]);
  const byTypedValue = new Map(index.postings.map((entry) => [`${entry.dimension}:${entry.value}`, entry.memberKeys]));
  assert.deepEqual(byTypedValue.get("language:eng"), ["news@en"]);
  assert.deepEqual(byTypedValue.get("language:fra"), ["news@fr"]);
  assert.equal(byTypedValue.has("language:news"), false);
  assert.deepEqual(byTypedValue.get("country:US"), ["news@", "news@en", "news@fr"]);
  assert.deepEqual(byTypedValue.get("category:news"), ["news@", "news@en", "news@fr"]);
  assert.deepEqual(index.vocabulary, {
    language: ["eng", "fra"],
    category: ["news", "sports"],
    country: ["US"]
  });
  assert.equal(index.postingCount, 5);
});
