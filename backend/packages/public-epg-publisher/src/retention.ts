import {
  PUBLIC_EPG_LIMITS,
  PUBLIC_EPG_PREFIX,
  publicProgrammeNameDescriptorKey,
  validArtifactRef,
  validCurrentPointer,
  validManifest,
  validPublicProgrammeNameDescriptor,
  type ArtifactRef,
  type CurrentPointer
} from '@vocaltv/public-epg-contract';
import { gunzip, sha256, type RetentionObjectStore, type VerifiedArtifactStore } from './encoding.js';

export type RetentionRoots = { pointers: CurrentPointer[]; states: unknown[] };
// The measured v2 graph has 35,296 objects, including 25,161 XML parts.
// Cover both pinned graphs and the 48-hour quarantine at a 12-hour cadence;
// allow five complete graphs plus legacy/failed staging objects, and reclaim
// complete expired generations only after full root validation.
export const RETENTION_LIMITS = { graceMs: 48 * 60 * 60 * 1000, maxObjects: 250_000, maxLists: 250,
  maxDeletes: 100_000, maxReadBytes: 1024 * 1024 * 1024, maxDecodedBytes: 256 * 1024 * 1024,
  maxNamespaceBytes: 7_000_000_000 } as const;

/** Mark both pinned publications and source caches, then sweep only old orphan
 * objects. A corrupt/missing graph, incomplete enumeration or lost lease causes
 * zero deletion. `fence` renews the same publisher lease before every batch. */
