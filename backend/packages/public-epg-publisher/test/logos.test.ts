import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_EPG_CURRENT_KEY, identityKey, validManifest, type CurrentPointer, type PublicEpgManifest } from "@vocaltv/public-epg-contract";
import { buildChannelSeeds, mergeIdentityEntry, publicLogoURLs } from "../src/identity.js";
import { runPublisher } from "../src/publish.js";
import { publicLogoMetadataSource } from "../src/sources.js";
import { FixedPublicUpstream, MemoryObjectStore, channelsFixture, feedsFixture, categoriesFixture } from "./fixtures.js";

const logo = (channel: string, feed: string | null, url: string, changes: Record<string, unknown> = {}) =>
  ({ channel, feed, url, in_use: true, format: "PNG", width: 512, height: 512, ...changes });

test("Logos keep exact composite identities and never pick an arbitrary Feed", () => {
  const rows = [logo("news", null, "https://logos.example/news.png"),
    logo("news", "en", "https://logos.example/news-en.png"),
    logo("other", "shared", "https://logos.example/other.png")];
  const seeds = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture, rows);
  const pick = (channelID: string, feedID: string | null) => seeds.find(s =>
    s.identity.channelID === channelID && s.identity.feedID === feedID)!;
  assert.equal(mergeIdentityEntry(pick("news", null), []).logoURL, "https://logos.example/news.png");
  assert.equal(mergeIdentityEntry(pick("news", "en"), []).logoURL, "https://logos.example/news-en.png");
  assert.equal(mergeIdentityEntry(pick("news", "shared"), []).logoURL, "https://logos.example/news.png");
  assert.equal(mergeIdentityEntry(pick("other", null), []).logoURL, undefined);
  const { logoURL, ...projection } = pick("news", null);
  const legacy = buildChannelSeeds(channelsFixture, feedsFixture, categoriesFixture).find(s =>
    s.identity.channelID === "news" && s.identity.feedID === null)!;
  const { logoURL: unused, ...legacyProjection } = legacy;
  assert.deepEqual(projection, legacyProjection);
});

test("Current supported bitmaps use deterministic size selection", () => {
  const values = [logo("news", null, "https://logos.example/z.png"),
    logo("news", null, "https://logos.example/a.png"),
    logo("news", null, "https://logos.example/old.png", { in_use: false }),
    logo("news", null, "https://logos.example/vector.svg", { format: "SVG" }),
    logo("news", null, "ftp://logos.example/unsupported.png"),
    logo("news", null, "https://logos.example/tiny.png", { width: 16, height: 16 })];
  const key = identityKey({ channelID: "news", feedID: null });
  assert.equal(publicLogoURLs(values).get(key), "https://logos.example/a.png");
  assert.deepEqual(publicLogoURLs(values), publicLogoURLs([...values].reverse()));
});

test("Optional Logo source outage retains its last good input without blocking EPG", async () => {
  const store = new MemoryObjectStore();
  const upstream = new FixedPublicUpstream();
  let failing = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === publicLogoMetadataSource.publicURL) {
      if (failing) return new Response("offline", { status: 503 });
      return new Response(JSON.stringify([logo("news", null, "https://logos.example/news.png")]),
        { status: 200, headers: { etag: '"logo-v1"' } });
    }
    return upstream.fetch(input, init);
  };
  const first = await runPublisher({ store, fetchImpl, now: () => new Date("2026-10-01T12:00:00.000Z") });
  assert.equal(first.published, true);
  const pointer = JSON.parse(new TextDecoder().decode((await store.get(PUBLIC_EPG_CURRENT_KEY, 2048))!)) as CurrentPointer;
  const manifest = JSON.parse(new TextDecoder().decode((await store.get(pointer.manifestKey, 32 * 1024))!)) as PublicEpgManifest;
  assert.ok(validManifest(manifest));
  failing = true;
  const second = await runPublisher({ store, fetchImpl, now: () => new Date("2026-10-01T13:00:00.000Z") });
  assert.equal(second.revision, first.revision);
  assert.equal(second.unavailableSources, 0);
});
