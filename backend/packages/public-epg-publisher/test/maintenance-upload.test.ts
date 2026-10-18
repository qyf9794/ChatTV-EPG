import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_EPG_CURRENT_KEY, PUBLIC_EPG_PUBLISHER_STATE_KEY, type ArtifactRef, type PublicEpgManifest } from "@vocaltv/public-epg-contract";
import { PublicUploadService, proveObject, validateUploadGraph, buildReferenceTree, referenceRangeProof, verifyReferenceRange, UPLOAD_LIMITS, MAINTENANCE_RUN_LIMITS } from "../src/maintenance-upload.js";
import { jsonBytes, putImmutable, sha256, type ObjectMetadata, type RetentionObjectStore } from "../src/encoding.js";
import { writeRoutedDirectory, identityRecords, nameRecords, streamsRecords } from "../src/index-builder.js";
import { publicEpgSources, publicMetadataSources } from "../src/sources.js";
import { BudgetedObjectStore } from "../src/publish.js";

class MemoryStore implements RetentionObjectStore {
  files = new Map<string, Uint8Array>(); gets: string[] = []; puts: string[] = []; failPointer = false; corruptObjects = false; losePointerACK = false; failJobOnce = false; loseJobACKOnce = false; loseLeaseACKOnce = false; losePublishedJobACKOnce = false;
  raceArtifactOnce: "same" | "corrupt" | undefined;
  async get(key: string, maximum = Infinity) {
    this.gets.push(key);
    const body = this.files.get(key); if (!body) return null;
    if (body.byteLength > maximum) throw new Error("r2_object_size_invalid"); return new Uint8Array(body);
  }
  async getWithETag(key: string, maximum = Infinity) {
    const value = await this.get(key, maximum); return value ? { value, etag: sha256(value) } : null;
  }
  async put(key: string, bytes: Uint8Array, _metadata: ObjectMetadata) { this.files.set(key, new Uint8Array(bytes)); }
  async putConditional(key: string, bytes: Uint8Array, _metadata: ObjectMetadata, condition: { ifMatch: string } | { ifNoneMatch: "*" }) {
    this.puts.push(key);
    const prior = this.files.get(key);
    if (!prior && this.raceArtifactOnce && key.includes("/objects/")) {
      this.files.set(key, this.raceArtifactOnce === "same" ? new Uint8Array(bytes) : new Uint8Array(bytes.length));
      this.raceArtifactOnce = undefined; throw new Error("r2_precondition_failed");
    }
    if (this.failJobOnce && key.endsWith("/job.json")) { this.failJobOnce = false; throw new Error("synthetic_job_write_failed"); }
    if (key === PUBLIC_EPG_CURRENT_KEY && this.failPointer) throw new Error("r2_precondition_failed");
    if ("ifMatch" in condition ? !prior || sha256(prior) !== condition.ifMatch : Boolean(prior)) throw new Error("r2_precondition_failed");
    this.files.set(key, this.corruptObjects && key.includes("/objects/") ? new Uint8Array(bytes.length) : new Uint8Array(bytes));
    if (this.losePublishedJobACKOnce && key.endsWith("/job.json") && JSON.parse(Buffer.from(bytes).toString()).mode === "published") {
      this.losePublishedJobACKOnce = false; throw new Error("synthetic_published_ack_lost");
    }
    if (this.loseJobACKOnce && key.endsWith("/job.json")) { this.loseJobACKOnce = false; throw new Error("synthetic_job_ack_lost"); }
    if (this.loseLeaseACKOnce && key.endsWith("/lease.json")) { this.loseLeaseACKOnce = false; throw new Error("synthetic_lease_ack_lost"); }
    if (key === PUBLIC_EPG_CURRENT_KEY && this.losePointerACK) throw new Error("synthetic_ack_lost");
    return sha256(bytes);
  }
  async list() { return { objects: [...this.files].map(([key, body]) => ({ key, bytes: body.byteLength, lastModified: 0 })) }; }
  async delete(keys: string[]) { for (const key of keys) this.files.delete(key); }
}
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = Date.parse("2026-10-04T14:00:00Z");
test("maintenance enumerates the shared namespace without inheriting scheduled read or deletion allowances", async () => {
  const remote = new MemoryStore();
  let lists = 0, deletes = 0;
  remote.list = async () => { lists++; return { objects: [] }; };
  remote.delete = async () => { deletes++; };
  const store = new BudgetedObjectStore(remote, MAINTENANCE_RUN_LIMITS);
  for (let index = 0; index < 25_000; index++) await store.get("public-epg/v1/maintenance-budget-fixture");
  await assert.rejects(store.get("public-epg/v1/maintenance-budget-fixture"), /publisher_r2_get_budget_exceeded/u);
  assert.equal(remote.gets.length, 25_000);
  for (let index = 0; index < 250; index++) await store.list("public-epg/v1/");
  await assert.rejects(store.list("public-epg/v1/"), /publisher_r2_list_budget_exceeded/u);
  assert.equal(lists, 250);
  for (let index = 0; index < 10; index++) await store.delete(Array.from({ length: 1000 }, (_, key) => `fixture-${index}-${key}`));
  await assert.rejects(store.delete(["over-budget"]), /publisher_r2_delete_budget_exceeded/u);
  assert.equal(deletes, 10);
  assert.equal(store.usage.r2DeleteObjects, 10_000);
});
test("runtime storage acceptance checks both conditional writes and readback on a cleaned private key", async () => {
  assert.equal(MAINTENANCE_RUN_LIMITS.maxR2PutRequests, 5000);
  const remote = new MemoryStore(); const prior = jsonBytes({ unchanged: true });
  remote.files.set(PUBLIC_EPG_CURRENT_KEY, prior);
  const result = await new PublicUploadService(remote, () => now).handle(owner, { action: "verify-storage" });
  assert.deepEqual(result, { ok: true, conditionalCreate: true, wrongETagRejected: true, conditionalUpdate: true,
    cleanupVerified: true, puts: 4, gets: 3, deletes: 1 });
  assert.deepEqual(remote.files.get(PUBLIC_EPG_CURRENT_KEY), prior); assert.equal(remote.files.size, 1);
  assert.ok(remote.puts.every(k => /^public-epg\/v1\/publisher\/uploads\/[a-f0-9]{32}\/job.json$/u.test(k)));
  const unsafe = new MemoryStore();
  unsafe.putConditional = async (key, bytes) => { unsafe.files.set(key, bytes); return sha256(bytes); };
  await assert.rejects(new PublicUploadService(unsafe, () => now).handle(owner, { action: "verify-storage" }), /upload_storage_conditions_unsafe/);
  assert.equal(unsafe.files.size, 0);
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner,
    { action: "verify-storage", key: PUBLIC_EPG_CURRENT_KEY }), /upload_fields_invalid/);
  const rejected = new MemoryStore(); let deleted = false;
  rejected.putConditional = async () => { throw new Error("r2_precondition_failed"); };
  rejected.delete = async () => { deleted = true; };
  await assert.rejects(new PublicUploadService(rejected, () => now).handle(owner,
    { action: "verify-storage" }), /r2_precondition_failed/);
  assert.equal(deleted, false, "an unowned or unknown creation must not be deleted");
});
test("a missing stage object is read once before creation; concurrent creators still need exact remote readback", async () => {
  const f = await fixture();
  for (const race of [undefined, "same", "corrupt"] as const) {
    const remote = new MemoryStore(), job = await begin(remote, f); remote.raceArtifactOnce = race;
    const request = { action: "batch", jobId: job.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) };
    const pending = new PublicUploadService(remote, () => now).handle(owner, request);
    if (race === "corrupt") await assert.rejects(pending, /upload_readback_invalid/);
    else await pending;
    assert.equal(remote.gets.filter(key => key === f.refs[0]!.key).length, 2, "one absent lookup and one genuine readback");
    assert.equal(remote.files.has(PUBLIC_EPG_CURRENT_KEY), false);
  }
});
async function fixture() {
  const local = new MemoryStore(); const source = publicEpgSources[0]!;
  const xmlBody = new TextEncoder().encode('<?xml version="1.0"?><tv><channel id="xml-demo"><display-name>Demo</display-name></channel><programme channel="xml-demo" start="20261004140000 +0000" stop="20261004160000 +0000"><title>Fixture</title></programme></tv>');
  const part = await putImmutable(local, "xml", xmlBody);
  const identity = { provider: "iptv-org" as const, channelID: "Demo.xy", feedID: null, canonicalName: "Demo", feedName: null,
    name: "Demo", aliases: [], languages: [], broadcastAreas: [], timezones: [],
    relations: [{ sourceID: source.id, sourceRevision: "a".repeat(64), sourcePriority: source.priority,
      xmltvChannelID: "xml-demo", displayName: "Demo", days: [{ utcDay: "2026-10-04", parts: [{ ...part, utcDay: "2026-10-04", part: 0, xmlSha256: sha256(xmlBody) }] }] }] };
  const entry = { term: "demo", candidates: [{ provider: "iptv-org" as const, channelID: identity.channelID, feedID: null, matchKind: "exact" as const }], ambiguous: false };
  const identityRoot = await writeRoutedDirectory(local, "identity", identityRecords([identity]));
  const nameRoot = await writeRoutedDirectory(local, "name", nameRecords([entry]));
  const metadataNameRoot = await writeRoutedDirectory(local, "metadata-name", nameRecords([entry]));
  const streamsRoot = await writeRoutedDirectory(local, "streams", streamsRecords([{ channelID: identity.channelID, feedID: null,
    streams: [{ streamId: "public-fixture", providerChannelId: identity.channelID, title: "Demo", url: "https://example.com/public.m3u8", labels: [] }] }]));
  const manifest: PublicEpgManifest = { schemaVersion: 1, revision: "c".repeat(64), generatedAt: new Date(now).toISOString(), previousRevision: null,
    indexInputDigest: "b".repeat(64), sources: [...publicEpgSources, ...publicMetadataSources].map(s => ({ sourceID: s.id,
      sourceRevision: "a".repeat(64), status: "ready", lastGoodAt: new Date(now).toISOString() })), identityRoot, nameRoot, metadataNameRoot, streamsRoot };
  const refs: ArtifactRef[] = [...local.files].map(([key, body]) => {
    const raw = (requireGzip(body)); return { key, sha256: sha256(body), bytes: raw.length, compressedBytes: body.length };
  }).sort((a, b) => a.key.localeCompare(b.key));
  return { local, manifest, refs };
}
import { gunzipSync as requireGzip } from "node:zlib";
const batch = async (local: MemoryStore, refs: ArtifactRef[]) => Promise.all(refs.map(async ref => ({ key: ref.key, bodyBase64: Buffer.from((await local.get(ref.key))!).toString("base64"), ref })));
async function begin(remote: MemoryStore, data: Awaited<ReturnType<typeof fixture>>, id = "1".repeat(32), clock = () => now) {
  return new PublicUploadService(remote, clock).handle(owner, { action: "begin", jobId: id, manifest: data.manifest, refs: data.refs, expectedCurrent: null });
}

