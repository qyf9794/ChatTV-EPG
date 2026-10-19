import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  PUBLIC_EPG_PREFIX,
  PUBLIC_EPG_METADATA_SOURCE_IDS,
  PUBLIC_EPG_SOURCE_IDS,
  publicProgrammeNameDescriptorKey,
  type CurrentPointer
} from '@vocaltv/public-epg-contract';
import { runRetention, RETENTION_LIMITS, RetentionFailure } from '../src/retention.js';
import { sha256, type RetentionObjectStore } from '../src/encoding.js';
import { BudgetedObjectStore, PUBLISHER_RUN_LIMITS } from '../src/publish.js';
function fixture() {
  const now = Date.now(), objects = new Map<string, Uint8Array>(), deleted: string[] = [];
  const artifact = (value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value)), stored = gzipSync(raw), digest = sha256(stored);
    const ref = { key: PUBLIC_EPG_PREFIX + 'objects/' + digest + '.json.gz', sha256: digest, bytes: raw.length, compressedBytes: stored.length };
    objects.set(ref.key, stored); return ref;
  };
  const pointers = ['current', 'previous'].map((label) => {
    const root = artifact({ schemaVersion: 1, kind: 'identity-bucket', prefix: '', entries: [{ label }] });
    const programmeRoot = artifact({ schemaVersion: 1, kind: 'programme-root', entries: [] });
    const namesRoot = artifact({ schemaVersion: 1, kind: 'programme-names-root', entries: [] });
    const descriptorKey = publicProgrammeNameDescriptorKey(programmeRoot.sha256);
    objects.set(descriptorKey, Buffer.from(JSON.stringify({
      schemaVersion: 1, programmeRootSHA256: programmeRoot.sha256, root: namesRoot
    })));
    const value = { schemaVersion: 2, revision: sha256(label), generatedAt: new Date(now).toISOString(), previousRevision: null,
      sources: [...PUBLIC_EPG_SOURCE_IDS, ...PUBLIC_EPG_METADATA_SOURCE_IDS.filter((sourceID) => sourceID !== 'iptv-org:logos')]
        .map((sourceID) => ({ sourceID, sourceRevision: null, status: 'unavailable', lastGoodAt: null })),
      identityRoot: root, nameRoot: root, programmeRoot };
    const bytes = Buffer.from(JSON.stringify(value)), digest = sha256(bytes), manifestKey = PUBLIC_EPG_PREFIX + 'manifests/' + digest + '.json';
    objects.set(manifestKey, bytes);
    return { schemaVersion: 1, revision: value.revision, manifestKey, manifestSha256: digest,
      descriptorKey, namesRootKey: namesRoot.key } as CurrentPointer & { descriptorKey: string; namesRootKey: string };
  });
  const orphan = PUBLIC_EPG_PREFIX + 'objects/' + '0'.repeat(64) + '.json.gz';
  const orphanDescriptor = PUBLIC_EPG_PREFIX + 'source-names/' + '2'.repeat(64) + '.json';
  const fresh = PUBLIC_EPG_PREFIX + 'objects/' + '1'.repeat(64) + '.json.gz';
  objects.set(orphan, Buffer.from('obsolete')); objects.set(fresh, Buffer.from('new'));
  objects.set(orphanDescriptor, Buffer.from('{}'));
  const raw = Buffer.from('public source fixture'), bodySha256 = sha256(raw), bodyKey = PUBLIC_EPG_PREFIX + 'publisher/source-cache/fixture/' + bodySha256 + '.body';
  objects.set(bodyKey, raw);
  const states = [{ sources: { fixture: { bodyKey, bodySha256, bodyBytes: raw.length } } }];
  const store = {
    get: async (key: string) => objects.get(key) ?? null,
    list: async () => ({ objects: [...objects].map(([key, value]) => ({ key, bytes: value.length,
      lastModified: key === fresh ? now : now - RETENTION_LIMITS.graceMs - 1000 })) }),
    delete: async (keys: string[]) => { deleted.push(...keys); for (const key of keys) objects.delete(key); }
  } as unknown as RetentionObjectStore;
  return { now, store, pointers, states, orphan, orphanDescriptor, fresh, bodyKey, objects, deleted };
}
test('retention pins both publications and source caches while deleting only quarantined orphans', async () => {
  const f = fixture(); let fences = 0;
  const result = await runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => { fences++; }, f.now);
  assert.deepEqual(new Set(f.deleted), new Set([f.orphan, f.orphanDescriptor])); assert.equal(result.deleted, 2); assert.ok(fences >= 3);
  assert.ok(f.objects.has(f.fresh)); assert.ok(f.objects.has(f.bodyKey));
  assert.ok(f.pointers.every((pointer) => f.objects.has(pointer.manifestKey)));
  assert.ok(f.pointers.every((pointer) => f.objects.has(pointer.descriptorKey) && f.objects.has(pointer.namesRootKey)));
});

