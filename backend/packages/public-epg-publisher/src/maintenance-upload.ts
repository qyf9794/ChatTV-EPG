import { publicLogoMetadataSource } from "./sources.js";
/** Low-frequency, server-owned import of an offline public graph. No URLs/secrets are returned. */
import { randomUUID } from "node:crypto";
import { SaxesParser } from "saxes";
import * as extendedContract from "@vocaltv/public-epg-contract";
import * as extendedStreams from "./streams.js";
import {
  PUBLIC_EPG_CURRENT_KEY, PUBLIC_EPG_PUBLISHER_STATE_KEY, PUBLIC_EPG_PREFIX, PUBLIC_EPG_LIMITS,
  validArtifactRef, validCurrentPointer, validManifest, validPublicChannelCandidate,
  validPublicStreamsEntry, validMetadataSuggestionBucketEntry, identityKey, normalizePublicName,
  type PublicStreamsEntry, type ArtifactRef, type CurrentPointer, type PublicEpgManifest, type DirectoryChild, type ProgrammePartRef
} from "@vocaltv/public-epg-contract";
import { BudgetedObjectStore, PublishLease, PUBLISHER_RUN_LIMITS, loadCurrent,
  putImmutableRaw, validateMetadataNameEntries } from "./publish.js";
import { gunzip, jsonBytes, sha256, stableJSON, type RetentionObjectStore } from "./encoding.js";
import { assertStorageHeadroom } from "./storage-budget.js";
import { mapBounded } from "./bounded.js";
import { publicEpgSources, publicMetadataSources } from "./sources.js";
import { parseXMLTV } from "./xmltv.js";
import type { NameEntryRecord } from "./identity.js";

export const UPLOAD_LIMITS = {
  bodyBytes: 4 * 1024 * 1024, objects: 16_000, storedBytes: 128 * 1024 * 1024,
  decodedBytes: 256 * 1024 * 1024, batchObjects: 32, batchStoredBytes: 2 * 1024 * 1024,
  batchDecodedBytes: 16 * 1024 * 1024, manifestAgeMs: 6 * 60 * 60 * 1000,
  sourceAgeMs: 12 * 60 * 60 * 1000, sessionMs: 2 * 60 * 60 * 1000,
  requestLockMs: 6 * 60 * 1000, runs: 8, admissionPuts: 4_800,
  receiptBytes: 1024 * 1024, totalReceiptBytes: 64 * 1024 * 1024,
  maximumReceipts: 1024
} as const;
// Scheduled publication's complete v2 graph has a separate 50,000 PUT ceiling.
// Maintenance keeps its smaller graph/transport budgets, but must enumerate the
// same enlarged namespace once for storage admission; it does not run retention.
export const MAINTENANCE_RUN_LIMITS = { ...PUBLISHER_RUN_LIMITS,
  maxR2PutRequests: 5_000, maxR2GetRequests: 25_000, maxR2ListRequests: 250,
  maxR2DeleteRequests: 10, maxR2DeleteObjects: 10_000
};
const NS = PUBLIC_EPG_PREFIX + "publisher/uploads/";
const NO_STORE = { contentType: "application/json", cacheControl: "no-store" } as const;
const HEX = /^[a-f0-9]{64}$/u;
type AccessEntry = { accessDigest: string; members: Array<{ channelID: string; feedID: string | null }>; ambiguous: boolean };
type UploadManifest = PublicEpgManifest & { channelMetadataRevision?: string; accessRoot?: ArtifactRef };
function accessAdapter() {
  const valid = (extendedContract as unknown as { validPublicAccessEntry?: (value: unknown) => value is AccessEntry }).validPublicAccessEntry;
  const matches = (extendedStreams as unknown as { publicAccessGraphMatches?: (streams: PublicStreamsEntry[], rows: Array<{ hash: string; value: AccessEntry }>) => boolean }).publicAccessGraphMatches;
  check(valid && matches, "upload_access_contract_unavailable"); return { valid, matches };
}
type Link = { ref: ArtifactRef; xmlSha256?: string; xmltvChannelID?: string };
export type ObjectProof = {
  ref: ArtifactRef; rawSha256: string; kind: string; prefix?: string;
  children?: DirectoryChild[]; records?: Array<{ hash: string; id: string }>;
  links?: Link[]; xmlChannelID?: string; maxEnd?: number;
  publicStreams?: PublicStreamsEntry[]; accessEntries?: AccessEntry[];
};
type Receipt = { offset: number; requestDigest: string; proofs: ObjectProof[] };
type ReceiptRef = ArtifactRef & { offset: number; count: number; requestDigest: string };
type Plan = {
  manifest: PublicEpgManifest; refs: ArtifactRef[]; basePointer: CurrentPointer | null;
  basePointerETag: string | null; baseState: Record<string, unknown> | null; baseStateETag: string | null;
};
type Job = {
  schemaVersion: 2; manifest: PublicEpgManifest; totalObjects: number; refsRoot: string; ownerId: string; leaseOwner: string; expiresAt: number; planKey: string; planSha256: string; beginDigest: string;
  cursor: number; run: number; reservedPuts: number; receipts: ReceiptRef[];
  mode: "open" | "publishing" | "published" | "aborted";
  inFlight?: { token: string; expiresAt: number };
};
const record = (x: unknown): x is Record<string, any> => Boolean(x) && typeof x === "object" && !Array.isArray(x);
function check(ok: unknown, code = "upload_invalid"): asserts ok { if (!ok) throw new Error(code); }
function keys(value: Record<string, unknown>, allowed: string[]) {
  check(Object.keys(value).every(k => allowed.includes(k)), "upload_fields_invalid");
}
const sameRef = (a: ArtifactRef, b: ArtifactRef) => a.key === b.key && a.sha256 === b.sha256
  && a.bytes === b.bytes && a.compressedBytes === b.compressedBytes;