test("fresh public graph: bounded readback, retries, previous-state pinning and conditional publication", async () => {
  const f = await fixture(), remote = new MemoryStore();
  const request = { action: "begin", jobId: "1".repeat(32), manifest: f.manifest, refs: f.refs, expectedCurrent: null };
  const started = await begin(remote, f); const initialPuts = remote.puts.length;
  assert.equal((await new PublicUploadService(remote, () => now).handle(owner, request)).jobId, started.jobId);
  assert.equal(remote.puts.length, initialPuts, "lost begin ACK retry has no additional writes");
  // One object is already present and must be verified by GET, not re-PUT.
  remote.files.set(f.refs[0]!.key, (await f.local.get(f.refs[0]!.key))!);
  const uploaded = { action: "batch", jobId: started.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) };
  await new PublicUploadService(remote, () => now).handle(owner, uploaded);
  const after = remote.puts.length;
  await new PublicUploadService(remote, () => now).handle(owner, uploaded);
  assert.equal(remote.puts.length, after, "lost batch ACK retry is idempotent");
  assert.equal(remote.puts.filter(k => k === f.refs[0]!.key).length, 0);
  assert.equal(await remote.get(PUBLIC_EPG_CURRENT_KEY), null);
  const result = await new PublicUploadService(remote, () => now).handle(owner, { action: "commit", jobId: started.jobId });
  assert.equal(result.mode, "published");
  const pointer = JSON.parse(Buffer.from((await remote.get(PUBLIC_EPG_CURRENT_KEY))!).toString());
  assert.equal(pointer.revision, f.manifest.revision);
  assert.equal(sha256((await remote.get(pointer.manifestKey))!), pointer.manifestSha256);
  assert.deepEqual(JSON.parse(Buffer.from((await remote.get(PUBLIC_EPG_PUBLISHER_STATE_KEY))!).toString()).previousPointers, []);
  const count = remote.puts.length;
  await new PublicUploadService(remote, () => now).handle(owner, { action: "commit", jobId: started.jobId });
  assert.equal(remote.puts.length, count, "published commit ACK retry has no additional writes");
});