test('retention handles multiple v2 graphs and reclaims a complete expired graph within finite budgets', async () => {
  assert.ok(PUBLISHER_RUN_LIMITS.maxR2ListRequests >= RETENTION_LIMITS.maxLists * 2);
  assert.ok(PUBLISHER_RUN_LIMITS.maxR2DeleteObjects >= RETENTION_LIMITS.maxDeletes);
  assert.ok(PUBLISHER_RUN_LIMITS.maxR2DeleteRequests >= Math.ceil(RETENTION_LIMITS.maxDeletes / 1000));
  const run = async (oldCount: number) => {
    const f = fixture();
    const rows = [...f.objects].map(([key, value]) => ({ key, bytes: value.length,
      lastModified: key === f.fresh ? f.now : f.now - RETENTION_LIMITS.graceMs - 1000 }));
    const expired = new Set<string>([f.orphan, f.orphanDescriptor]);
    for (let index = 0; index < oldCount + 40_000; index++) {
      const key = PUBLIC_EPG_PREFIX + 'objects/' + sha256(`retention-scale-${index}`) + '.xml.gz';
      const old = index < oldCount;
      if (old) expired.add(key);
      rows.push({ key, bytes: 1, lastModified: old ? f.now - RETENTION_LIMITS.graceMs - 1000 : f.now });
    }
    f.store.list = async (_prefix, cursor) => {
      const start = Number(cursor ?? 0), end = Math.min(start + 1000, rows.length);
      return { objects: rows.slice(start, end), ...(end < rows.length ? { cursor: String(end) } : {}) };
    };
    const batches: number[] = [];
    f.store.delete = async keys => { batches.push(keys.length); f.deleted.push(...keys); };
    if (expired.size > RETENTION_LIMITS.maxDeletes) {
      await assert.rejects(runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now), /delete_budget_exceeded/u);
      assert.equal(f.deleted.length, 0);
    } else {
      const result = await runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now);
      assert.equal(result.objects, rows.length);
      assert.equal(result.deleted, expired.size);
      assert.deepEqual(new Set(f.deleted), expired);
      assert.ok(batches.every(count => count <= 1000));
      assert.ok(batches.length <= PUBLISHER_RUN_LIMITS.maxR2DeleteRequests);
    }
  };
  await run(30_000);
  await run(RETENTION_LIMITS.maxDeletes - 1);
  await run(RETENTION_LIMITS.maxDeletes);
});

test('retention preserves the exact 48-hour quarantine boundary', async () => {
  const f = fixture();
  const list = f.store.list.bind(f.store);
  f.store.list = async (...args) => {
    const page = await list(...args);
    for (const item of page.objects) if (item.key === f.orphan || item.key === f.orphanDescriptor) item.lastModified = f.now - RETENTION_LIMITS.graceMs;
    return page;
  };
  const atBoundary = await runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now);
  assert.equal(atBoundary.deleted, 0);
  const afterBoundary = await runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now + 1);
  assert.equal(afterBoundary.deleted, 2);
  assert.deepEqual(new Set(f.deleted), new Set([f.orphan, f.orphanDescriptor]));
});
test('missing/corrupt roots and incomplete enumeration prevent every deletion', async () => {
  const f = fixture(); f.objects.set(f.pointers[0]!.manifestKey, Buffer.from('corrupt'));
  await assert.rejects(runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now), /manifest_invalid/u);
  assert.deepEqual(f.deleted, []);
  const repeated = fixture(); repeated.store.list = async () => ({ objects: [], cursor: 'same' });
  await assert.rejects(runRetention(repeated.store, { pointers: repeated.pointers, states: repeated.states }, async () => {}, repeated.now), /listing_invalid/u);
  assert.deepEqual(repeated.deleted, []);
});

