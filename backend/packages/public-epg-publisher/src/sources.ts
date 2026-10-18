import { defaultEpgSources } from "../../../services/api/src/shared/public-epg-sources.js";
import { PUBLIC_EPG_SOURCE_REGISTRY, validPublicEpgSourceRegistry } from "@vocaltv/public-epg-contract";

/** The only public XMLTV inputs this publisher can request. */
export const publicEpgSources = defaultEpgSources.filter((source) => source.enabled).map((source) => ({
  id: source.id,
  publicURL: source.publicURL,
  allowedRedirectHosts: [...source.allowedRedirectHosts],
  maximumCompressedBytes: source.maximumCompressedBytes,
  maximumDecompressedBytes: source.maximumDecompressedBytes,
  priority: source.priority
}));

export const IPTV_ORG_API = "https://iptv-org.github.io/api";

export const publicMetadataSources = [
  {
    id: "iptv-org:channels",
    publicURL: `${IPTV_ORG_API}/channels.json`,
    allowedRedirectHosts: ["iptv-org.github.io", "raw.githubusercontent.com"],
    maximumBytes: 64 * 1024 * 1024
  },
  {
    id: "iptv-org:feeds",
    publicURL: `${IPTV_ORG_API}/feeds.json`,
    allowedRedirectHosts: ["iptv-org.github.io", "raw.githubusercontent.com"],
    maximumBytes: 64 * 1024 * 1024
  },
  {
    id: "iptv-org:categories",
    publicURL: `${IPTV_ORG_API}/categories.json`,
    allowedRedirectHosts: ["iptv-org.github.io", "raw.githubusercontent.com"],
    maximumBytes: 1024 * 1024
  },
  {
    id: "iptv-org:streams",
    publicURL: `${IPTV_ORG_API}/streams.json`,
    allowedRedirectHosts: ["iptv-org.github.io", "raw.githubusercontent.com"],
    maximumBytes: 16 * 1024 * 1024
  }
] as const;

if (publicEpgSources.length !== 18
  || !validPublicEpgSourceRegistry(publicEpgSources.map(({ id, priority }) => ({ id, priority })))
  || new Set(publicEpgSources.map((source) => source.publicURL)).size !== PUBLIC_EPG_SOURCE_REGISTRY.length
  || publicEpgSources.some((source) => {
    let url: URL;
    try { url = new URL(source.publicURL); } catch { return true; }
    return url.protocol !== "https:" || !source.allowedRedirectHosts.some((host: string) => host === url.hostname.toLowerCase());
  })) throw new Error("public_epg_registry_invalid");

/** Optional display input. Its absence must not stop EPG publication. */
export const publicLogoMetadataSource = {
  id: "iptv-org:logos",
  publicURL: `${IPTV_ORG_API}/logos.json`,
  allowedRedirectHosts: ["iptv-org.github.io", "raw.githubusercontent.com"],
  maximumBytes: 32 * 1024 * 1024
} as const;