test("stale candidate, source gaps, private kind/keys and forged content fail closed before publication", async () => {
  const f = await fixture(); const remote = new MemoryStore();
  await assert.rejects(begin(remote, f, "2".repeat(32), () => now + UPLOAD_LIMITS.manifestAgeMs + 1), /upload_candidate_stale/);
  assert.equal(remote.puts.length, 0);
  await assert.rejects(begin(remote, { ...f, manifest: { ...f.manifest, sources: f.manifest.sources.slice(1) } }), /upload_sources_invalid/);
  const privateBody = new TextEncoder().encode('{"schemaVersion":1,"kind":"private-draft","entries":[]}');
  const temp = new MemoryStore(); const bad = await putImmutable(temp, "json", privateBody);
  assert.throws(() => proveObject(bad, temp.files.get(bad.key)!, f.manifest), /upload_public_kind_invalid/);
  const started = await begin(remote, f);
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner,
    { action: "batch", jobId: started.jobId, offset: 0, objects: [{ key: "public-epg/v1/current.json", bodyBase64: "e30=" }] }), /upload_batch_invalid/);
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner,
    { action: "batch", jobId: started.jobId, offset: 0, referenceProof: referenceRangeProof(buildReferenceTree(f.refs), 0, 1), objects: [{ key: f.refs[0]!.key, ref: f.refs[0], bodyBase64: "e30=" }] }), /upload_object_hash_invalid/);
  assert.equal(await remote.get(PUBLIC_EPG_CURRENT_KEY), null);
});