test('retention pins valid source-name descriptors and root graphs, tolerates pre-companion publications, and rejects corruption', async () => {
  const missing = fixture();
  const legacyDescriptorKey = (missing.pointers[1] as CurrentPointer & { descriptorKey: string }).descriptorKey;
  missing.objects.delete(legacyDescriptorKey);
  await runRetention(missing.store, { pointers: missing.pointers, states: missing.states }, async () => {}, missing.now);
  assert.ok(missing.pointers.every((pointer) => missing.objects.has(pointer.manifestKey)));

  const corrupt = fixture();
  const currentDescriptorKey = (corrupt.pointers[0] as CurrentPointer & { descriptorKey: string }).descriptorKey;
  corrupt.objects.set(currentDescriptorKey, Buffer.from('{}'));
  await assert.rejects(runRetention(corrupt.store, { pointers: corrupt.pointers, states: corrupt.states }, async () => {}, corrupt.now),
    /retention_programme_names_invalid/u);
  assert.deepEqual(corrupt.deleted, [], "an invalid retained companion prevents every deletion");
});
test('a lost publisher lease prevents sweeping and a tampered source cache fails closed', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {
    if (++calls >= 3) throw new Error('publisher_lease_lost');
  }, f.now), /lease_lost/u);
  assert.deepEqual(f.deleted, []);
  const damaged = fixture(); damaged.objects.set(damaged.bodyKey, Buffer.from('corrupt'));
  await assert.rejects(runRetention(damaged.store, { pointers: damaged.pointers, states: damaged.states }, async () => {}, damaged.now), /source_cache_invalid/u);
  assert.deepEqual(damaged.deleted, []);
});
test('retention validates cached bytes and bounds parallel graph reads to eight', async () => {
  const f = fixture();
  const artifact = (value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value)), stored = gzipSync(raw), digest = sha256(stored);
    const ref = { key: PUBLIC_EPG_PREFIX + 'objects/' + digest + '.json.gz', sha256: digest, bytes: raw.length, compressedBytes: stored.length };
    f.objects.set(ref.key, stored); return ref;
  };
  const children = Array.from({ length: 20 }, (_, index) => artifact({ index }));
  const root = artifact({ children });
  const manifest = { schemaVersion: 1, revision: sha256('parallel'), generatedAt: new Date(f.now).toISOString(), previousRevision: null,
    sources: [], identityRoot: root, nameRoot: root };
  const bytes = Buffer.from(JSON.stringify(manifest)), digest = sha256(bytes), manifestKey = PUBLIC_EPG_PREFIX + 'manifests/' + digest + '.json';
  f.objects.set(manifestKey, bytes);
  const pointer = { schemaVersion: 1, revision: manifest.revision, manifestKey, manifestSha256: digest } as CurrentPointer;
  let active = 0, peak = 0, reads = 0;
  f.store.get = async (key) => {
    active++; peak = Math.max(peak, active); reads++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; return f.objects.get(key) ?? null;
  };
  await runRetention(f.store, { pointers: [pointer], states: f.states }, async () => {}, f.now);
  assert.equal(peak, 8); assert.ok(reads >= 20);
  const cached = fixture();
  (cached.store as RetentionObjectStore & { getCachedObject: (key: string) => Uint8Array | null }).getCachedObject =
    (key) => cached.objects.get(key) ?? null;
  cached.store.get = async () => { throw new Error('unexpected_network_read'); };
  await runRetention(cached.store, { pointers: cached.pointers, states: cached.states }, async () => {}, cached.now);
  const damaged = fixture();
  (damaged.store as RetentionObjectStore & { getCachedObject: (key: string) => Uint8Array | null }).getCachedObject =
    (key) => key === damaged.pointers[0]!.manifestKey ? Buffer.from('tampered cached bytes') : damaged.objects.get(key) ?? null;
  await assert.rejects(runRetention(damaged.store, { pointers: damaged.pointers, states: damaged.states }, async () => {}, damaged.now), /manifest_invalid/u);
  assert.deepEqual(damaged.deleted, []);
});


