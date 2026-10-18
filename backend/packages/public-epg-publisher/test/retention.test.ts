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
import { runRetention, RETENTION_LIMITS } from '../src/retention.js';
import { sha256, type RetentionObjectStore } from '../src/encoding.js';
import { PUBLISHER_RUN_LIMITS } from '../src/publish.js';
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
