import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStorageHeadroom } from '../src/storage-budget.js';
import { RETENTION_LIMITS } from '../src/retention.js';
import type { RetentionObjectStore } from '../src/encoding.js';

test('storage admission counts unknown namespace objects and reserves uploads before allocation', async () => {
  let writes = 0, fences = 0;
  const store = { list: async () => ({ objects: [{key:'public-epg/v1/unknown',bytes:RETENTION_LIMITS.maxNamespaceBytes - 99,lastModified:0}] }),
    put: async () => { writes++; } } as unknown as RetentionObjectStore;
  await assert.rejects(assertStorageHeadroom(store,100,async () => { fences++; }), /storage_budget_exceeded/u);
  assert.equal(writes,0); assert.equal(fences,1);
  const result = await assertStorageHeadroom(store,99,async () => {});
  assert.equal(result.bytes + result.reservedBytes,RETENTION_LIMITS.maxNamespaceBytes);
});
test('incomplete namespace enumeration fails closed', async () => {
  const store = { list: async () => ({ objects:[],cursor:'repeated' }) } as unknown as RetentionObjectStore;
  await assert.rejects(assertStorageHeadroom(store,1024,async () => {}), /listing_invalid/u);
});

test('storage admission covers rolling v2 graphs while retaining a finite listing ceiling', async () => {
  const storeFor = (count: number) => ({ list: async (_prefix: string, cursor?: string) => {
    const start = Number(cursor ?? 0), end = Math.min(start + 1000, count);
    return { objects: Array.from({ length: end - start }, (_, index) => ({
      key: `public-epg/v1/unknown-${start + index}`, bytes: 1, lastModified: 0
    })), ...(end < count ? { cursor: String(end) } : {}) };
  } }) as unknown as RetentionObjectStore;
  const result = await assertStorageHeadroom(storeFor(130_000), 1024, async () => {});
  assert.equal(result.objects, 130_000);
  assert.equal(result.lists, 130);
  const atLimit = await assertStorageHeadroom(storeFor(RETENTION_LIMITS.maxObjects), 1024, async () => {});
  assert.equal(atLimit.objects, RETENTION_LIMITS.maxObjects);
  await assert.rejects(assertStorageHeadroom(storeFor(RETENTION_LIMITS.maxObjects + 1), 1024, async () => {}), /listing_budget_exceeded/u);
});