const roots = (m: UploadManifest): Array<[ArtifactRef, string]> => [
  [m.identityRoot, "identity"], [m.nameRoot, "name"],
  ...m.accessRoot ? [[m.accessRoot, "access"] as [ArtifactRef, string]] : [],
  ...m.streamsRoot ? [[m.streamsRoot, "streams"] as [ArtifactRef, string]] : [],
  ...m.metadataNameRoot ? [[m.metadataNameRoot, "metadata-name"] as [ArtifactRef, string]] : [],
  ...m.metadataSuggestionRoot ? [[m.metadataSuggestionRoot, "metadata-suggestion"] as [ArtifactRef, string]] : []
];

/** Server configuration must independently pin this digest after the public package review. */
export function uploadGraphDigest(manifest: unknown, refs: unknown): string {
  return sha256(stableJSON({ manifest, refs }));
}

/** Domain-separated Merkle tree pins each exact ref and its original inventory position. */
const refLeaf = (ref: ArtifactRef, index: number) => sha256("public-upload-ref-v1\0" + index + "\0" + stableJSON(ref));
const refParent = (left: string, right: string) => sha256("public-upload-node-v1\0" + left + right);
export function buildReferenceTree(refs: ArtifactRef[]): string[][] {
  check(refs.length > 0 && refs.length <= UPLOAD_LIMITS.objects, "upload_inventory_invalid");
  const tree = [refs.map(refLeaf)];
  while (tree.at(-1)!.length > 1) {
    const prior = tree.at(-1)!, next: string[] = [];
    for (let n = 0; n < prior.length; n += 2) next.push(refParent(prior[n]!, prior[n + 1] ?? prior[n]!));
    tree.push(next);
  }
  return tree;
}
export function referenceRangeProof(tree: string[][], offset: number, count: number): string[] {
  check(Number.isSafeInteger(offset) && Number.isSafeInteger(count) && offset >= 0 && count > 0
    && offset + count <= tree[0]!.length, "upload_reference_proof_invalid");
  const proof: string[] = []; let left = offset, right = offset + count;
  for (let level = 0; level < tree.length - 1; level++) {
    const row = tree[level]!;
    if (left % 2) proof.push(row[left - 1]!);
    if (right % 2 && right < row.length) proof.push(row[right]!);
    left = Math.floor(left / 2); right = Math.ceil(right / 2);
  }
  return proof;
}
export function verifyReferenceRange(root: string, total: number, offset: number, refs: ArtifactRef[], proof: unknown): void {
  check(HEX.test(root) && Number.isSafeInteger(total) && total > 0 && total <= UPLOAD_LIMITS.objects
    && Number.isSafeInteger(offset) && offset >= 0 && refs.length > 0 && refs.length <= UPLOAD_LIMITS.batchObjects
    && offset + refs.length <= total && Array.isArray(proof) && proof.length <= 28
    && proof.every(x => typeof x === "string" && HEX.test(x)), "upload_reference_proof_invalid");
  let hashes = refs.map((ref, n) => refLeaf(ref, offset + n)), left = offset, right = offset + refs.length, width = total, used = 0;
  while (width > 1) {
    if (left % 2) { check(used < proof.length, "upload_reference_proof_invalid"); hashes.unshift(proof[used++]!); }
    if (right % 2) {
      if (right < width) { check(used < proof.length, "upload_reference_proof_invalid"); hashes.push(proof[used++]!); }
      else hashes.push(hashes.at(-1)!);
    }
    check(hashes.length % 2 === 0, "upload_reference_proof_invalid"); const next: string[] = [];
    for (let n = 0; n < hashes.length; n += 2) next.push(refParent(hashes[n]!, hashes[n + 1]!));
    hashes = next; left = Math.floor(left / 2); right = Math.ceil(right / 2); width = Math.ceil(width / 2);
  }
  check(used === proof.length && hashes.length === 1 && hashes[0] === root, "upload_reference_proof_invalid");
}

export function validateUploadManifest(value: unknown, now: number): asserts value is PublicEpgManifest {
  check(record(value) && validManifest(value), "upload_manifest_invalid");
  keys(value, ["schemaVersion", "revision", "generatedAt", "previousRevision", "sources", "indexInputDigest",
    "identityRoot", "nameRoot", "streamsRoot", "metadataNameRoot", "metadataSuggestionRoot", "channelMetadataRevision", "accessRoot"]);
  const extension = value as UploadManifest;
  check(extension.channelMetadataRevision === undefined || HEX.test(extension.channelMetadataRevision), "upload_manifest_invalid");
  if (extension.accessRoot !== undefined) { check(validArtifactRef(extension.accessRoot), "upload_manifest_invalid"); accessAdapter(); }
  check(value.streamsRoot && value.metadataNameRoot && HEX.test(String(value.indexInputDigest)), "upload_manifest_incomplete");
  check(Date.parse(value.generatedAt) <= now + 60_000 && now - Date.parse(value.generatedAt) <= UPLOAD_LIMITS.manifestAgeMs,
    "upload_candidate_stale");
  const expected = new Set<string>([...publicEpgSources, ...publicMetadataSources].map(x => x.id));
  if (value.sources.some(source => source.sourceID === publicLogoMetadataSource.id)) expected.add(publicLogoMetadataSource.id);
  check(value.sources.length === expected.size, "upload_sources_invalid");
  for (const source of value.sources) {
    keys(source as unknown as Record<string, unknown>, ["sourceID", "sourceRevision", "status", "lastGoodAt"]);
    check(expected.delete(source.sourceID) && source.status === "ready" && source.sourceRevision && source.lastGoodAt,
      "upload_sources_invalid");
    check(Date.parse(source.lastGoodAt!) <= now + 60_000 && now - Date.parse(source.lastGoodAt!) <= UPLOAD_LIMITS.sourceAgeMs,
      "upload_source_stale");
  }
}