test("owner fence, concurrent batch reservation, lease loss and incomplete graph preserve current", async () => {
  const f = await fixture(), remote = new MemoryStore(); const started = await begin(remote, f);
  await assert.rejects(new PublicUploadService(remote, () => now).handle("other-user", { action: "status", jobId: started.jobId }), /upload_owner_mismatch/);
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner, { action: "commit", jobId: started.jobId }), /upload_graph_incomplete/);
  const request = { action: "batch", jobId: started.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) };
  const both = await Promise.allSettled([new PublicUploadService(remote, () => now).handle(owner, request), new PublicUploadService(remote, () => now).handle(owner, request)]);
  assert.equal(both.filter(x => x.status === "fulfilled").length, 1);
  for (const ref of f.refs) assert.equal(remote.puts.filter(k => k === ref.key).length, 1);
  const leaseKey = "public-epg/v1/publisher/lease.json";
  remote.files.set(leaseKey, jsonBytes({ schemaVersion: 1, owner: "another-publisher", expiresAt: now + 60_000 }));
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner, { action: "commit", jobId: started.jobId }), /publisher_lease_lost/);
  assert.equal(await remote.get(PUBLIC_EPG_CURRENT_KEY), null);
});

test("pointer CAS failure preserves old pointer and publisher source cache; commit can resume", async () => {
  const f = await fixture(), remote = new MemoryStore();
  const oldManifest = { ...f.manifest, revision: "d".repeat(64), generatedAt: new Date(now - 3600_000).toISOString() };
  for (const [key, value] of f.local.files) remote.files.set(key, value);
  const manifestBytes = jsonBytes(oldManifest); const key = "public-epg/v1/manifests/" + sha256(manifestBytes) + ".json";
  remote.files.set(key, manifestBytes); const old = { schemaVersion: 1, revision: oldManifest.revision, manifestKey: key, manifestSha256: sha256(manifestBytes) };
  remote.files.set(PUBLIC_EPG_CURRENT_KEY, jsonBytes(old));
  const cache = { schemaVersion: 1, metadata: { fixed: { marker: "preserve" } }, sources: { fixed: { marker: "preserve" } } };
  remote.files.set(PUBLIC_EPG_PUBLISHER_STATE_KEY, jsonBytes(cache));
  let clock = now; const service = () => new PublicUploadService(remote, () => clock);
  const started = await service().handle(owner, { action: "begin", jobId: "3".repeat(32), manifest: f.manifest, refs: f.refs, expectedCurrent: old });
  await service().handle(owner, { action: "batch", jobId: started.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) });
  remote.failPointer = true;
  await assert.rejects(service().handle(owner, { action: "commit", jobId: started.jobId }), /r2_precondition_failed/);
  assert.deepEqual(JSON.parse(Buffer.from((await remote.get(PUBLIC_EPG_CURRENT_KEY))!).toString()), old);
  const preserved = JSON.parse(Buffer.from((await remote.get(PUBLIC_EPG_PUBLISHER_STATE_KEY))!).toString());
  assert.deepEqual(preserved.metadata, cache.metadata); assert.deepEqual(preserved.sources, cache.sources); assert.deepEqual(preserved.previousPointers, [old]);
  clock += UPLOAD_LIMITS.requestLockMs + 1; remote.failPointer = false;
  assert.equal((await service().handle(owner, { action: "commit", jobId: started.jobId })).mode, "published");
});

