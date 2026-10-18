import { SaxesParser } from "saxes";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export type FixedEpgSource = {
  id: string;
  publicURL: string;
  maximumCompressedBytes: number;
  maximumDecompressedBytes: number;
};

export type XMLTVChannel = { id: string; names: string[]; languages: string[] };
export type XMLTVProgramme = {
  xmltvChannelID: string;
  start: number;
  end: number;
  title: string;
  description: string | null;
  categories: string[];
  language: string | null;
  deduplicationKey: string;
};

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, maximum);
}

function xmltvChannelID(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return "";
  return value;
}

export function parseXmltvDate(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/u.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(local);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) return null;
  if (!sign) return local;
  const offsetHour = Number(offsetHourText), offsetMinute = Number(offsetMinuteText);
  if (offsetHour > 23 || offsetMinute > 59) return null;
  const offset = (offsetHour * 60 + offsetMinute) * 60_000 * (sign === "+" ? 1 : -1);
  return local - offset;
}

export function sourceRevision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function boundedXMLTVBody(source: FixedEpgSource, body: Uint8Array): Uint8Array {
  if (body.byteLength > source.maximumCompressedBytes) throw new Error("source_compressed_size_exceeded");
  let output: Uint8Array = body;
  if (/\.gz(?:$|\?)/iu.test(source.publicURL)) {
    try {
      output = gunzipSync(body, { maxOutputLength: source.maximumDecompressedBytes + 1 });
    } catch {
      throw new Error("source_gzip_invalid_or_oversized");
    }
  }
  if (output.byteLength > source.maximumDecompressedBytes) throw new Error("source_decompressed_size_exceeded");
  return output;
}

export function parseXMLTV(bytes: Uint8Array, onProgramme: (programme: XMLTVProgramme) => void): Map<string, XMLTVChannel> {
  const channels = new Map<string, XMLTVChannel>();
  const parser = new SaxesParser({ xmlns: false });
  let currentChannel: XMLTVChannel | null = null;
  let currentProgramme: Omit<XMLTVProgramme, "deduplicationKey"> | null = null;
  let field: { name: string; language: string | null; value: string } | null = null;
  let rootSeen = false;
  let programmeCount = 0;
  let error: Error | null = null;

  parser.on("opentag", (tag) => {
    const attrs = tag.attributes as Record<string, string>;
    if (tag.name === "tv") rootSeen = true;
    if (tag.name === "channel") {
      const id = xmltvChannelID(attrs.id);
      currentChannel = id ? (channels.get(id) ?? { id, names: [], languages: [] }) : null;
    } else if (tag.name === "programme") {
      currentProgramme = {
        xmltvChannelID: xmltvChannelID(attrs.channel),
        start: parseXmltvDate(attrs.start ?? "") ?? Number.NaN,
        end: parseXmltvDate(attrs.stop ?? "") ?? Number.NaN,
        title: "",
        description: null,
        categories: [],
        language: null
      };
    } else if (currentChannel && tag.name === "display-name") {
      field = { name: tag.name, language: text(attrs.lang ?? attrs["xml:lang"], 32) || null, value: "" };
    } else if (currentProgramme && ["title", "desc", "category"].includes(tag.name)) {
      field = { name: tag.name, language: text(attrs.lang ?? attrs["xml:lang"], 32) || null, value: "" };
    }
  });

  const append = (value: string) => {
    if (!field) return;
    const maximum = field.name === "desc" ? 20_000 : field.name === "display-name" ? 256 : 512;
    if (field.value.length < maximum) field.value += value.slice(0, maximum - field.value.length);
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", (tag) => {
    if (field && tag.name === field.name) {
      const value = text(field.value, field.name === "desc" ? 20_000 : field.name === "display-name" ? 256 : 512);
      if (currentChannel && field.name === "display-name" && value) {
        if (!currentChannel.names.includes(value) && currentChannel.names.length < 32) currentChannel.names.push(value);
        if (field.language && !currentChannel.languages.includes(field.language) && currentChannel.languages.length < 32) currentChannel.languages.push(field.language);
      } else if (currentProgramme && field.name === "title" && value && !currentProgramme.title) {
        currentProgramme.title = value;
        currentProgramme.language = field.language;
      } else if (currentProgramme && field.name === "desc" && value && !currentProgramme.description) {
        currentProgramme.description = value;
      } else if (currentProgramme && field.name === "category" && value && currentProgramme.categories.length < 16 && !currentProgramme.categories.includes(value)) {
        currentProgramme.categories.push(value);
      }
      field = null;
    }
    if (tag.name === "channel" && currentChannel) {
      channels.set(currentChannel.id, currentChannel);
      currentChannel = null;
    }
    if (tag.name === "programme" && currentProgramme) {
      const item = currentProgramme;
      currentProgramme = null;
      if (!item.xmltvChannelID || !item.title || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= item.start) return;
      const key = createHash("sha256").update(JSON.stringify([
        item.xmltvChannelID, item.start, item.end, item.title, item.description,
        item.categories, item.language
      ])).digest("hex");
      onProgramme({ ...item, deduplicationKey: key });
      programmeCount += 1;
    }
  });
  parser.on("error", (value) => { error = value; });

  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      parser.write(decoder.decode(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)), { stream: true }));
      if (error) throw new Error("source_xml_invalid");
    }
    parser.write(decoder.decode());
    parser.close();
  } catch {
    throw new Error("source_xml_invalid");
  }
  if (error || !rootSeen || currentChannel || currentProgramme || programmeCount === 0) {
    throw new Error("source_xml_incomplete");
  }
  return channels;
}
