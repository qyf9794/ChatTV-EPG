import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLIC_EPG_LIMITS,
  identityKey,
  publicEpgSourcePriority,
  validPublicEpgSourceID,
  type ProgrammeDayRef,
  type ProgrammePartRef,
  type PublicChannelIdentity,
  type PublicProgrammeChannel,
  type PublicProgrammeRelation
} from "@vocaltv/public-epg-contract";
import { putImmutable, sha256, type ObjectStore } from "./encoding.js";
import { mapBounded } from "./bounded.js";
import { buildIdentityResolver, matchXMLTVChannel, type ChannelSeed } from "./identity.js";
import { boundedXMLTVBody, parseXMLTV, type FixedEpgSource, type XMLTVChannel, type XMLTVProgramme } from "./xmltv.js";

export type SourceIndexEntry = PublicProgrammeChannel;

export type GeneratedSourceIndex = {
  sourceID: string;
  sourceRevision: string;
  entries: SourceIndexEntry[];
  programmeCount: number;
  shardCount: number;
};

type ProgrammeRow = { utcDay: string; programme: XMLTVProgramme };
type DayStageGroup = {
  xmltvChannelID: string;
  utcDay: string;
  segments: string[];
  segmentBytes: number[];
  pending: Map<number, string[]>;
  totalBytes: number;
};
type ProgrammeStager = { directory: string; groups: Map<string, DayStageGroup>; pendingBytes: number };

const DAY_MS = 86_400_000;
const MAX_TEMP_PARTITION_BYTES = 4 * 1024 * 1024;
const MAX_DAY_STAGING_BYTES = 16 * 1024 * 1024;
const TEMP_BUFFER_TARGET = 48 * 1024;
const SHARD_RAW_TARGET = 768 * 1024;
const MAX_EVENT_SPAN_MS = 14 * DAY_MS;
// Two fixed-registry sources may parse together; four day groups each keeps the
// combined staged-day materialization and immutable-write fanout bounded at eight.
const MAX_DAY_GROUP_CONCURRENCY = 4;

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function xmltvTimestamp(value: number): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)} +0000`;
}

function programmeMarkup(xmltvChannelID: string, item: XMLTVProgramme): string {
  const language = item.language ? ` lang="${xmlEscape(item.language)}"` : "";
  const description = item.description ? `<desc>${xmlEscape(item.description)}</desc>` : "";
  const categories = item.categories.map((category) => `<category>${xmlEscape(category)}</category>`).join("");
  return `<programme start="${xmltvTimestamp(item.start)}" stop="${xmltvTimestamp(item.end)}" channel="${xmlEscape(xmltvChannelID)}"><title${language}>${xmlEscape(item.title)}</title>${description}${categories}</programme>`;
}

function programmeDedupKey(item: XMLTVProgramme): string {
  return item.deduplicationKey;
}

function identityDedupKey(seed: ChannelSeed): string {
  return identityKey(seed.identity);
}

function flushStageBuffers(stager: ProgrammeStager): void {
  for (const group of stager.groups.values()) {
    for (const [segmentIndex, lines] of group.pending) {
      if (lines.length) appendFileSync(group.segments[segmentIndex]!, lines.join(""));
      group.pending.set(segmentIndex, []);
    }
  }
  stager.pendingBytes = 0;
}

function addStagedProgramme(stager: ProgrammeStager, xmltvChannelID: string, utcDay: string, programme: XMLTVProgramme): number {
  const key = `${xmltvChannelID}\u001f${utcDay}`;
  const group = stager.groups.get(key) ?? {
    xmltvChannelID,
    utcDay,
    segments: [],
    segmentBytes: [],
    pending: new Map<number, string[]>(),
    totalBytes: 0
  };
  const line = `${JSON.stringify({ utcDay, programme } satisfies ProgrammeRow)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_TEMP_PARTITION_BYTES) throw new Error("programme_staging_row_exceeded");
  let segmentIndex = group.segments.length - 1;
  if (segmentIndex < 0 || group.segmentBytes[segmentIndex]! + bytes > MAX_TEMP_PARTITION_BYTES) {
    segmentIndex += 1;
    group.segments.push(join(stager.directory, `day-${sha256(key).slice(0, 24)}-${segmentIndex}.jsonl`));
    group.segmentBytes.push(0);
    group.pending.set(segmentIndex, []);
  }
  group.segmentBytes[segmentIndex] = group.segmentBytes[segmentIndex]! + bytes;
  group.totalBytes += bytes;
  if (group.totalBytes > MAX_DAY_STAGING_BYTES) throw new Error("programme_day_staging_exceeded");
  group.pending.get(segmentIndex)!.push(line);
  stager.pendingBytes += bytes;
  stager.groups.set(key, group);
  if (stager.pendingBytes >= TEMP_BUFFER_TARGET) flushStageBuffers(stager);
  return bytes;
}

