import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalObjectStore } from "../src/local-store.js";

const metadata = { contentType: "application/json" as const, cacheControl: "no-store" };

test("local object store provides bounded reads and conditional atomic writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-epg-store-test-"));
  try {
    const store = new LocalObjectStore(root);
    const key = "public-epg/v1/current.json";
    const first = new TextEncoder().encode("first");
    const etag = await store.putConditional(key, first, metadata, { ifNoneMatch: "*" });
    assert.deepEqual(await store.get(key, 32), first);
    assert.equal((await store.getWithETag(key, 32))?.etag, etag);
    await assert.rejects(store.get(key, 2), /local_store_object_size_invalid/u);
    await assert.rejects(store.putConditional(key, first, metadata, { ifNoneMatch: "*" }), /r2_precondition_failed/u);
    const second = new TextEncoder().encode("second");
    const nextETag = await store.putConditional(key, second, metadata, { ifMatch: etag });
    assert.notEqual(nextETag, etag);
    assert.deepEqual(await store.get(key, 32), second);
    await assert.rejects(store.putConditional(key, first, metadata, { ifMatch: etag }), /r2_precondition_failed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local object store rejects traversal keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-epg-store-test-"));
  try {
    const store = new LocalObjectStore(root);
    await assert.rejects(store.get("public-epg/v1/../../outside"), /local_store_key_invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