export async function runRetention(store: RetentionObjectStore, roots: RetentionRoots,
  fence: () => Promise<void>, now = Date.now()) {
  if (roots.pointers.length < 1 || roots.pointers.length > 2 || roots.states.length < 1 || roots.states.length > 2
    || roots.pointers.some((pointer) => !validCurrentPointer(pointer))) throw new Error('retention_roots_invalid');
  const live = new Set<string>();
  const verified = new Map<string, string>();
  const verificationTasks = new Map<string, Promise<void>>();
  const verifiedRawDigests = new Map<string, string>();
  let readBytes = 0, decodedBytes = 0;
  // Bound network concurrency while allowing independent graph branches to load
  // together. No deletion begins until the entire graph has been validated.
  let activeReads = 0;
  const waitingReads: Array<() => void> = [];
  const acquireRead = async () => {
    if (activeReads >= 8) await new Promise<void>((resolve) => waitingReads.push(resolve));
    else activeReads++;
  };
  const releaseRead = () => {
    const next = waitingReads.shift();
    if (next) next(); else activeReads--;
  };
  const readOptional = async (key: string, maximum: number): Promise<Uint8Array | null> => {
    if (!key.startsWith(PUBLIC_EPG_PREFIX) || maximum <= 0 || maximum > 96 * 1024 * 1024) throw new Error('retention_ref_invalid');
    const cached = (store as Partial<VerifiedArtifactStore>).getCachedObject?.(key, maximum);
    let bytes: Uint8Array | null;
    if (cached) bytes = cached;
    else {
      await acquireRead();
      try { bytes = await store.get(key, maximum); }
      finally { releaseRead(); }
    }
    if (!bytes) return null;
    if (bytes.byteLength > maximum) throw new Error('retention_artifact_unavailable');
    readBytes += bytes.byteLength;
    if (readBytes > RETENTION_LIMITS.maxReadBytes) throw new Error('retention_read_budget_exceeded');
    return bytes;
  };
  const read = async (key: string, maximum: number) => {
    const bytes = await readOptional(key, maximum);
    if (!bytes) throw new Error('retention_artifact_unavailable');
    return bytes;
  };
  const json = (bytes: Uint8Array) => {
    decodedBytes += bytes.byteLength;
    if (decodedBytes > RETENTION_LIMITS.maxDecodedBytes) throw new Error('retention_decode_budget_exceeded');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  };
  const ref = async (artifact: ArtifactRef): Promise<void> => {
    const signature = JSON.stringify([artifact.key, artifact.sha256, artifact.bytes, artifact.compressedBytes]), prior = verified.get(artifact.key);
    if (prior) {
      if (prior !== signature) throw new Error('retention_ref_conflict');
      await verificationTasks.get(artifact.key);
      const digest = (artifact as ArtifactRef & { xmlSha256?: unknown }).xmlSha256;
      if (digest !== undefined && digest !== verifiedRawDigests.get(artifact.key)) throw new Error('retention_artifact_invalid');
      return;
    }
    verified.set(artifact.key, signature); live.add(artifact.key);
    const task = (async () => {
    if (live.size > RETENTION_LIMITS.maxObjects || artifact.bytes <= 0 || artifact.bytes > 64 * 1024 * 1024)
      throw new Error('retention_ref_invalid');
    const bytes = await read(artifact.key, artifact.compressedBytes);
    if (bytes.byteLength !== artifact.compressedBytes || sha256(bytes) !== artifact.sha256) throw new Error('retention_artifact_invalid');
    const raw = artifact.key.endsWith('.gz') ? gunzip(bytes, artifact.bytes) : bytes;
    if (raw.byteLength !== artifact.bytes) throw new Error('retention_artifact_invalid');
    verifiedRawDigests.set(artifact.key, sha256(raw));
    const xmlDigest = (artifact as ArtifactRef & { xmlSha256?: unknown }).xmlSha256;
    if (xmlDigest !== undefined && (typeof xmlDigest !== 'string' || sha256(raw) !== xmlDigest)) throw new Error('retention_artifact_invalid');
    if (artifact.key.endsWith('.json.gz') || artifact.key.endsWith('.json')) await walk(json(raw));
    else if (!artifact.key.endsWith('.xml.gz')) throw new Error('retention_ref_invalid');
    })();
    verificationTasks.set(artifact.key, task);
    await task;
  };
  const walk = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== 'object') return;
    if (validArtifactRef(value)) { await ref(value); return; }
    if (Array.isArray(value)) { await Promise.all(value.map(walk)); return; }
    const object = value as Record<string, unknown>;
    if ('compressedBytes' in object || 'key' in object && 'sha256' in object) throw new Error('retention_ref_invalid');
    if ('bodyKey' in object) {
      const key = object.bodyKey, digest = object.bodySha256, size = object.bodyBytes;
      if (typeof key !== 'string' || !/^public-epg\/v1\/publisher\/source-cache\/[A-Za-z0-9._-]{1,160}\/[a-f0-9]{64}\.body$/u.test(key)
        || typeof digest !== 'string' || !key.endsWith('/' + digest + '.body') || !Number.isSafeInteger(size)
        || Number(size) <= 0 || Number(size) > 16 * 1024 * 1024) throw new Error('retention_source_cache_invalid');
      if (!live.has(key)) {
        const bytes = await read(key, Number(size));
        if (bytes.byteLength !== size || sha256(bytes) !== digest) throw new Error('retention_source_cache_invalid');
        live.add(key);
      }
    }
    await Promise.all(Object.values(object).map(walk));
  };
  await fence();
  for (const pointer of roots.pointers) {
    live.add(pointer.manifestKey);
    const bytes = await read(pointer.manifestKey, 32 * 1024);
    if (sha256(bytes) !== pointer.manifestSha256) throw new Error('retention_manifest_invalid');
    const manifest = json(bytes);
    if (!validManifest(manifest) || manifest.revision !== pointer.revision) throw new Error('retention_manifest_invalid');
    await walk(manifest);
    if (manifest.schemaVersion === 2 && manifest.programmeRoot) {
      const descriptorKey = publicProgrammeNameDescriptorKey(manifest.programmeRoot.sha256);
      const descriptorBytes = await readOptional(descriptorKey, PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes);
      if (descriptorBytes) {
        const descriptor = json(descriptorBytes);
        if (!validPublicProgrammeNameDescriptor(descriptor)
          || descriptor.programmeRootSHA256 !== manifest.programmeRoot.sha256) {
          throw new Error('retention_programme_names_invalid');
        }
        live.add(descriptorKey);
        await walk(descriptor.root);
      }
    }
  }
  for (const state of roots.states) await walk(state);
  const candidates: string[] = [];
  let cursor: string | undefined, lists = 0, namespaceBytes = 0, objects = 0;
  const seenCursors = new Set<string>();
  do {
    await fence();
    if (++lists > RETENTION_LIMITS.maxLists) throw new Error('retention_listing_budget_exceeded');
    const page = await store.list(PUBLIC_EPG_PREFIX, cursor);
    if (page.objects.length > 1000) throw new Error('retention_listing_invalid');
    for (const item of page.objects) {
      if (!item.key.startsWith(PUBLIC_EPG_PREFIX) || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || !Number.isFinite(item.lastModified)) throw new Error('retention_listing_invalid');
      namespaceBytes += item.bytes;
      if (++objects > RETENTION_LIMITS.maxObjects) throw new Error('retention_listing_budget_exceeded');
      // General coordination keys remain pinned. Explicit upload-session keys expire
      // after the unchanged 48-hour quarantine, well beyond their two-hour session.
      const expiredUpload = /^public-epg\/v1\/publisher\/uploads\/[a-f0-9]{32}\/(plan\.json|job\.json|receipts\/[a-f0-9]{64}\.json)$/u.test(item.key);
      const immutable = /^public-epg\/v1\/(objects\/[a-f0-9]{64}\.(json|xml)\.gz|manifests\/[a-f0-9]{64}\.json|source-names\/[a-f0-9]{64}\.json|publisher\/source-cache\/[A-Za-z0-9._-]{1,160}\/[a-f0-9]{64}\.body)$/u.test(item.key);
      if ((immutable || expiredUpload) && !live.has(item.key) && item.lastModified < now - RETENTION_LIMITS.graceMs) candidates.push(item.key);
    }
    cursor = page.cursor;
    if (cursor) { if (seenCursors.has(cursor)) throw new Error('retention_listing_invalid'); seenCursors.add(cursor); }
  } while (cursor);
  if (candidates.length > RETENTION_LIMITS.maxDeletes) throw new Error('retention_delete_budget_exceeded');
  let deleted = 0;
  for (let index = 0; index < candidates.length; index += 1000) {
    await fence();
    const batch = candidates.slice(index, index + 1000);
    await store.delete(batch); deleted += batch.length;
  }
  return { objects, lists, deleted, readBytes, namespaceBytes,
    storageBudgetExceeded: namespaceBytes > RETENTION_LIMITS.maxNamespaceBytes };
}