export function validateUploadRefs(value: unknown): asserts value is ArtifactRef[] {
  check(Array.isArray(value) && value.length > 0 && value.length <= UPLOAD_LIMITS.objects, "upload_inventory_invalid");
  let stored = 0, decoded = 0;
  const seen = new Set<string>();
  for (const ref of value) {
    check(record(ref) && validArtifactRef(ref), "upload_ref_invalid");
    keys(ref, ["key", "sha256", "bytes", "compressedBytes"]);
    check(ref.key === PUBLIC_EPG_PREFIX + "objects/" + ref.sha256 + (ref.key.endsWith(".xml.gz") ? ".xml.gz" : ".json.gz")
      && !seen.has(ref.key), "upload_ref_invalid");
    const xml = ref.key.endsWith(".xml.gz");
    check(ref.bytes > 0 && ref.compressedBytes > 0
      && ref.bytes <= (xml ? PUBLIC_EPG_LIMITS.maxUncompressedShardBytes : PUBLIC_EPG_LIMITS.maxRootUncompressedBytes)
      && ref.compressedBytes <= (xml ? PUBLIC_EPG_LIMITS.maxCompressedShardBytes : PUBLIC_EPG_LIMITS.maxRootUncompressedBytes),
      "upload_ref_size_invalid");
    seen.add(ref.key); stored += ref.compressedBytes; decoded += ref.bytes;
  }
  check(stored <= UPLOAD_LIMITS.storedBytes && decoded <= UPLOAD_LIMITS.decodedBytes, "upload_inventory_budget_exceeded");
}

/** Reject source/private XML extensions that the source parser intentionally ignores. */
function validatePublicXML(text: string): number {
  const parser = new SaxesParser({ xmlns: false });
  const stack: string[] = []; let channels = 0, programmes = 0, titles = 0, names = 0, fieldLength = 0;
  const attributes: Record<string, string[]> = { tv: [], channel: ["id"], "display-name": [],
    programme: ["channel", "start", "stop"], title: ["lang"], desc: [], category: [] };
  parser.on("opentag", tag => {
    const parent = stack.at(-1); const allowed = attributes[tag.name];
    check(allowed && Object.keys(tag.attributes).every(k => allowed.includes(k)), "upload_xml_fields_invalid");
    check(tag.name === "tv" ? stack.length === 0 : tag.name === "channel" || tag.name === "programme" ? parent === "tv"
      : tag.name === "display-name" ? parent === "channel" : parent === "programme", "upload_xml_structure_invalid");
    if (tag.name === "channel") { channels++; names = 0; }
    if (tag.name === "programme") { programmes++; titles = 0; }
    if (tag.name === "title") check(++titles === 1, "upload_xml_structure_invalid");
    if (tag.name === "display-name") check(++names === 1, "upload_xml_structure_invalid");
    stack.push(tag.name); fieldLength = 0;
  });
  parser.on("text", value => {
    const tag = stack.at(-1); const maximum = tag === "desc" ? 20_000 : tag === "display-name" ? 256 : 512;
    if (tag === "tv" || tag === "channel" || tag === "programme" || !tag) check(!value.trim(), "upload_xml_structure_invalid");
    else { fieldLength += value.length; check(fieldLength <= maximum, "upload_xml_fields_invalid"); }
  });
  parser.on("closetag", tag => {
    if (tag.name === "channel") check(names === 1, "upload_xml_structure_invalid");
    if (tag.name === "programme") check(titles === 1, "upload_xml_structure_invalid");
    check(stack.pop() === tag.name, "upload_xml_structure_invalid");
  });
  for (const event of ["doctype", "comment", "processinginstruction", "cdata"] as const) parser.on(event, () => { throw new Error("upload_xml_fields_invalid"); });
  parser.on("error", () => { throw new Error("upload_xml_invalid"); });
  parser.write(text).close(); check(channels === 1 && programmes > 0, "upload_xml_structure_invalid"); return programmes;
}