test('retention expires only recognized old upload-session keys and preserves recent sessions/other coordination', async () => {
  const f = fixture(), prefix = PUBLIC_EPG_PREFIX + 'publisher/uploads/' + 'a'.repeat(32) + '/';
  const oldKeys = [prefix + 'plan.json', prefix + 'job.json', prefix + 'receipts/' + 'b'.repeat(64) + '.json'];
  for (const key of oldKeys) f.objects.set(key, Buffer.from('{}'));
  const recent = PUBLIC_EPG_PREFIX + 'publisher/uploads/' + 'c'.repeat(32) + '/job.json';
  const unrelated = prefix + 'future-coordination.json';
  f.objects.set(recent, Buffer.from('{}')); f.objects.set(unrelated, Buffer.from('{}'));
  const list = f.store.list.bind(f.store); f.store.list = async (...args) => {
    const page = await list(...args); for (const item of page.objects) if (item.key === recent) item.lastModified = f.now; return page;
  };
  await runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now);
  assert.ok(oldKeys.every(key => f.deleted.includes(key)));
  assert.ok(f.objects.has(recent)); assert.ok(f.objects.has(unrelated));
});


function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flushWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function waitFor(predicate: () => boolean) {
  for (let step = 0; step < 100 && !predicate(); step++) await flushWork();
  assert.ok(predicate(), 'expected async work to reach the controlled checkpoint');
}
function graphFixture(childCount: number, nested = false) {
  const f = fixture();
  const artifact = (value: unknown) => {
    const raw = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
    const stored = gzipSync(raw), digest = sha256(stored);
    const ref = { key: PUBLIC_EPG_PREFIX + 'objects/' + digest + '.json.gz', sha256: digest,
      bytes: raw.length, compressedBytes: stored.length };
    f.objects.set(ref.key, stored);
    return ref;
  };
  const descendants = Array.from({ length: childCount }, (_, index) => artifact({ descendant: index }));
  const children = Array.from({ length: childCount }, (_, index) => artifact(
    nested ? { index, children: [descendants[index]!] } : { leaf: index }));
  const pointerFor = (refs: typeof children) => {
    const root = artifact({ children: refs });
    const manifest = { schemaVersion: 1, revision: sha256('controlled-concurrency'),
      generatedAt: new Date(f.now).toISOString(), previousRevision: null, sources: [],
      identityRoot: root, nameRoot: root };
    const bytes = Buffer.from(JSON.stringify(manifest)), digest = sha256(bytes);
    const manifestKey = PUBLIC_EPG_PREFIX + 'manifests/' + digest + '.json';
    f.objects.set(manifestKey, bytes);
    return { schemaVersion: 1, revision: manifest.revision, manifestKey, manifestSha256: digest } as CurrentPointer;
  };
  return { ...f, children, descendants, pointer: pointerFor(children), artifact, pointerFor };
}