test("missing, orphaned and wrongly linked XML references cannot be promoted", async () => {
  const f = await fixture(); const proofs = await Promise.all(f.refs.map(async r => proveObject(r, (await f.local.get(r.key))!, f.manifest)));
  assert.throws(() => validateUploadGraph(f, proofs.slice(1), now), /upload_graph_incomplete/);
  const extra = { ...proofs[0]!, ref: { ...proofs[0]!.ref, key: "public-epg/v1/objects/" + "f".repeat(64) + ".json.gz", sha256: "f".repeat(64) } };
  assert.throws(() => validateUploadGraph({ manifest: f.manifest, refs: [...f.refs, extra.ref] }, [...proofs, extra], now), /upload_graph_orphan_rejected/);
  const corrupt = structuredClone(proofs); corrupt.find(p => p.kind === "xml")!.xmlChannelID = "wrong-xml-channel";
  assert.throws(() => validateUploadGraph(f, corrupt, now), /upload_graph_xml_invalid/);
});

test("persistent pessimistic reservation stops this run before object writes; explicit next run is bounded", async () => {
  const f = await fixture(), remote = new MemoryStore(); const started = await begin(remote, f);
  const key = `public-epg/v1/publisher/uploads/${started.jobId}/job.json`;
  const job = JSON.parse(Buffer.from((await remote.get(key))!).toString()); job.reservedPuts = 4799; remote.files.set(key, jsonBytes(job));
  const before = remote.puts.length;
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner,
    { action: "batch", jobId: started.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) }), /upload_run_budget_exceeded/);
  assert.equal(remote.puts.length, before);
  assert.equal((await new PublicUploadService(remote, () => now).handle(owner, { action: "next-run", jobId: started.jobId })).run, 2);
  const changed = JSON.parse(Buffer.from((await remote.get(key))!).toString()); changed.run = UPLOAD_LIMITS.runs; changed.reservedPuts = 4799; remote.files.set(key, jsonBytes(changed));
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner, { action: "next-run", jobId: started.jobId }), /upload_run_transition_invalid/);
});