/** Only summaries of already server-validated public content enter operational receipts. */
export function proveObject(ref: ArtifactRef, stored: Uint8Array, manifest: PublicEpgManifest): ObjectProof {
  check(stored.byteLength === ref.compressedBytes && sha256(stored) === ref.sha256, "upload_object_hash_invalid");
  const raw = gunzip(stored, ref.bytes);
  check(raw.byteLength === ref.bytes, "upload_object_size_invalid");
  const proof: ObjectProof = { ref, rawSha256: sha256(raw), kind: "xml" };
  if (ref.key.endsWith(".xml.gz")) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    check(!/<!DOCTYPE/iu.test(text), "upload_xml_invalid");
    const count = validatePublicXML(text); const ids = new Set<string>(); let maxEnd = 0, parsed = 0;
    let channels: ReturnType<typeof parseXMLTV>;
    try { channels = parseXMLTV(raw, p => { parsed++; ids.add(p.xmltvChannelID); maxEnd = Math.max(maxEnd, p.end); }); }
    catch { throw new Error("upload_xml_invalid"); }
    check(parsed === count && channels.size === 1 && ids.size === 1 && channels.has([...ids][0]!), "upload_xml_membership_invalid");
    proof.xmlChannelID = [...ids][0]!; proof.maxEnd = maxEnd;
    return proof;
  }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  check(record(value) && value.schemaVersion === 1 && typeof value.kind === "string" && Array.isArray(value.entries),
    "upload_json_invalid");
  const match = /^(identity|name|metadata-name|metadata-suggestion|streams|access)-(root|node|bucket)$/u.exec(value.kind);
  check(match, "upload_public_kind_invalid");
  const [, family, level] = match;
  proof.kind = value.kind;
  keys(value, level === "root" ? ["schemaVersion", "kind", "entries"] : ["schemaVersion", "kind", "prefix", "entries"]);
  check(raw.byteLength <= (level === "root" ? PUBLIC_EPG_LIMITS.maxRootUncompressedBytes : PUBLIC_EPG_LIMITS.maxIndexNodeUncompressedBytes),
    "upload_json_size_invalid");
  if (level === "root") check(ref.compressedBytes <= PUBLIC_EPG_LIMITS.maxRootCompressedBytes, "upload_root_size_invalid");
  else { check(typeof value.prefix === "string" && /^[a-f0-9]{1,64}$/u.test(value.prefix), "upload_prefix_invalid"); proof.prefix = value.prefix; }
  if (level !== "bucket") {
    check(value.entries.length <= 256, "upload_directory_invalid");
    const prefixes = new Set<string>();
    proof.children = value.entries.map((child: unknown) => {
      check(record(child), "upload_directory_invalid"); keys(child, ["prefix", "ref"]);
      check(typeof child.prefix === "string" && /^[a-f0-9]{1,64}$/u.test(child.prefix) && !prefixes.has(child.prefix)
        && validArtifactRef(child.ref), "upload_directory_invalid");
      prefixes.add(child.prefix); return child as DirectoryChild;
    });
    return proof;
  }
  proof.records = []; proof.links = [];
  for (const entry of value.entries) {
    check(record(entry), "upload_entry_invalid");
    if (family === "identity") {
      keys(entry, ["provider", "channelID", "feedID", "canonicalName", "feedName", "name", "aliases", "languages",
        "broadcastAreas", "timezones", "relations", "country", "categoryIDs", "channelLanguages", "logoURL"]);
      const { relations, provider, channelID, feedID, logoURL, ...projection } = entry;
      if (logoURL !== undefined) {
        check(typeof logoURL === "string" && logoURL.length <= 4096, "upload_logo_invalid");
        const logo = new URL(logoURL);
        check(["https:", "http:"].includes(logo.protocol) && !!logo.hostname && !logo.username && !logo.password,
          "upload_logo_invalid");
      }
      check(validPublicChannelCandidate({ provider, channelID, feedID, matchKind: "exact", projection })
        && Array.isArray(relations) && relations.length <= PUBLIC_EPG_LIMITS.maxIdentityRelations, "upload_identity_invalid");
      const sourceIds = new Set<string>();
      for (const relation of relations) {
        check(record(relation), "upload_relation_invalid");
        keys(relation, ["sourceID", "sourceRevision", "sourcePriority", "xmltvChannelID", "displayName", "days"]);
        const fixed = publicEpgSources.find(s => s.id === relation.sourceID);
        check(fixed && !sourceIds.has(relation.sourceID) && relation.sourcePriority === fixed.priority
          && manifest.sources.some(s => s.sourceID === relation.sourceID && s.sourceRevision === relation.sourceRevision)
          && typeof relation.xmltvChannelID === "string" && relation.xmltvChannelID.length > 0 && relation.xmltvChannelID.length <= 256
          && typeof relation.displayName === "string" && relation.displayName.length <= 256
          && Array.isArray(relation.days) && relation.days.length <= 32, "upload_relation_invalid");
        sourceIds.add(relation.sourceID);
        const days = new Set<string>(); let parts = 0;
        for (const day of relation.days) {
          check(record(day), "upload_day_invalid"); keys(day, ["utcDay", "parts"]);
          check(typeof day.utcDay === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day.utcDay) && !days.has(day.utcDay)
            && Array.isArray(day.parts), "upload_day_invalid"); days.add(day.utcDay);
          const positions = new Set<number>();
          for (const rawPart of day.parts) {
            check(record(rawPart) && validArtifactRef(rawPart), "upload_xml_ref_invalid");
            const part = rawPart as ProgrammePartRef;
            keys(part, ["key", "sha256", "bytes", "compressedBytes", "utcDay", "part", "xmlSha256"]);
            check(part.key.endsWith(".xml.gz") && part.utcDay === day.utcDay && Number.isSafeInteger(part.part)
              && part.part >= 0 && part.part < 64 && !positions.has(part.part) && HEX.test(String(part.xmlSha256))
              && ++parts <= PUBLIC_EPG_LIMITS.maxIdentityXmlParts, "upload_xml_ref_invalid"); positions.add(part.part);
            proof.links.push({ ref: part, xmlSha256: part.xmlSha256, xmltvChannelID: relation.xmltvChannelID });
          }
        }
      }
    } else if (family === "access") {
      check((manifest as UploadManifest).accessRoot && accessAdapter().valid(entry), "upload_access_invalid");
      (proof.accessEntries ??= []).push(entry as AccessEntry);
    } else if (family === "streams") {
      keys(entry, ["channelID", "feedID", "streams"]);
      check(validPublicStreamsEntry(entry), "upload_streams_invalid");
      if ((manifest as UploadManifest).accessRoot) (proof.publicStreams ??= []).push(entry);
      for (const stream of entry.streams) keys(stream, ["streamId", "providerChannelId", "feedId", "title", "url", "referrer",
        "userAgent", "quality", "labels"]);
    } else {
      keys(entry, ["term", "candidates", "ambiguous"]);
      check(typeof entry.term === "string" && entry.term.length > 0 && entry.term.length <= 512
        && typeof entry.ambiguous === "boolean" && Array.isArray(entry.candidates), "upload_name_invalid");
      if (family === "metadata-name") validateMetadataNameEntries([entry as NameEntryRecord]);
      else if (family === "metadata-suggestion") check(validMetadataSuggestionBucketEntry(entry), "upload_suggestion_invalid");
      else check(entry.candidates.length <= PUBLIC_EPG_LIMITS.maxIndexedCandidates
        && (entry.ambiguous ? entry.candidates.length === 0 : entry.candidates.length > 0)
        && entry.candidates.every(validPublicChannelCandidate)
        && (entry.term.startsWith("gram:") || entry.term === normalizePublicName(entry.term)), "upload_name_invalid");
    }
    const id = family === "identity" || family === "streams" ? identityKey(entry as any) : family === "access" ? (entry as AccessEntry).accessDigest : (entry as Record<string, any>).term;
    proof.records.push({ hash: family === "access" ? id : sha256(id), id });
  }
  return proof;
}