test('a failed read closes queued work and waits for all eight active reads without expanding late subgraphs', async () => {
  const f = graphFixture(20, true);
  const gates = f.children.map(() => deferred<Uint8Array | null>());
  const childIndexes = new Map(f.children.map((child, index) => [child.key, index]));
  const started: string[] = [];
  let active = 0, peak = 0, lists = 0, finished = false;
  f.store.get = async (key) => {
    started.push(key);
    const index = childIndexes.get(key);
    if (index === undefined) return f.objects.get(key) ?? null;
    active++; peak = Math.max(peak, active);
    try { return await gates[index]!.promise; } finally { active--; }
  };
  f.store.list = async () => { lists++; return { objects: [] }; };
  const outcome = runRetention(f.store, { pointers: [f.pointer], states: [{}] }, async () => {}, f.now)
    .then(() => { finished = true; return null; }, (error: unknown) => { finished = true; return error; });
  await waitFor(() => active === 8);
  const atFailure = [...started], firstError = new Error('r2_get_failed:403');
  gates[0]!.reject(firstError);
  await flushWork();
  assert.equal(finished, false, 'retention must keep the caller waiting for seven in-flight reads');
  assert.equal(active, 7);
  assert.deepEqual(started, atFailure, 'the freed permit must not start a queued read');
  gates[1]!.resolve(f.objects.get(f.children[1]!.key)!);
  await flushWork();
  assert.equal(finished, false);
  assert.deepEqual(started, atFailure, 'a late successful parent must not dispatch its descendants');
  gates[2]!.reject(new Error('r2_get_failed:401'));
  for (let index = 3; index < 8; index++) gates[index]!.resolve(f.objects.get(f.children[index]!.key)!);
  const error = await outcome;
  assert.ok(error instanceof RetentionFailure);
  assert.equal(error.stage, 'mark');
  assert.equal(error.key, f.children[0]!.key);
  assert.equal(error.cause, firstError, 'secondary failures must not replace the first failure');
  assert.equal(active, 0);
  assert.equal(peak, 8);
  assert.deepEqual(started, atFailure);
  assert.ok(f.descendants.every((ref) => !started.includes(ref.key)));
  assert.equal(lists, 0);
  assert.deepEqual(f.deleted, []);
});

test('concurrent transient reads share one lease renewal and each retry remains within eight active reads', async () => {
  const f = graphFixture(8), retryFence = deferred<void>();
  const childKeys = new Set(f.children.map((child) => child.key)), attempts = new Map<string, number>();
  let fences = 0, active = 0, peak = 0;
  f.store.get = async (key) => {
    active++; peak = Math.max(peak, active);
    try {
      if (childKeys.has(key)) {
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        if (attempt === 1) throw new Error('r2_get_failed:0:TimeoutError');
      }
      return f.objects.get(key) ?? null;
    } finally { active--; }
  };
  f.store.list = async () => ({ objects: [] });
  const run = runRetention(f.store, { pointers: [f.pointer], states: [{}] }, async () => {
    if (++fences === 2) await retryFence.promise;
  }, f.now);
  await waitFor(() => attempts.size === 8 && fences === 2);
  await flushWork();
  assert.equal(fences, 2, 'all eight retries must share the same pending lease CAS');
  assert.ok([...attempts.values()].every((count) => count === 1));
  retryFence.resolve();
  const result = await run;
  assert.equal(result.readRetries, 8);
  assert.equal(fences, 3, 'initial fence, one shared retry fence, and the listing fence');
  assert.ok([...attempts.values()].every((count) => count === 2));
  assert.ok(peak <= 8);
  assert.equal(active, 0);
});

test('a final failure stops retries that are already waiting on a shared lease fence', async () => {
  const f = graphFixture(8), retryFence = deferred<void>();
  const gates = f.children.map(() => deferred<Uint8Array | null>());
  const indexes = new Map(f.children.map((child, index) => [child.key, index]));
  const attempts = new Map<string, number>();
  let fences = 0, finished = false, lists = 0;
  f.store.get = async (key) => {
    const index = indexes.get(key);
    if (index === undefined) return f.objects.get(key) ?? null;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    return gates[index]!.promise;
  };
  f.store.list = async () => { lists++; return { objects: [] }; };
  const outcome = runRetention(f.store, { pointers: [f.pointer], states: [{}] }, async () => {
    if (++fences === 2) await retryFence.promise;
  }, f.now).then(() => { finished = true; return null; }, (error: unknown) => { finished = true; return error; });
  await waitFor(() => attempts.size === 8);
  gates[0]!.reject(new Error('r2_get_failed:503'));
  await waitFor(() => fences === 2);
  const terminal = new Error('r2_get_failed:403');
  gates[1]!.reject(terminal);
  await flushWork();
  assert.equal(finished, false);
  retryFence.resolve();
  for (let index = 2; index < 8; index++) gates[index]!.resolve(f.objects.get(f.children[index]!.key)!);
  const error = await outcome;
  assert.ok(error instanceof RetentionFailure);
  assert.equal(error.cause, terminal);
  assert.equal(error.key, f.children[1]!.key);
  assert.ok([...attempts.values()].every((count) => count === 1), 'no retry starts after another branch has failed');
  assert.equal(lists, 0);
  assert.deepEqual(f.deleted, []);
});