test("remote readback bypasses write cache and rejects acknowledged corrupted objects", async () => {
  const f = await fixture(), remote = new MemoryStore(); const started = await begin(remote, f); remote.corruptObjects = true;
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner,
    { action: "batch", jobId: started.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) }), /upload_readback_invalid/);
  assert.equal(await remote.get(PUBLIC_EPG_CURRENT_KEY), null);
  assert.equal((await new PublicUploadService(remote, () => now).handle(owner, { action: "status", jobId: started.jobId })).cursor, 0);
});

test("lost pointer ACK resumes without republishing after the in-flight fence expires", async () => {
  const f = await fixture(), remote = new MemoryStore(); let clock = now;
  const started = await begin(remote, f); const service = () => new PublicUploadService(remote, () => clock);
  await service().handle(owner, { action: "batch", jobId: started.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) });
  remote.losePointerACK = true;
  await assert.rejects(service().handle(owner, { action: "commit", jobId: started.jobId }), /synthetic_ack_lost/);
  const pointerPuts = remote.puts.filter(k => k === PUBLIC_EPG_CURRENT_KEY).length;
  clock += UPLOAD_LIMITS.requestLockMs + 1; remote.losePointerACK = false;
  assert.equal((await service().handle(owner, { action: "commit", jobId: started.jobId })).mode, "published");
  assert.equal(remote.puts.filter(k => k === PUBLIC_EPG_CURRENT_KEY).length, pointerPuts);
});


test("XML private extensions and invalid programmes are rejected instead of ignored by the source parser", async () => {
  const f = await fixture(), temporary = new MemoryStore();
  const raw = Buffer.from(requireGzip(f.local.files.get(f.refs.find(r => r.key.endsWith(".xml.gz"))!.key)!)).toString();
  for (const value of [raw.replace("</tv>", "<private-url>hidden</private-url></tv>"), raw.replace('<tv>', '<tv private="hidden">'), raw.replace('stop="20261004160000 +0000"', 'stop="invalid"')]) {
    const ref = await putImmutable(temporary, "xml", Buffer.from(value));
    assert.throws(() => proveObject(ref, temporary.files.get(ref.key)!, f.manifest), /upload_xml_/);
  }
});


test("begin resumes an exact orphaned plan after job creation fails", async () => {
  const f = await fixture(), remote = new MemoryStore(); remote.failJobOnce = true;
  await assert.rejects(begin(remote, f), /synthetic_job_write_failed/);
  assert.equal((await begin(remote, f)).cursor, 0);
  assert.equal(remote.puts.filter(k => k.endsWith("/plan.json")).length, 1);
});


test("lost lease/job creation ACKs reconcile the exact owner and preserve a resumable job", async () => {
  const f = await fixture();
  for (const failure of ["loseLeaseACKOnce", "loseJobACKOnce"] as const) {
    const remote = new MemoryStore(); remote[failure] = true; const started = await begin(remote, f);
    assert.equal((await new PublicUploadService(remote, () => now).handle(owner,
      { action: "batch", jobId: started.jobId, offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) })).cursor, f.refs.length);
  }
});