function readPartition(filePath: string): ProgrammeRow[] {
  const content = readFileSync(filePath);
  if (content.byteLength > MAX_TEMP_PARTITION_BYTES) throw new Error("programme_staging_partition_exceeded");
  const output: ProgrammeRow[] = [];
  for (const line of content.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as ProgrammeRow;
      if (typeof value.utcDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.utcDay)
        || !value.programme || typeof value.programme.xmltvChannelID !== "string") throw new Error("invalid_stage_row");
      output.push(value);
    } catch { throw new Error("programme_staging_invalid"); }
  }
  return output;
}

async function writeProgrammeParts(
  store: ObjectStore,
  xmltvChannelID: string,
  displayNames: readonly string[],
  utcDay: string,
  programmes: XMLTVProgramme[],
  firstPart: number
): Promise<ProgrammePartRef[]> {
  const ordered = [...programmes].sort((left, right) => left.start - right.start || left.end - right.end || left.deduplicationKey.localeCompare(right.deduplicationKey));
  const parts: ProgrammePartRef[] = [];
  let batch: string[] = [];
  let batchBytes = 0;
  const nameElements = displayNames.map((name) => `<display-name>${xmlEscape(name)}</display-name>`).join("");
  const headerText = `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="${xmlEscape(xmltvChannelID)}">${nameElements}</channel>`;
  const header = new TextEncoder().encode(headerText).byteLength;
  const trailer = new TextEncoder().encode("</tv>").byteLength;
  const writeBatch = async (): Promise<void> => {
    if (!batch.length) return;
    if (firstPart + parts.length >= PUBLIC_EPG_LIMITS.maxIdentityXmlParts) throw new Error("source_identity_budget_exceeded");
    const raw = new TextEncoder().encode(`${headerText}${batch.join("")}</tv>`);
    const ref = await putImmutable(store, "xml", raw);
    if (ref.bytes > PUBLIC_EPG_LIMITS.maxUncompressedShardBytes || ref.compressedBytes > PUBLIC_EPG_LIMITS.maxCompressedShardBytes) throw new Error("programme_shard_budget_exceeded");
    parts.push({ ...ref, utcDay, part: firstPart + parts.length, xmlSha256: sha256(raw) });
    batch = [];
    batchBytes = 0;
  };
  for (const item of ordered) {
    const event = programmeMarkup(xmltvChannelID, item);
    const bytes = Buffer.byteLength(event);
    if (header + batchBytes + bytes + trailer > SHARD_RAW_TARGET && batch.length) await writeBatch();
    if (header + bytes + trailer > SHARD_RAW_TARGET) throw new Error("single_programme_shard_exceeded");
    batch.push(event);
    batchBytes += bytes;
  }
  await writeBatch();
  return parts;
}

