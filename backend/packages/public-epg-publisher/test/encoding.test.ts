import assert from "node:assert/strict";
import { test } from "node:test";
import { gzip, putImmutable, sha256 } from "../src/encoding.js";
import { MemoryObjectStore } from "./fixtures.js";

test("immutable reuse uses exact cached bytes without another GET or conditional PUT", async () => {
  class CachedStore extends MemoryObjectStore {
    cached: Uint8Array | null = null;
    gets = 0;
    attempts = 0;
    getCachedObject(_key: string, maximum: number): Uint8Array | null {
      return this.cached && this.cached.byteLength <= maximum ? this.cached : null;
    }
    override async get(key: string, maximum?: number): Promise<Uint8Array | null> {
      this.gets += 1;
      return super.get(key, maximum);
    }
  }
  const store = new CachedStore();
  store.beforeConditionalPut = () => { store.attempts += 1; };
  const raw = new TextEncoder().encode('{"fixture":true}');
  const first = await putImmutable(store, "json", raw);
  store.cached = gzip(raw);
  assert.deepEqual(await putImmutable(store, "json", raw), first);
  assert.equal(store.attempts, 1);
  assert.equal(store.gets, 1); // bounded absence check before the first create

  // Length alone is insufficient proof. A mismatched cache must follow the
  // bounded remote verification path and reject corruption before writing.
  store.cached[0] ^= 1;
  store.objects.get(first.key)!.value[0] ^= 1;
  await assert.rejects(putImmutable(store, "json", raw), /immutable_object_hash_mismatch/u);
  assert.equal(store.attempts, 1);
  assert.equal(store.gets, 2);
});

test("a graph larger than the PUT ceiling is reused across runs without any PUT attempts", async () => {
  const store = new MemoryObjectStore();
  const metadata = { contentType: "application/json" as const, contentEncoding: "gzip" as const, cacheControl: "public, immutable" };
  const rows = Array.from({ length: 10_001 }, (_, index) => {
    const raw = new TextEncoder().encode(JSON.stringify({ index }));
    const compressed = gzip(raw);
    const digest = sha256(compressed);
    const key = `public-epg/v1/objects/${digest}.json.gz`;
    store.objects.set(key, { value: compressed, metadata, modifiedAt: 0 });
    return { raw, key, digest };
  });
  let attempts = 0;
  store.beforeConditionalPut = () => { attempts += 1; };
  for (const row of rows) {
    const ref = await putImmutable(store, "json", row.raw);
    assert.equal(ref.key, row.key);
    assert.equal(ref.sha256, row.digest);
  }
  assert.equal(attempts, 0);
});

test("an immutable create race still uses conditional creation and verifies the winning bytes", async () => {
  for (const corrupt of [false, true]) {
    const store = new MemoryObjectStore();
    const raw = new TextEncoder().encode('{"race":true}');
    const compressed = gzip(raw);
    let attempts = 0;
    store.beforeConditionalPut = (key, condition) => {
      assert.deepEqual(condition, { ifNoneMatch: "*" });
      attempts += 1;
      const value = new Uint8Array(compressed);
      if (corrupt) value[0] ^= 1;
      store.objects.set(key, { value, metadata: { contentType: "application/json", cacheControl: "immutable" }, modifiedAt: 0 });
    };
    if (corrupt) await assert.rejects(putImmutable(store, "json", raw), /immutable_object_hash_mismatch/u);
    else assert.equal((await putImmutable(store, "json", raw)).sha256, sha256(compressed));
    assert.equal(attempts, 1);
  }
});

test("an immutable preflight read failure cannot become an unverified write", async () => {
  const store = new MemoryObjectStore();
  store.get = async () => { throw new Error("r2_get_failed:502:Error"); };
  let attempts = 0;
  store.beforeConditionalPut = () => { attempts += 1; };
  await assert.rejects(putImmutable(store, "json", new Uint8Array([1])), /r2_get_failed:502:Error/u);
  assert.equal(attempts, 0);
});
