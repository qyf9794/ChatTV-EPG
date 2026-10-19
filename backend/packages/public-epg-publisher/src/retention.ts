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
export type RetentionStage = 'mark' | 'list' | 'delete';
/** Public namespace key and sanitized provider code remain separate from publication success. */
export class RetentionFailure extends Error {
  constructor(readonly stage: RetentionStage, cause: unknown, readonly key: string | null = null) {
    super(cause instanceof Error ? cause.message : 'retention_failed', { cause });
    this.name = 'RetentionFailure';
  }
}
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
  const declaredRefs = new Map<string, string>();
  const declaredXmlDigests = new Map<string, string>();
  const refSignature = (artifact: ArtifactRef) => JSON.stringify([artifact.key, artifact.sha256, artifact.bytes, artifact.compressedBytes]);
  const verificationTasks = new Map<string, Promise<void>>();
  const verifiedRawDigests = new Map<string, string>();
  let readBytes = 0, decodedBytes = 0, readRetries = 0;
  let failed = false, firstError: unknown;
  let stage: RetentionStage = 'mark';
  // Bound network concurrency while allowing independent graph branches to load
  // together. No deletion begins until the entire graph has been validated.
  let activeReads = 0;
  const waitingReads: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const check = () => { if (failed) throw firstError; };
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true; firstError = error;
      for (const waiter of waitingReads.splice(0)) waiter.reject(error);
    }
    return firstError;
  };
  const acquireRead = async () => {
    check();
    if (activeReads >= 8) await new Promise<void>((resolve, reject) => waitingReads.push({ resolve, reject }));
    else activeReads++;
  };
  const releaseRead = () => {
    const next = waitingReads.shift();
    if (next) next.resolve(); else activeReads--;
  };
  // Lease renewal is a mutable CAS. Coalesce retries from independent branches
  // so they cannot renew the same lease concurrently and fence each other out.
  let retryFence: Promise<void> | undefined;
  const fenceRetry = () => retryFence ??= fence()
    .catch((error: unknown) => { throw fail(new RetentionFailure('mark', error)); })
    .finally(() => { retryFence = undefined; });
  const readOptional = async (key: string, maximum: number, required = false,
    validate?: (bytes: Uint8Array) => void): Promise<Uint8Array | null> => {
    let acquired = false;
    try {
      check();
      if (!key.startsWith(PUBLIC_EPG_PREFIX) || maximum <= 0 || maximum > 96 * 1024 * 1024) throw new Error('retention_ref_invalid');
      const cached = (store as Partial<VerifiedArtifactStore>).getCachedObject?.(key, maximum);
      let bytes: Uint8Array | null;
      if (cached) bytes = cached;
      else {
        await acquireRead();
        acquired = true;
        for (let attempt = 0; ; attempt++) {
          check();
          try { bytes = await store.get(key, maximum); break; }
          catch (error) {
            check();
            if (attempt >= 2 || !(error instanceof Error)
              || !/^r2_get_failed:(?:408|429|5\d\d|0:(?:TimeoutError|AbortError))(?:[:][A-Za-z_]{1,64})?$/u.test(error.message)) throw error;
            // Each retry passes through the same request/byte budgets and the
            // existing lease time fence. Never retry missing/corrupt data.
            await fenceRetry();
            check();
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
            check();
            readRetries++;
          }
        }
      }
      check();
      if (!bytes) {
        if (required) throw new Error('retention_artifact_unavailable');
        return null;
      }
      if (bytes.byteLength > maximum) throw new Error('retention_artifact_unavailable');
      readBytes += bytes.byteLength;
      if (readBytes > RETENTION_LIMITS.maxReadBytes) throw new Error('retention_read_budget_exceeded');
      // Validation failures must close the gate before a queued reader gets this slot.
      validate?.(bytes);
      return bytes;
    } catch (error) {
      // Close the queue before returning a permit, including budget failures.
      throw fail(error instanceof RetentionFailure ? error : new RetentionFailure('mark', error, key));
    } finally { if (acquired) releaseRead(); }
  };
  const read = async (key: string, maximum: number, validate?: (bytes: Uint8Array) => void) => {
    const bytes = await readOptional(key, maximum, true, validate);
    if (!bytes) throw fail(new RetentionFailure('mark', new Error('retention_artifact_unavailable'), key));
    return bytes;
  };
  const sourceCacheReference = (object: Record<string, unknown>) => {
    const key = object.bodyKey, digest = object.bodySha256, size = object.bodyBytes;
    if (typeof key !== 'string' || !/^public-epg\/v1\/publisher\/source-cache\/[A-Za-z0-9._-]{1,160}\/[a-f0-9]{64}\.body$/u.test(key)
      || typeof digest !== 'string' || !key.endsWith('/' + digest + '.body') || !Number.isSafeInteger(size)
      || Number(size) <= 0 || Number(size) > 16 * 1024 * 1024) throw new Error('retention_source_cache_invalid');
    return { key, digest, size: Number(size) };
  };
  const validateLocalReferences = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (validArtifactRef(value)) {
      const signature = refSignature(value), prior = declaredRefs.get(value.key);
      if (prior && prior !== signature) throw new Error('retention_ref_conflict');
      declaredRefs.set(value.key, signature);
      const digest = (value as ArtifactRef & { xmlSha256?: unknown }).xmlSha256;
      if (digest !== undefined) {
        const priorDigest = declaredXmlDigests.get(value.key);
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)
          || priorDigest !== undefined && priorDigest !== digest) throw new Error('retention_artifact_invalid');
        declaredXmlDigests.set(value.key, digest);
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach(validateLocalReferences); return; }
    const object = value as Record<string, unknown>;
    if ('compressedBytes' in object || 'key' in object && 'sha256' in object) throw new Error('retention_ref_invalid');
    if ('bodyKey' in object) sourceCacheReference(object);
    Object.values(object).forEach(validateLocalReferences);
  };
  const json = (bytes: Uint8Array) => {
    decodedBytes += bytes.byteLength;
    if (decodedBytes > RETENTION_LIMITS.maxDecodedBytes) throw new Error('retention_decode_budget_exceeded');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    validateLocalReferences(value);
    return value;
  };
  const ref = async (artifact: ArtifactRef): Promise<void> => {
    check();
    const signature = refSignature(artifact), prior = verified.get(artifact.key);
    if (prior) {
      if (prior !== signature) throw fail(new RetentionFailure('mark', new Error('retention_ref_conflict'), artifact.key));
      await verificationTasks.get(artifact.key);
      const digest = (artifact as ArtifactRef & { xmlSha256?: unknown }).xmlSha256;
      if (digest !== undefined && digest !== verifiedRawDigests.get(artifact.key))
        throw fail(new RetentionFailure('mark', new Error('retention_artifact_invalid'), artifact.key));
      return;
    }
    verified.set(artifact.key, signature); live.add(artifact.key);
    const task = (async () => {
      try {
        check();
        if (live.size > RETENTION_LIMITS.maxObjects || artifact.bytes <= 0 || artifact.bytes > 64 * 1024 * 1024)
          throw new Error('retention_ref_invalid');
        let payload: unknown;
        const isJSON = artifact.key.endsWith('.json.gz') || artifact.key.endsWith('.json');
        await read(artifact.key, artifact.compressedBytes, (bytes) => {
          if (bytes.byteLength !== artifact.compressedBytes || sha256(bytes) !== artifact.sha256) throw new Error('retention_artifact_invalid');
          const raw = artifact.key.endsWith('.gz') ? gunzip(bytes, artifact.bytes) : bytes;
          if (raw.byteLength !== artifact.bytes) throw new Error('retention_artifact_invalid');
          const rawDigest = sha256(raw);
          verifiedRawDigests.set(artifact.key, rawDigest);
          const xmlDigest = (artifact as ArtifactRef & { xmlSha256?: unknown }).xmlSha256;
          if (xmlDigest !== undefined && (typeof xmlDigest !== 'string' || rawDigest !== xmlDigest)) throw new Error('retention_artifact_invalid');
          if (isJSON) payload = json(raw);
          else if (!artifact.key.endsWith('.xml.gz')) throw new Error('retention_ref_invalid');
        });
        check();
        // Release the read slot after synchronous validation, before descending:
        // holding parent slots while children wait would deadlock a deep graph.
        if (isJSON) await walk(payload);
      } catch (error) { throw fail(new RetentionFailure('mark', error, artifact.key)); }
    })();
    verificationTasks.set(artifact.key, task);
    await task;
  };
  const walk = async (value: unknown): Promise<void> => {
    try {
      check();
      if (!value || typeof value !== 'object') return;
      if (validArtifactRef(value)) { await ref(value); return; }
      if (Array.isArray(value)) { await walkAll(value); return; }
      const object = value as Record<string, unknown>;
      if ('compressedBytes' in object || 'key' in object && 'sha256' in object) throw new Error('retention_ref_invalid');
      if ('bodyKey' in object) {
        const { key, digest, size } = sourceCacheReference(object);
        if (!live.has(key)) {
          await read(key, size, (bytes) => {
            if (bytes.byteLength !== size || sha256(bytes) !== digest) throw new Error('retention_source_cache_invalid');
          });
          live.add(key);
        }
      }
      await walkAll(Object.values(object));
    } catch (error) { throw fail(error); }
  };
  const walkAll = async (values: unknown[]) => {
    // Each walk records its first failure; allSettled joins every child before
    // check rethrows it. The publisher cannot release its lease with work alive.
    await Promise.allSettled(values.map(walk));
    check();
  };
  try {
    await fence();
    for (const pointer of roots.pointers) {
      live.add(pointer.manifestKey);
      const bytes = await read(pointer.manifestKey, 32 * 1024);
      if (sha256(bytes) !== pointer.manifestSha256) throw new RetentionFailure('mark', new Error('retention_manifest_invalid'), pointer.manifestKey);
      const manifest = json(bytes);
      if (!validManifest(manifest) || manifest.revision !== pointer.revision) throw new RetentionFailure('mark', new Error('retention_manifest_invalid'), pointer.manifestKey);
      await walk(manifest);
      if (manifest.schemaVersion === 2 && manifest.programmeRoot) {
        const descriptorKey = publicProgrammeNameDescriptorKey(manifest.programmeRoot.sha256);
        const descriptorBytes = await readOptional(descriptorKey, PUBLIC_EPG_LIMITS.maxProgrammeNameDescriptorBytes);
        if (descriptorBytes) {
          const descriptor = json(descriptorBytes);
          if (!validPublicProgrammeNameDescriptor(descriptor)
            || descriptor.programmeRootSHA256 !== manifest.programmeRoot.sha256) {
            throw new RetentionFailure('mark', new Error('retention_programme_names_invalid'), descriptorKey);
          }
          live.add(descriptorKey);
          await walk(descriptor.root);
        }
      }
    }
    for (const state of roots.states) { validateLocalReferences(state); await walk(state); }
    stage = 'list';
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
    stage = 'delete';
    for (let index = 0; index < candidates.length; index += 1000) {
      await fence();
      const batch = candidates.slice(index, index + 1000);
      await store.delete(batch); deleted += batch.length;
    }
    return { objects, lists, deleted, readBytes, readRetries, namespaceBytes,
      storageBudgetExceeded: namespaceBytes > RETENTION_LIMITS.maxNamespaceBytes };
  } catch (error) {
    throw error instanceof RetentionFailure ? error : new RetentionFailure(stage, error);
  }
}