export function validateUploadGraph(plan: { manifest: PublicEpgManifest; refs: ArtifactRef[] }, proofs: ObjectProof[], now: number) {
  const all = new Map<string, ObjectProof>();
  for (const proof of proofs) { check(!all.has(proof.ref.key), "upload_duplicate_proof"); all.set(proof.ref.key, proof); }
  check(all.size === plan.refs.length && plan.refs.every(ref => all.has(ref.key) && sameRef(ref, all.get(ref.key)!.ref)),
    "upload_graph_incomplete");
  const visited = new Set<string>(); let programmeMaxEnd = 0;
  const read = (ref: ArtifactRef) => {
    const proof = all.get(ref.key); check(proof && sameRef(ref, proof.ref), "upload_graph_ref_invalid");
    visited.add(ref.key); return proof;
  };
  for (const [ref, family] of roots(plan.manifest)) {
    const emitted = new Set<string>(); const expanded = new Set<string>();
    const visit = (ref: ArtifactRef, prefix: string | null, siblingPrefixes: string[], depth: number): void => {
      check(depth <= 64, "upload_graph_depth_exceeded");
      const proof = read(ref);
      // A shared paged bucket is visited once with all of its sibling routes.
      check(!expanded.has(ref.key), "upload_graph_duplicate_route"); expanded.add(ref.key);
      if (proof.kind === family + "-bucket") {
        check(prefix !== null && proof.records && proof.links, "upload_graph_bucket_invalid");
        const common = siblingPrefixes.reduce((a, b) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return a.slice(0, n); });
        check(proof.prefix === common, "upload_graph_prefix_invalid");
        for (const row of proof.records) {
          check(siblingPrefixes.some(p => row.hash.startsWith(p)) && !emitted.has(row.id), "upload_graph_route_invalid");
          emitted.add(row.id);
        }
        for (const link of proof.links) {
          const xml = read(link.ref);
          check(xml.kind === "xml" && xml.rawSha256 === link.xmlSha256 && xml.xmlChannelID === link.xmltvChannelID,
            "upload_graph_xml_invalid"); programmeMaxEnd = Math.max(programmeMaxEnd, xml.maxEnd ?? 0);
        }
        return;
      }
      check(proof.kind === family + (prefix === null ? "-root" : "-node") && proof.children
        && (prefix === null || proof.prefix === prefix), "upload_graph_directory_invalid");
      const grouped = new Map<string, DirectoryChild[]>();
      for (const child of proof.children) {
        check(prefix === null ? child.prefix.length === 1 : child.prefix.startsWith(prefix) && child.prefix.length === prefix.length + 1,
          "upload_graph_child_invalid");
        const group = grouped.get(child.ref.key) ?? []; group.push(child); grouped.set(child.ref.key, group);
      }
      for (const children of grouped.values()) visit(children[0]!.ref,
        children.length > 1 ? (prefix ?? "") : children[0]!.prefix, children.map(x => x.prefix), depth + 1);
    };
    visit(ref, null, [], 0);
  }
  if ((plan.manifest as UploadManifest).accessRoot) {
    check(accessAdapter().matches(proofs.flatMap(p => p.publicStreams ?? []), proofs.flatMap(p => (p.accessEntries ?? [])
      .map(value => ({ hash: value.accessDigest, value })))), "upload_access_graph_invalid");
  }
  check(visited.size === all.size, "upload_graph_orphan_rejected");
  check(programmeMaxEnd > now, "upload_programmes_expired");
}