test('retention retries only bounded transient R2 GET failures and can still complete normal cleanup', async (t) => {
  for (const code of ['0:TimeoutError', '0:AbortError', '408', '429', '500', '503:SlowDown']) {
    await t.test(code, async () => {
      const f = fixture(), key = f.pointers[0]!.manifestKey;
      let attempts = 0;
      const get = f.store.get.bind(f.store);
      f.store.get = async (requested, maximum) => {
        if (requested === key && ++attempts <= 2) throw new Error('r2_get_failed:' + code);
        return get(requested, maximum);
      };
      const result = await runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now);
      assert.equal(attempts, 3);
      assert.equal(result.readRetries, 2);
      assert.deepEqual(new Set(f.deleted), new Set([f.orphan, f.orphanDescriptor]));
      assert.ok(f.pointers.every((pointer) => f.objects.has(pointer.manifestKey)));
    });
  }
});

test('an exhausted timeout is reported with its exact graph key after only three budgeted attempts', async () => {
  const f = fixture(), key = f.pointers[0]!.manifestKey, timeout = new Error('r2_get_failed:0:TimeoutError');
  let networkGets = 0, lists = 0;
  f.store.get = async () => { networkGets++; throw timeout; };
  f.store.list = async () => { lists++; return { objects: [] }; };
  const store = new BudgetedObjectStore(f.store, { ...PUBLISHER_RUN_LIMITS });
  await assert.rejects(runRetention(store, { pointers: f.pointers, states: f.states }, async () => {}, f.now), (error: unknown) => {
    assert.ok(error instanceof RetentionFailure);
    assert.equal(error.stage, 'mark'); assert.equal(error.key, key);
    assert.equal(error.cause, timeout); assert.equal(error.message, timeout.message);
    return true;
  });
  assert.equal(networkGets, 3);
  assert.equal(store.usage.r2Gets, 3);
  assert.equal(lists, 0);
  assert.deepEqual(f.deleted, []);
});

test('a retry cannot bypass the existing GET request or byte budgets', async (t) => {
  for (const kind of ['requests', 'bytes'] as const) await t.test(kind, async () => {
    const f = fixture(), key = f.pointers[0]!.manifestKey;
    let networkGets = 0, fences = 0;
    const get = f.store.get.bind(f.store);
    f.store.get = async (requested, maximum) => {
      networkGets++;
      if (networkGets === 1) throw new Error('r2_get_failed:0:TimeoutError');
      return get(requested, maximum);
    };
    const store = new BudgetedObjectStore(f.store, { ...PUBLISHER_RUN_LIMITS,
      ...(kind === 'requests' ? { maxR2GetRequests: 1 } : { maxR2GetBytes: f.objects.get(key)!.byteLength - 1 }) });
    await assert.rejects(runRetention(store, { pointers: f.pointers, states: f.states }, async () => { fences++; }, f.now),
      kind === 'requests' ? /publisher_r2_get_budget_exceeded/u : /publisher_r2_read_byte_budget_exceeded/u);
    assert.equal(networkGets, kind === 'requests' ? 1 : 2);
    assert.equal(store.usage.r2Gets, networkGets, 'usage counts every actual GET, including failed attempts');
    assert.equal(fences, 2, 'budget exhaustion must not trigger another retry fence');
    assert.deepEqual(f.deleted, []);
  });
});