/** Parse one fixed-registry source, stage only bounded programme records, and publish immutable day shards. */
export async function buildSourceIndex(
  store: ObjectStore,
  source: FixedEpgSource & { priority: number },
  sourceBody: Uint8Array,
  sourceRevision: string,
  seeds: readonly ChannelSeed[],
  onProgrammeProgress?: (programmesParsed: number) => void
): Promise<GeneratedSourceIndex> {
  if (!validPublicEpgSourceID(source.id) || source.priority !== publicEpgSourcePriority(source.id)) {
    throw new Error("source_id_unregistered");
  }
  const xml = boundedXMLTVBody(source, sourceBody);
  const staging = mkdtempSync(join(tmpdir(), "vocaltv-public-epg-"));
  const seen = new Set<string>();
  const stager: ProgrammeStager = { directory: staging, groups: new Map(), pendingBytes: 0 };
  let programmeCount = 0;
  let stagingBytes = 0;
  const resolver = buildIdentityResolver(seeds);
  let shardCount = 0;
  try {
    const channels = parseXMLTV(xml, (programme) => {
      if (programme.end - programme.start > MAX_EVENT_SPAN_MS) return;
      const dedup = programmeDedupKey(programme);
      if (seen.has(dedup)) return;
      seen.add(dedup);
      const firstDay = utcDayStart(programme.start);
      const endDay = utcDayStart(programme.end - 1);
      for (let dayStart = firstDay; dayStart <= endDay; dayStart += DAY_MS) {
        const utcDay = new Date(dayStart).toISOString().slice(0, 10);
        const bytes = addStagedProgramme(stager, programme.xmltvChannelID, utcDay, programme);
        stagingBytes += bytes;
      }
      programmeCount += 1;
      if (programmeCount % 50_000 === 0) onProgrammeProgress?.(programmeCount);
      if (programmeCount > 1_000_000) throw new Error("source_programme_count_exceeded");
      if (stagingBytes > source.maximumDecompressedBytes * 2) throw new Error("programme_staging_size_exceeded");
    });
    flushStageBuffers(stager);
    const declaredChannels = new Map<string, XMLTVChannel>();
    const optionalMatches = new Map<string, ChannelSeed>();
    const claims = new Map<string, Set<string>>();
    const programmeXMLTVIDs = [...new Set([...stager.groups.values()].map((group) => group.xmltvChannelID))].sort();
    for (const xmltvChannelID of programmeXMLTVIDs) {
      const channel = channels.get(xmltvChannelID) ?? { id: xmltvChannelID, names: [], languages: [] };
      const match = matchXMLTVChannel(channel, resolver);
      if (channels.has(xmltvChannelID)) declaredChannels.set(channel.id, channel);
      if (!match) continue;
      const key = identityDedupKey(match.seed);
      const claimSet = claims.get(key) ?? new Set<string>();
      claimSet.add(xmltvChannelID);
      claims.set(key, claimSet);
      optionalMatches.set(xmltvChannelID, match.seed);
    }
    const conflictedIdentities = new Set([...claims.entries()].filter(([, ids]) => ids.size !== 1).map(([identity]) => identity));
    const relationGroups = new Map<string, { xmltvChannelID: string; displayNames: string[]; displayNameLanguages: string[]; externalIdentity?: PublicChannelIdentity; days: Map<string, ProgrammeDayRef> }>();
    const sortedGroups = [...stager.groups.entries()].sort(([left], [right]) => left.localeCompare(right));
    const generatedDays = await mapBounded(sortedGroups, MAX_DAY_GROUP_CONCURRENCY, async ([, staged]) => {
      const declared = declaredChannels.get(staged.xmltvChannelID);
      const displayNames = declared?.names ?? [];
      const displayNameLanguages = declared?.languages ?? [];
      const seed = optionalMatches.get(staged.xmltvChannelID);
      const externalIdentity = seed && !conflictedIdentities.has(identityDedupKey(seed)) ? seed.identity : undefined;
      const programmes: XMLTVProgramme[] = [];
      for (const segment of staged.segments) {
        programmes.push(...readPartition(segment).map((row) => row.programme));
      }
      const parts = await writeProgrammeParts(store, staged.xmltvChannelID, displayNames, staged.utcDay, programmes, 0);
      if (parts.length > PUBLIC_EPG_LIMITS.maxIdentityXmlParts) throw new Error("source_identity_budget_exceeded");
      return { xmltvChannelID: staged.xmltvChannelID, displayNames, displayNameLanguages, externalIdentity, utcDay: staged.utcDay, parts, segments: staged.segments };
    });
    // Reassemble in sorted source identity/day order so artifact descriptors do
    // not depend on network completion order.
    for (const generated of generatedDays) {
      if (!generated) continue;
      const relation = relationGroups.get(generated.xmltvChannelID) ?? {
        xmltvChannelID: generated.xmltvChannelID,
        displayNames: generated.displayNames,
        displayNameLanguages: generated.displayNameLanguages,
        ...(generated.externalIdentity ? { externalIdentity: generated.externalIdentity } : {}),
        days: new Map<string, ProgrammeDayRef>()
      };
      relation.days.set(generated.utcDay, { utcDay: generated.utcDay, parts: generated.parts });
      relationGroups.set(generated.xmltvChannelID, relation);
      shardCount += generated.parts.length;
      for (const segment of generated.segments) rmSync(segment, { force: true });
    }
    const entries: SourceIndexEntry[] = [...relationGroups.values()].map((relation) => ({
      sourceID: source.id,
      sourceRevision,
      sourcePriority: source.priority,
      xmltvChannelID: relation.xmltvChannelID,
      displayNames: relation.displayNames,
      displayNameLanguages: relation.displayNameLanguages,
      ...(relation.externalIdentity ? { externalIdentity: relation.externalIdentity } : {}),
      days: [...relation.days.values()].sort((left, right) => left.utcDay.localeCompare(right.utcDay))
    }));
    for (const entry of entries) {
      const dayCount = entry.days.length;
      const partCount = entry.days.reduce((total, day) => total + day.parts.length, 0);
      if (dayCount > 32 || partCount > PUBLIC_EPG_LIMITS.maxIdentityXmlParts) throw new Error("source_identity_budget_exceeded");
    }
    return { sourceID: source.id, sourceRevision, entries, programmeCount, shardCount };
  } finally {
    for (const file of readdirSync(staging)) rmSync(join(staging, file), { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

export function combineSourceIndexes(
  seeds: readonly ChannelSeed[],
  sourceIndexes: readonly GeneratedSourceIndex[]
): Map<string, PublicProgrammeRelation[]> {
  const byIdentity = new Map<string, PublicProgrammeRelation[]>();
  for (const index of sourceIndexes) {
    for (const row of index.entries) {
      if (!row.externalIdentity) continue;
      const key = identityKey(row.externalIdentity);
      const relations = byIdentity.get(key) ?? [];
      relations.push({
        sourceID: row.sourceID,
        sourceRevision: row.sourceRevision,
        sourcePriority: row.sourcePriority,
        xmltvChannelID: row.xmltvChannelID,
        displayName: row.displayNames[0] ?? row.xmltvChannelID,
        days: row.days
      });
      byIdentity.set(key, relations);
    }
  }
  const seedKeys = new Set(seeds.map((seed) => identityKey(seed.identity)));
  for (const key of byIdentity.keys()) if (!seedKeys.has(key)) byIdentity.delete(key);
  return byIdentity;
}