/** Every HTTP call is also bounded by the publisher's unchanged network/PUT-attempt limits. */
export class PublicUploadService {
  readonly store: BudgetedObjectStore;
  private readonly deadline = Date.now() + 240_000;
  constructor(store: RetentionObjectStore, private clock = Date.now) {
    this.store = new BudgetedObjectStore(store, MAINTENANCE_RUN_LIMITS, undefined, 1);
  }
  private async fence(lease: PublishLease) {
    check(Date.now() < this.deadline, "upload_request_deadline");
    await lease.renew(this.store, this.clock());
  }
  private async json(key: string, maximum: number) {
    const item = await this.store.getWithETag(key, maximum); check(item, "upload_job_missing");
    return { value: JSON.parse(new TextDecoder().decode(item.value)), etag: item.etag, bytes: item.value };
  }
  private async save(key: string, value: unknown, etag: string) {
    return this.store.putConditional(key, jsonBytes(value), NO_STORE, { ifMatch: etag });
  }
  private async releaseCompleted(job: Job) {
    try { const lease = await PublishLease.resume(this.store, job.leaseOwner, this.clock()); await lease.release(this.store, this.clock()); }
    catch { /* Only the exact active owner may release; unknown outcomes retain bounded expiry. */ }
  }
  private result(id: string, job: Job) {
    return { ok: true, jobId: id, cursor: job.cursor, mode: job.mode, run: job.run,
      reservedPuts: job.reservedPuts, limits: UPLOAD_LIMITS };
  }
  async handle(ownerId: string, input: unknown): Promise<Record<string, unknown>> {
    check(record(input) && typeof input.action === "string", "upload_request_invalid");
    if (input.action === "verify-storage") {
      keys(input, ["action"]);
      // Explicit administrator acceptance only: runtime secrets stay on Vercel.
      // The random private key is retention-recognized and never a public object.
      const key = NS + randomUUID().replaceAll("-", "") + "/job.json";
      const first = jsonBytes({ probe: randomUUID(), phase: 1 }), next = jsonBytes({ probe: randomUUID(), phase: 2 });
      let created = false;
      const expectConflict = async (condition: { ifMatch: string } | { ifNoneMatch: "*" }) => {
        try { await this.store.putConditional(key, next, NO_STORE, condition); }
        catch (error) {
          if (error instanceof Error && error.message === "r2_precondition_failed") return;
          throw error;
        }
        throw new Error("upload_storage_conditions_unsafe");
      };
      try {
        const etag = await this.store.putConditional(key, first, NO_STORE, { ifNoneMatch: "*" });
        created = true;
        await expectConflict({ ifNoneMatch: "*" });
        await expectConflict({ ifMatch: '"' + "0".repeat(32) + '"' });
        const prior = await this.store.getWithETag(key, 1024);
        check(prior && prior.etag === etag && sha256(prior.value) === sha256(first), "upload_storage_conditions_unsafe");
        await this.store.putConditional(key, next, NO_STORE, { ifMatch: prior.etag });
        const current = await this.store.getWithETag(key, 1024);
        check(current && sha256(current.value) === sha256(next), "upload_storage_readback_invalid");
      } finally {
        // A rejected/unknown initial creation does not establish ownership.
        // Lost create ACKs leave only this recognized, tiny retention orphan.
        if (created) await this.store.delete([key]);
      }
      check(await this.store.getWithETag(key, 1024) === null, "upload_storage_cleanup_failed");
      return { ok: true, conditionalCreate: true, wrongETagRejected: true, conditionalUpdate: true, cleanupVerified: true,
        puts: this.store.usage.r2Puts, gets: this.store.usage.r2Gets, deletes: this.store.usage.r2DeleteRequests };
    }
    if (input.action === "status" && input.jobId === undefined) {
      keys(input, ["action"]); const current = await loadCurrent(this.store);
      return { ok: true, currentPointer: current?.pointer ?? null, generatedAt: current?.manifest.generatedAt ?? null, limits: UPLOAD_LIMITS };
    }
    if (input.action === "begin") {
      keys(input, ["action", "jobId", "manifest", "refs", "expectedCurrent"]);
      validateUploadManifest(input.manifest, this.clock()); validateUploadRefs(input.refs);
      check(input.expectedCurrent === null || validCurrentPointer(input.expectedCurrent), "upload_base_invalid");
      check(typeof input.jobId === "string" && /^[a-f0-9]{32}$/u.test(input.jobId), "upload_job_id_invalid");
      const id = input.jobId; const prefix = NS + id + "/"; const beginDigest = sha256(stableJSON(input));
      const existingJob = await this.store.get(prefix + "job.json", 1024 * 1024);
      if (existingJob) {
        const prior = JSON.parse(new TextDecoder().decode(existingJob)) as Job;
        check(prior.ownerId === ownerId && prior.beginDigest === beginDigest, "upload_retry_mismatch");
        return this.result(id, prior);
      }
      const live = await loadCurrent(this.store);
      if (live && stableJSON({ ...live.manifest, previousRevision: null }) === stableJSON({ ...input.manifest, previousRevision: null })) {
        // This exact reviewed graph is already current: no staging job or writes.
        // The caller independently checks that this pointer remains current.
        return { ok: true, jobId: id, cursor: input.refs.length, mode: "published", run: 0, reservedPuts: 0,
          alreadyPublished: true, pointer: live.pointer, limits: UPLOAD_LIMITS };
      }
      const lease = await PublishLease.acquire(this.store, this.clock());
      try {
        const current = await loadCurrent(this.store);
        check(stableJSON(current?.pointer ?? null) === stableJSON(input.expectedCurrent), "upload_base_changed");
        check(!current || Date.parse(input.manifest.generatedAt) >= Date.parse(current.manifest.generatedAt), "upload_candidate_older_than_live");
        const storedState = await this.store.getWithETag(PUBLIC_EPG_PUBLISHER_STATE_KEY, 1024 * 1024);
        const baseState: unknown = storedState ? JSON.parse(new TextDecoder().decode(storedState.value)) : null;
        check(baseState === null || record(baseState) && baseState.schemaVersion === 1 && record(baseState.metadata)
          && record(baseState.sources), "upload_publisher_state_invalid");
        await assertStorageHeadroom(this.store, input.refs.reduce((n: number, r: ArtifactRef) => n + r.compressedBytes, 0)
          + UPLOAD_LIMITS.totalReceiptBytes + UPLOAD_LIMITS.bodyBytes,
          () => this.fence(lease));
        const plan: Plan = { manifest: { ...input.manifest, previousRevision: current?.pointer.revision ?? null },
          refs: input.refs, basePointer: current?.pointer ?? null, basePointerETag: current?.pointerETag ?? null,
          baseState: baseState as Plan["baseState"], baseStateETag: storedState?.etag ?? null };
        const planBytes = jsonBytes(plan); check(planBytes.byteLength <= UPLOAD_LIMITS.bodyBytes, "upload_plan_too_large");
        const existingPlan = await this.store.get(prefix + "plan.json", UPLOAD_LIMITS.bodyBytes);
        if (existingPlan) check(sha256(existingPlan) === sha256(planBytes), "upload_retry_mismatch");
        else await this.store.putConditional(prefix + "plan.json", planBytes, NO_STORE, { ifNoneMatch: "*" });
        const job: Job = { schemaVersion: 2, manifest: plan.manifest, totalObjects: input.refs.length,
          refsRoot: buildReferenceTree(input.refs).at(-1)![0]!, ownerId, leaseOwner: lease.getOwner(), expiresAt: this.clock() + UPLOAD_LIMITS.sessionMs,
          planKey: prefix + "plan.json", planSha256: sha256(planBytes), beginDigest, cursor: 0, run: 1,
          reservedPuts: this.store.usage.r2Puts + 1, receipts: [], mode: "open" };
        await this.store.putConditional(prefix + "job.json", jsonBytes(job), NO_STORE, { ifNoneMatch: "*" });
        return this.result(id, job);
      } catch (error) {
        // Preserve a committed job's lease after a lost creation ACK.
        const committed = await this.store.getWithETag(prefix + "job.json", 1024 * 1024);
        if (committed) {
          const prior = JSON.parse(new TextDecoder().decode(committed.value)) as Job;
          if (prior.ownerId === ownerId && prior.beginDigest === beginDigest && prior.leaseOwner === lease.getOwner()) return this.result(id, prior);
        }
        await lease.release(this.store, this.clock()); throw error;
      }
    }
    check(typeof input.jobId === "string" && /^[a-f0-9]{32}$/u.test(input.jobId), "upload_job_id_invalid");
    const id = input.jobId; const prefix = NS + id + "/"; const key = prefix + "job.json";
    const loaded = await this.json(key, 1024 * 1024); const job = loaded.value as Job;
    check(job.schemaVersion === 2 && job.ownerId === ownerId, "upload_owner_mismatch");
    if (input.action === "status") {
      keys(input, ["action", "jobId"]);
      // The final job CAS may commit while its ACK is lost, before lease release.
      // The client resumes through status and skips commit for terminal jobs.
      if (job.mode === "published" || job.mode === "aborted") await this.releaseCompleted(job);
      return this.result(id, job);
    }
    if (job.mode === "aborted") {
      check(input.action === "abort", "upload_job_closed"); keys(input, ["action", "jobId"]); await this.releaseCompleted(job); return this.result(id, job);
    }
    if (job.mode === "published") {
      check(input.action === "commit", "upload_job_closed"); keys(input, ["action", "jobId"]);
      await this.releaseCompleted(job); return this.result(id, job);
    }
    check(job.expiresAt > this.clock(), "upload_job_expired");
    check(!job.inFlight || job.inFlight.expiresAt <= this.clock(), "upload_request_busy");
    const lease = await PublishLease.resume(this.store, job.leaseOwner, this.clock());
    if (input.action === "abort") {
      keys(input, ["action", "jobId"]); job.mode = "aborted";
      await this.save(key, job, loaded.etag); await lease.release(this.store, this.clock()); return this.result(id, job);
    }
    validateUploadManifest(job.manifest, this.clock());
    if (input.action === "next-run") {
      keys(input, ["action", "jobId"]); check(job.run < UPLOAD_LIMITS.runs && job.reservedPuts >= 4_000, "upload_run_transition_invalid");
      job.run++; job.reservedPuts = 3; delete job.inFlight;
      await this.save(key, job, loaded.etag); await this.fence(lease); return this.result(id, job);
    }
    if (input.action === "batch") {
      keys(input, ["action", "jobId", "offset", "objects", "referenceProof"]); check(job.mode === "open", "upload_job_closed");
      check(Number.isSafeInteger(input.offset) && input.offset >= 0 && Array.isArray(input.objects)
        && input.objects.length > 0 && input.objects.length <= UPLOAD_LIMITS.batchObjects, "upload_batch_invalid");
      const digest = sha256(stableJSON(input.objects));
      if (input.offset < job.cursor) {
        const prior = job.receipts.find(r => r.offset === input.offset);
        check(prior && prior.count === input.objects.length && prior.requestDigest === digest, "upload_retry_mismatch");
        return this.result(id, job);
      }
      check(input.offset === job.cursor && input.offset + input.objects.length <= job.totalObjects, "upload_offset_invalid");
      const refs: ArtifactRef[] = input.objects.map((item: unknown) => {
        check(record(item), "upload_batch_invalid"); keys(item, ["key", "bodyBase64", "ref"]);
        check(record(item.ref) && item.key === item.ref.key, "upload_batch_invalid"); return item.ref as ArtifactRef;
      });
      validateUploadRefs(refs); verifyReferenceRange(job.refsRoot, job.totalObjects, input.offset, refs, input.referenceProof);
      const bytes: Uint8Array[] = []; const proofs: ObjectProof[] = []; let total = 0, decoded = 0;
      for (const [n, item] of input.objects.entries()) {
        check(record(item), "upload_batch_invalid"); keys(item, ["key", "bodyBase64", "ref"]);
        const ref = refs[n]!;
        check(item.key === ref.key && typeof item.bodyBase64 === "string" && item.bodyBase64.length <= Math.ceil(ref.compressedBytes / 3) * 4,
          "upload_batch_invalid");
        const body = Buffer.from(item.bodyBase64, "base64"); check(body.toString("base64") === item.bodyBase64, "upload_base64_invalid");
        total += body.byteLength; decoded += ref.bytes;
        check(total <= UPLOAD_LIMITS.batchStoredBytes && decoded <= UPLOAD_LIMITS.batchDecodedBytes, "upload_batch_budget_exceeded");
        bytes.push(body); proofs.push(proveObject(ref, body, job.manifest));
      }
      check(job.reservedPuts + bytes.length + 8 <= UPLOAD_LIMITS.admissionPuts, "upload_run_budget_exceeded");
      check(job.receipts.length < UPLOAD_LIMITS.maximumReceipts, "upload_receipt_budget_exceeded");
      const receipt: Receipt = { offset: input.offset, requestDigest: digest, proofs }; const proofBytes = jsonBytes(receipt);
      check(proofBytes.byteLength <= UPLOAD_LIMITS.receiptBytes
        && job.receipts.reduce((n, r) => n + r.bytes, 0) + proofBytes.byteLength <= UPLOAD_LIMITS.totalReceiptBytes,
        "upload_receipt_budget_exceeded");
      // Persist a pessimistic reservation before any artifact PUT; failed/partial requests keep it.
      job.reservedPuts += bytes.length + 8; job.inFlight = { token: randomUUID(), expiresAt: this.clock() + UPLOAD_LIMITS.requestLockMs };
      let etag = await this.save(key, job, loaded.etag);
      await this.fence(lease);
      await mapBounded(bytes, 8, async (body, n) => {
        check(Date.now() < this.deadline, "upload_request_deadline");
        const ref = refs[n]!; const prior = await this.store.get(ref.key, ref.compressedBytes);
        if (prior) check(prior.byteLength === body.byteLength && sha256(prior) === ref.sha256, "upload_remote_conflict");
        else {
          // The bounded lookup above already established absence. Preserve the
          // scheduled publisher's remote reuse without repeating that GET here.
          try {
            await this.store.putConditional(ref.key, body, { contentType: ref.key.endsWith(".xml.gz") ? "application/xml; charset=utf-8" : "application/json",
              contentEncoding: "gzip", cacheControl: "public, max-age=31536000, immutable" }, { ifNoneMatch: "*" });
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "r2_precondition_failed") throw error;
            // A concurrent creator still requires the same genuine hash readback.
          }
          const remote = await this.store.getWithETag(ref.key, ref.compressedBytes);
          check(remote && remote.value.byteLength === ref.compressedBytes && sha256(remote.value) === ref.sha256, "upload_readback_invalid");
        }
      });
      const proofKey = prefix + "receipts/" + sha256(proofBytes) + ".json";
      await putImmutableRaw(this.store, proofKey, proofBytes, NO_STORE);
      job.receipts.push({ key: proofKey, sha256: sha256(proofBytes), bytes: proofBytes.byteLength,
        compressedBytes: proofBytes.byteLength, offset: input.offset, count: bytes.length, requestDigest: digest });
      check(job.receipts.reduce((n, r) => n + r.bytes, 0) <= UPLOAD_LIMITS.totalReceiptBytes, "upload_receipt_budget_exceeded");
      job.cursor += bytes.length; delete job.inFlight;
      await this.fence(lease); etag = await this.save(key, job, etag);
      return this.result(id, job);
    }
    check(input.action === "commit", "upload_action_invalid"); keys(input, ["action", "jobId"]);
    check(job.cursor === job.totalObjects, "upload_graph_incomplete");
    // The full reviewed plan is read once at commit, independently rechecking the
    // compact per-batch binding before complete graph/state/pointer validation.
    const planItem = await this.json(job.planKey, UPLOAD_LIMITS.bodyBytes);
    check(sha256(planItem.bytes) === job.planSha256, "upload_plan_hash_invalid"); const plan = planItem.value as Plan;
    check(plan.refs.length === job.totalObjects && stableJSON(plan.manifest) === stableJSON(job.manifest)
      && buildReferenceTree(plan.refs).at(-1)![0] === job.refsRoot, "upload_plan_binding_invalid");
    check(job.reservedPuts + 64 <= MAINTENANCE_RUN_LIMITS.maxR2PutRequests, "upload_run_budget_exceeded");
    job.reservedPuts += 64; job.mode = "publishing";
    job.inFlight = { token: randomUUID(), expiresAt: this.clock() + UPLOAD_LIMITS.requestLockMs };
    let etag = await this.save(key, job, loaded.etag); await this.fence(lease);
    const proofs: ObjectProof[] = [];
    for (let offset = 0; offset < job.receipts.length; offset += 32) {
      const receipts = await mapBounded(job.receipts.slice(offset, offset + 32), 8, async ref => {
        const body = await this.store.get(ref.key, ref.bytes);
        check(body && body.byteLength === ref.bytes && sha256(body) === ref.sha256, "upload_receipt_invalid");
        const value = JSON.parse(new TextDecoder().decode(body)) as Receipt;
        check(value.offset === ref.offset && value.requestDigest === ref.requestDigest && value.proofs.length === ref.count,
          "upload_receipt_invalid"); return value;
      });
      for (const receipt of receipts) proofs.push(...receipt.proofs);
      await this.fence(lease);
    }
    validateUploadGraph(plan, proofs, this.clock()); validateUploadManifest(plan.manifest, this.clock());
    const manifestBytes = jsonBytes(plan.manifest); const digest = sha256(manifestBytes);
    const pointer: CurrentPointer = { schemaVersion: 1, revision: plan.manifest.revision,
      manifestKey: PUBLIC_EPG_PREFIX + "manifests/" + digest + ".json", manifestSha256: digest };
    const current = await this.store.getWithETag(PUBLIC_EPG_CURRENT_KEY, 2048);
    const alreadyPublished = current && stableJSON(JSON.parse(new TextDecoder().decode(current.value))) === stableJSON(pointer);
    if (!alreadyPublished) {
      check((current?.etag ?? null) === plan.basePointerETag && stableJSON(current ? JSON.parse(new TextDecoder().decode(current.value)) : null)
        === stableJSON(plan.basePointer), "upload_base_changed");
      await putImmutableRaw(this.store, pointer.manifestKey, manifestBytes,
        { contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" });
      const remoteManifest = await this.store.getWithETag(pointer.manifestKey, 32 * 1024);
      check(remoteManifest && sha256(remoteManifest.value) === digest, "upload_manifest_readback_invalid");
      const nextState = { ...(plan.baseState ?? { schemaVersion: 1, metadata: {}, sources: {} }),
        previousPointers: plan.basePointer ? [plan.basePointer] : [] };
      const state = await this.store.getWithETag(PUBLIC_EPG_PUBLISHER_STATE_KEY, 1024 * 1024);
      if (!state || sha256(state.value) !== sha256(jsonBytes(nextState))) {
        check((state?.etag ?? null) === plan.baseStateETag, "upload_state_changed");
        await this.store.putConditional(PUBLIC_EPG_PUBLISHER_STATE_KEY, jsonBytes(nextState), NO_STORE,
          state ? { ifMatch: state.etag } : { ifNoneMatch: "*" });
      }
      await this.fence(lease);
      await this.store.putConditional(PUBLIC_EPG_CURRENT_KEY, jsonBytes(pointer),
        { contentType: "application/json", cacheControl: "no-cache" }, current ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
    }
    const checkPointer = await this.store.getWithETag(PUBLIC_EPG_CURRENT_KEY, 2048);
    check(checkPointer && sha256(checkPointer.value) === sha256(jsonBytes(pointer)), "upload_pointer_readback_invalid");
    job.mode = "published"; delete job.inFlight; etag = await this.save(key, job, etag);
    await lease.release(this.store, this.clock()); return { ...this.result(id, job), pointer };
  }
}
