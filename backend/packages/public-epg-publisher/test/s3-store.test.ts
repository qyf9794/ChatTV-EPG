import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { GetObjectCommand, S3Client, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { R2ObjectStore } from "../src/s3-store.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(body: Readable, options: Partial<GetObjectCommandOutput> = {}): GetObjectCommandOutput {
  return { $metadata: {}, Body: body as GetObjectCommandOutput["Body"], ETag: '"fixture-etag"', ...options };
}

function fixture(t: TestContext, send: (signal: AbortSignal, command: GetObjectCommand) => Promise<GetObjectCommandOutput>) {
  t.mock.method(S3Client.prototype, "send", (async (command: GetObjectCommand, options: { abortSignal: AbortSignal }) =>
    send(options.abortSignal, command)) as S3Client["send"]);
  const store = new R2ObjectStore({ accountID: "a".repeat(32), bucket: "fixture", accessKeyID: "fixture", secretAccessKey: "fixture", requestTimeoutMs: 1000 });
  t.after(() => store.close());
  return store;
}

test("R2 GET reads all chunks and retains the ETag without leaving a deadline active", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const body = Readable.from([Buffer.from("one"), Buffer.from("two")]);
  let signal!: AbortSignal;
  const store = fixture(t, async (requestSignal, command) => {
    signal = requestSignal;
    assert.equal(command.input.Bucket, "fixture");
    assert.equal(command.input.Key, "normal");
    return response(body, { ContentLength: 6 });
  });
  assert.deepEqual(await store.getWithETag("normal", 6), { value: new Uint8Array(Buffer.from("onetwo")), etag: '"fixture-etag"' });
  assert.equal(body.closed, true);
  t.mock.timers.tick(1000);
  assert.equal(signal.aborted, false);
});

test("R2 GET aborts a headers timeout and waits for the request to settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborted = deferred<void>(), release = deferred<void>();
  const store = fixture(t, async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
    await release.promise;
    throw signal.reason;
  });
  let settled = false;
  const operation = store.get("headers-timeout").finally(() => { settled = true; });
  const rejected = assert.rejects(operation, /^Error: r2_get_failed:0:TimeoutError$/u);
  t.mock.timers.tick(1000);
  await aborted.promise;
  await nextTurn();
  assert.equal(settled, false, "the store must not return while the aborted request is still active");
  release.resolve();
  await rejected;
});

test("R2 GET body shares the headers deadline and waits for asynchronous destruction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const headers = deferred<GetObjectCommandOutput>(), destroying = deferred<void>(), release = deferred<void>();
  const body = new Readable({
    read() {},
    destroy(error, callback) { destroying.resolve(); void release.promise.then(() => callback(error)); }
  });
  let signal!: AbortSignal;
  const store = fixture(t, async (requestSignal) => { signal = requestSignal; return headers.promise; });
  let settled = false;
  const operation = store.get("body-timeout").finally(() => { settled = true; });
  const rejected = assert.rejects(operation, /^Error: r2_get_failed:0:TimeoutError$/u);
  t.mock.timers.tick(600);
  headers.resolve(response(body));
  await nextTurn();
  t.mock.timers.tick(399);
  assert.equal(signal.aborted, false);
  assert.equal(body.destroyed, false);
  t.mock.timers.tick(1);
  await destroying.promise;
  await nextTurn();
  assert.equal(signal.aborted, true);
  assert.equal(settled, false, "the stream must finish destroying before the GET rejects");
  assert.equal(body.closed, false);
  release.resolve();
  await rejected;
  assert.equal(body.closed, true);
});

test("R2 GET closes a body whose response arrives after its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const headers = deferred<GetObjectCommandOutput>();
  const body = new Readable({ read() {} });
  const store = fixture(t, async () => headers.promise);
  const rejected = assert.rejects(store.get("late-headers"), /r2_get_failed:0:TimeoutError/u);
  t.mock.timers.tick(1000);
  headers.resolve(response(body));
  await rejected;
  assert.equal(body.closed, true);
});

test("R2 GET cancels a web response body and waits for its cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cancelling = deferred<void>(), release = deferred<void>();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ async cancel() { cancelling.resolve(); await release.promise; cancelled = true; } });
  const store = fixture(t, async () => ({ $metadata: {}, Body: body as GetObjectCommandOutput["Body"], ETag: '"fixture-etag"' }));
  let settled = false;
  const rejected = assert.rejects(store.get("web-body-timeout").finally(() => { settled = true; }), /r2_get_failed:0:TimeoutError/u);
  await nextTurn();
  t.mock.timers.tick(1000);
  await cancelling.promise;
  await nextTurn();
  assert.equal(settled, false);
  release.resolve();
  await rejected;
  assert.equal(cancelled, true);
});

test("R2 GET reports response-body errors after the stream has closed", async (t) => {
  const body = new Readable({ read() { this.destroy(Object.assign(new Error("private provider details"), { name: "NetworkingError" })); } });
  const store = fixture(t, async () => response(body));
  await assert.rejects(store.get("body-error"), /^Error: r2_get_failed:0:NetworkingError$/u);
  assert.equal(body.closed, true);
});

test("R2 GET rejects declared invalid sizes before reading and waits for destruction", async (t) => {
  for (const ContentLength of [-1, 4]) {
    let reads = 0;
    const destroying = deferred<void>(), release = deferred<void>();
    const body = new Readable({ read() { reads++; }, destroy(error, callback) { destroying.resolve(); void release.promise.then(() => callback(error)); } });
    const store = fixture(t, async () => response(body, { ContentLength }));
    let settled = false;
    const rejected = assert.rejects(store.get("declared-size", 3).finally(() => { settled = true; }), /r2_object_size_invalid/u);
    await destroying.promise;
    assert.equal(reads, 0);
    assert.equal(settled, false);
    release.resolve();
    await rejected;
    assert.equal(body.closed, true);
  }
});

test("R2 GET rejects streaming overflow and truncated bodies", async (t) => {
  for (const options of [{ maximum: 3 }, { maximum: 10, ContentLength: 7 }]) {
    const body = Readable.from([Buffer.from("one"), Buffer.from("two")]);
    const store = fixture(t, async () => response(body, { ContentLength: options.ContentLength }));
    await assert.rejects(store.get("invalid-body-size", options.maximum), /r2_object_size_invalid/u);
    assert.equal(body.closed, true);
  }
});

test("R2 GET keeps missing-object and missing-ETag handling", async (t) => {
  const store = fixture(t, async (_signal, command) => {
    if (command.input.Key === "missing") throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    if (command.input.Key === "empty-response") return { $metadata: {} };
    return response(Readable.from([Buffer.from("value")]), { ETag: undefined });
  });
  assert.equal(await store.get("missing"), null);
  assert.equal(await store.get("empty-response"), null);
  await assert.rejects(store.get("missing-etag"), /r2_etag_missing/u);
});