import * as extendedContract from "@vocaltv/public-epg-contract";
import * as extendedStreams from "../src/streams.js";
import * as extendedIndex from "../src/index-builder.js";
test("merged access contract requires the complete exact reverse projection of public streams", {
  skip: !("validPublicAccessEntry" in extendedContract && "buildPublicAccessIndex" in extendedStreams && "accessRecords" in extendedIndex)
}, async () => {
  const f = await fixture();
  const entries = [{ channelID: "Demo.xy", feedID: null,
    streams: [{ streamId: "public-fixture", providerChannelId: "Demo.xy", title: "Demo", url: "https://example.com/public.m3u8", labels: [] }] }];
  const access = (extendedStreams as any).buildPublicAccessIndex(entries).entries;
  const accessRoot = await writeRoutedDirectory(f.local, "access" as any, (extendedIndex as any).accessRecords(access));
  const manifest = { ...f.manifest, channelMetadataRevision: "e".repeat(64), accessRoot };
  const refs = [...f.local.files].map(([key, body]) => ({ key, sha256: sha256(body), bytes: requireGzip(body).length, compressedBytes: body.length }));
  const proofs = refs.map(r => proveObject(r, f.local.files.get(r.key)!, manifest));
  validateUploadGraph({ manifest, refs }, proofs, now);
  const changed = structuredClone(proofs); changed.find(p => p.accessEntries?.length)!.accessEntries![0]!.members[0]!.channelID = "Wrong.xy";
  assert.throws(() => validateUploadGraph({ manifest, refs }, changed, now), /upload_access_graph_invalid/);
});


test("bounded range witnesses bind content, order and odd tree edges; tampering and extra witnesses fail", () => {
  for (const total of [1, 2, 3, 7, 31, 32, 33, 63, 65, 127, 129, 16_000]) {
    const refs = Array.from({ length: total }, (_, n) => ({ key: "public-epg/v1/objects/" + sha256(String(n)) + ".json.gz",
      sha256: sha256(String(n)), bytes: 100, compressedBytes: 80 }));
    const tree = buildReferenceTree(refs), root = tree.at(-1)![0]!;
    for (const offset of new Set([0, 1, 31, 32, Math.max(0, total - 33), Math.max(0, total - 32), total - 1])) {
      for (const count of [1, 2, 31, 32]) {
        if (offset + count > total) continue;
        const range = refs.slice(offset, offset + count), proof = referenceRangeProof(tree, offset, count);
        verifyReferenceRange(root, total, offset, range, proof);
        assert.ok(proof.length <= 28);
        assert.throws(() => verifyReferenceRange(root, total, offset, [{ ...range[0]!, bytes: 99 }, ...range.slice(1)], proof), /upload_reference_proof_invalid/);
        assert.throws(() => verifyReferenceRange(root, total, offset, [{ ...range[0]!, sha256: "f".repeat(64) }, ...range.slice(1)], proof), /upload_reference_proof_invalid/);
        if (count > 1) assert.throws(() => verifyReferenceRange(root, total, offset, [range[1]!, range[0]!, ...range.slice(2)], proof), /upload_reference_proof_invalid/);
        if (offset + count < total) assert.throws(() => verifyReferenceRange(root, total, offset + 1, range, proof), /upload_reference_proof_invalid/);
        assert.throws(() => verifyReferenceRange(root, total, offset, range, [...proof, "f".repeat(64)]), /upload_reference_proof_invalid/);
        if (proof.length) {
          assert.throws(() => verifyReferenceRange(root, total, offset, range, proof.slice(1)), /upload_reference_proof_invalid/);
          assert.throws(() => verifyReferenceRange(root, total, offset, range, ["f".repeat(64), ...proof.slice(1)]), /upload_reference_proof_invalid/);
        }
      }
    }
  }
});