test('missing objects, invalid bytes and permanent provider failures are never retried', async (t) => {
  for (const kind of ['missing', 'corrupt', 'permanent'] as const) await t.test(kind, async () => {
    const f = fixture(), key = f.pointers[0]!.manifestKey;
    let attempts = 0, fences = 0;
    const get = f.store.get.bind(f.store);
    f.store.get = async (requested, maximum) => {
      if (requested !== key) return get(requested, maximum);
      attempts++;
      if (kind === 'missing') return null;
      if (kind === 'corrupt') return Buffer.from('corrupt');
      throw new Error('r2_get_failed:403:AccessDenied');
    };
    await assert.rejects(runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => { fences++; }, f.now),
      kind === 'missing' ? /retention_artifact_unavailable/u : kind === 'corrupt' ? /retention_manifest_invalid/u : /r2_get_failed:403/u);
    assert.equal(attempts, 1);
    assert.equal(fences, 1);
    assert.deepEqual(f.deleted, []);
  });
});

test('a lost or expired publisher lease prevents retrying a transient read', async (t) => {
  for (const failure of ['publisher_lease_lost', 'publisher_lease_time_budget_exceeded']) await t.test(failure, async () => {
    const f = fixture(), leaseError = new Error(failure);
    let attempts = 0, fences = 0;
    f.store.get = async () => { attempts++; throw new Error('r2_get_failed:0:TimeoutError'); };
    await assert.rejects(runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {
      if (++fences === 2) throw leaseError;
    }, f.now), (error: unknown) => {
      assert.ok(error instanceof RetentionFailure);
      assert.equal(error.cause, leaseError);
      assert.equal(error.key, null, 'a lease failure must not be attributed to the artifact being retried');
      return true;
    });
    assert.equal(attempts, 1);
    assert.equal(fences, 2);
    assert.deepEqual(f.deleted, []);
  });
});

test('an unavailable or corrupt previous publication graph prevents sweeping the current publication', async (t) => {
  for (const kind of ['missing', 'corrupt'] as const) await t.test(kind, async () => {
    const f = fixture();
    const previous = JSON.parse(Buffer.from(f.objects.get(f.pointers[1]!.manifestKey)!).toString()) as { identityRoot: { key: string } };
    const key = previous.identityRoot.key, get = f.store.get.bind(f.store);
    let attempts = 0, lists = 0;
    f.store.get = async (requested, maximum) => {
      if (requested === key) { attempts++; return kind === 'missing' ? null : Buffer.from('corrupt'); }
      return get(requested, maximum);
    };
    f.store.list = async () => { lists++; return { objects: [] }; };
    await assert.rejects(runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now),
      kind === 'missing' ? /retention_artifact_unavailable/u : /retention_artifact_invalid/u);
    assert.equal(attempts, 1);
    assert.equal(lists, 0);
    assert.deepEqual(f.deleted, []);
    assert.ok(f.pointers.every((pointer) => f.objects.has(pointer.manifestKey)));
  });
});

