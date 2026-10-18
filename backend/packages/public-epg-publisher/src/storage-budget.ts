import { PUBLIC_EPG_PREFIX } from '@vocaltv/public-epg-contract';
import type { RetentionObjectStore } from './encoding.js';
import { RETENTION_LIMITS } from './retention.js';

/** Reserve the entire possible immutable upload before allocating any artifacts.
 * Existing objects, unknown keys and in-flight orphans all consume headroom. */
export async function assertStorageHeadroom(store: RetentionObjectStore, reserveBytes: number,
  fence: () => Promise<void>) {
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes <= 0 || reserveBytes > RETENTION_LIMITS.maxNamespaceBytes)
    throw new Error('publisher_storage_reservation_invalid');
  let cursor: string | undefined, lists = 0, objects = 0, bytes = 0;
  const cursors = new Set<string>();
  do {
    await fence();
    if (++lists > RETENTION_LIMITS.maxLists) throw new Error('publisher_storage_listing_budget_exceeded');
    const page = await store.list(PUBLIC_EPG_PREFIX, cursor);
    if (page.objects.length > 1000) throw new Error('publisher_storage_listing_invalid');
    for (const item of page.objects) {
      if (!item.key.startsWith(PUBLIC_EPG_PREFIX) || !Number.isSafeInteger(item.bytes) || item.bytes < 0)
        throw new Error('publisher_storage_listing_invalid');
      if (++objects > RETENTION_LIMITS.maxObjects) throw new Error('publisher_storage_listing_budget_exceeded');
      bytes += item.bytes;
      if (!Number.isSafeInteger(bytes) || bytes + reserveBytes > RETENTION_LIMITS.maxNamespaceBytes)
        throw new Error('publisher_storage_budget_exceeded');
    }
    cursor = page.cursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('publisher_storage_listing_invalid');
      cursors.add(cursor);
    }
  } while (cursor);
  return { bytes, objects, lists, reservedBytes: reserveBytes };
}