test("multiple staging batches never read the full plan; commit reads it once and fences its Merkle binding", async () => {
  const f = await fixture(), remote = new MemoryStore(), tree = buildReferenceTree(f.refs); const started = await begin(remote, f);
  const planKey = `public-epg/v1/publisher/uploads/${started.jobId}/plan.json`;
  const before = remote.gets.filter(k => k === planKey).length;
  const first = await batch(f.local, f.refs.slice(0, 2));
  const writes = remote.puts.length;
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner,
    { action: "batch", jobId: started.jobId, offset: 0, objects: first, referenceProof: ["f".repeat(64)] }), /upload_reference_proof_invalid/);
  assert.equal(remote.puts.length, writes);
  for (let offset = 0; offset < f.refs.length; offset += 2) {
    const refs = f.refs.slice(offset, offset + 2);
    await new PublicUploadService(remote, () => now).handle(owner, { action: "batch", jobId: started.jobId, offset,
      objects: await batch(f.local, refs), referenceProof: referenceRangeProof(tree, offset, refs.length) });
  }
  assert.equal(remote.gets.filter(k => k === planKey).length, before);
  const key = `public-epg/v1/publisher/uploads/${started.jobId}/job.json`;
  const job = JSON.parse(Buffer.from(remote.files.get(key)!).toString());
  remote.files.set(key, jsonBytes({ ...job, refsRoot: "f".repeat(64) }));
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner, { action: "commit", jobId: started.jobId }), /upload_plan_binding_invalid/);
  assert.equal(await remote.get(PUBLIC_EPG_CURRENT_KEY), null);
  remote.files.set(key, jsonBytes(job)); const beforeCommit = remote.gets.filter(k => k === planKey).length;
  await new PublicUploadService(remote, () => now).handle(owner, { action: "commit", jobId: started.jobId });
  assert.equal(remote.gets.filter(k => k === planKey).length, beforeCommit + 1);
});


test("a new nonce for the exact already-current reviewed graph performs no staging or writes", async () => {
  const f = await fixture(), remote = new MemoryStore(); const started = await begin(remote, f);
  await new PublicUploadService(remote, () => now).handle(owner, { action: "batch", jobId: started.jobId,
    offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) });
  const published = await new PublicUploadService(remote, () => now).handle(owner, { action: "commit", jobId: started.jobId });
  const before = remote.puts.length, reads = remote.gets.length;
  const result = await begin(remote, f, "9".repeat(32));
  assert.equal(result.alreadyPublished, true); assert.deepEqual(result.pointer, published.pointer);
  assert.equal(remote.puts.length, before); assert.equal(remote.gets.length - reads, 7);
});

test("terminal status releases the exact lease after a lost published-job ACK and never releases a successor", async () => {
  const f = await fixture(), remote = new MemoryStore(), started = await begin(remote, f);
  await new PublicUploadService(remote, () => now).handle(owner, { action: "batch", jobId: started.jobId,
    offset: 0, referenceProof: [], objects: await batch(f.local, f.refs) });
  remote.losePublishedJobACKOnce = true;
  await assert.rejects(new PublicUploadService(remote, () => now).handle(owner,
    { action: "commit", jobId: started.jobId }), /synthetic_published_ack_lost/);
  const pointer = remote.files.get(PUBLIC_EPG_CURRENT_KEY)!;
  const leaseKey = "public-epg/v1/publisher/lease.json";
  assert.ok(JSON.parse(Buffer.from(remote.files.get(leaseKey)!).toString()).expiresAt > now);
  const request = { action: "status", jobId: started.jobId };
  await assert.rejects(new PublicUploadService(remote, () => now).handle("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", request), /upload_owner_mismatch/);
  assert.ok(JSON.parse(Buffer.from(remote.files.get(leaseKey)!).toString()).expiresAt > now);
  const result = await new PublicUploadService(remote, () => now).handle(owner, request);
  assert.equal(result.mode, "published");
  assert.equal(JSON.parse(Buffer.from(remote.files.get(leaseKey)!).toString()).expiresAt, now);
  assert.deepEqual(remote.files.get(PUBLIC_EPG_CURRENT_KEY), pointer);
  const successor = jsonBytes({ schemaVersion: 1, owner: "successor", expiresAt: now + 1_800_000 });
  remote.files.set(leaseKey, successor); const writes = remote.puts.length;
  await new PublicUploadService(remote, () => now).handle(owner, request);
  assert.deepEqual(remote.files.get(leaseKey), successor); assert.equal(remote.puts.length, writes);
});