test('retention reports list and delete failures in their own stages without retrying provider mutations', async (t) => {
  for (const stage of ['list', 'delete'] as const) await t.test(stage, async () => {
    const f = fixture(), failure = new Error('r2_' + stage + '_failed:503');
    let calls = 0;
    if (stage === 'list') f.store.list = async () => { calls++; throw failure; };
    else f.store.delete = async () => { calls++; throw failure; };
    await assert.rejects(runRetention(f.store, { pointers: f.pointers, states: f.states }, async () => {}, f.now), (error: unknown) => {
      assert.ok(error instanceof RetentionFailure);
      assert.equal(error.stage, stage);
      assert.equal(error.key, null);
      assert.equal(error.cause, failure);
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(f.deleted, []);
  });
});


test('missing, corrupt and conflicting graph data close twelve queued reads before returning any permit', async (t) => {
  for (const kind of ['missing', 'hash', 'json', 'structure', 'conflicting'] as const) await t.test(kind, async () => {
    const f = graphFixture(20, true);
    if (kind === 'json') f.children[0] = f.artifact(Buffer.from('{"incomplete":'));
    if (kind === 'structure') f.children[0] = f.artifact({ children: [{
      key: PUBLIC_EPG_PREFIX + 'objects/' + 'f'.repeat(64) + '.json.gz', sha256: 'f'.repeat(64)
    }] });
    if (kind === 'conflicting') f.children[0] = f.artifact({ children: [
      f.descendants[0]!, { ...f.descendants[0]!, bytes: f.descendants[0]!.bytes + 1 }
    ] });
    f.pointer = f.pointerFor(f.children);
    const gates = f.children.map(() => deferred<Uint8Array | null>());
    const indexes = new Map(f.children.map((child, index) => [child.key, index]));
    const started: string[] = [];
    let active = 0, peak = 0, lists = 0, finished = false;
    f.store.get = async (key) => {
      started.push(key);
      const index = indexes.get(key);
      if (index === undefined) return f.objects.get(key) ?? null;
      active++; peak = Math.max(peak, active);
      try { return await gates[index]!.promise; } finally { active--; }
    };
    f.store.list = async () => { lists++; return { objects: [] }; };
    const outcome = runRetention(f.store, { pointers: [f.pointer], states: [{}] }, async () => {}, f.now)
      .then(() => { finished = true; return null; }, (error: unknown) => { finished = true; return error; });
    await waitFor(() => active === 8);
    const atFailure = [...started];
    let invalid: Uint8Array | null = f.objects.get(f.children[0]!.key)!;
    if (kind === 'missing') invalid = null;
    if (kind === 'hash') {
      invalid = new Uint8Array(invalid!);
      invalid[0] = invalid[0]! ^ 1;
    }
    gates[0]!.resolve(invalid);
    await flushWork();
    const afterFailure = [...started], activeAfterFailure = active, finishedBeforeDrain = finished;
    // Resolve every gate before asserting so a regression also leaves no work
    // alive in the test runner, including any incorrectly dispatched waiter.
    for (let index = 1; index < gates.length; index++) gates[index]!.resolve(f.objects.get(f.children[index]!.key)!);
    const error = await outcome;
    assert.ok(error instanceof RetentionFailure);
    assert.equal(error.stage, 'mark');
    assert.match(error.message, kind === 'missing' ? /retention_artifact_unavailable/u
      : kind === 'hash' ? /retention_artifact_invalid/u
      : kind === 'structure' ? /retention_ref_invalid/u
      : kind === 'conflicting' ? /retention_ref_conflict/u : /JSON/u);
    assert.equal(error.key, f.children[0]!.key, 'diagnostics must identify the object whose bytes failed validation');
    assert.equal(finishedBeforeDrain, false, 'the caller must keep the lease while seven reads remain active');
    assert.equal(activeAfterFailure, 7);
    assert.equal(active, 0);
    assert.equal(peak, 8);
    assert.deepEqual(afterFailure, atFailure, 'validation must close the queue before releasing its read permit');
    assert.deepEqual(started, atFailure, 'neither queued parents nor late descendants may start after validation fails');
    assert.equal(lists, 0);
    assert.deepEqual(f.deleted, []);
  });
});


test('nested graphs release parent read permits before descending and still complete normal cleanup', { timeout: 2_000 }, async () => {
  const f = graphFixture(20, true);
  let active = 0, peak = 0;
  f.store.get = async (key) => {
    active++; peak = Math.max(peak, active);
    try { await flushWork(); return f.objects.get(key) ?? null; }
    finally { active--; }
  };
  const result = await runRetention(f.store, { pointers: [f.pointer], states: [{}] }, async () => {}, f.now);
  assert.equal(active, 0);
  assert.equal(peak, 8);
  assert.ok(result.deleted > 0);
  assert.ok(f.deleted.includes(f.orphan));
  assert.ok(f.deleted.includes(f.orphanDescriptor));
  assert.ok(f.objects.has(f.pointer.manifestKey));
  assert.ok([...f.children, ...f.descendants].every((ref) => f.objects.has(ref.key)),
    'both parent and descendant objects stay pinned through the sweep');
});
