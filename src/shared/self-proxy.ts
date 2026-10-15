// ============================================================
// SELF-PROXY API CLIENT — v10 (single call, no dedup)
// ============================================================

import type {
  StreamServer,
  SelfProxyResponse,
} from "./types";

interface FetchSelfProxyArgs {
  baseUrl: string;
  slug: string;
  englishTitle: string;
  romajiTitle: string;
  season: number;
  episode: number;
  anilistId: number;
  isMovie: boolean;
  timeoutMs: number;
}

interface SelfProxyResult {
  eng_sub: StreamServer[];
  eng_dub: StreamServer[];
  hindi: StreamServer[];
  status: "ok" | "empty" | "timeout" | "error";
}

interface AttemptArgs {
  baseUrl: string;
  slug: string;
  titleEnglish: string;
  titleRomaji: string;
  season: number;
  episode: number;
  anilistId: number;
  timeoutMs: number;
}

// ✅ Servers pushed to the END of their list (less reliable)
const LOW_PRIORITY_SERVERS = new Set(["cloudy"]);

// ============================================================
// MAIN FETCH — single call, no parallel flood
// ============================================================
export async function fetchSelfProxy(
  args: FetchSelfProxyArgs
): Promise<SelfProxyResult> {
  const {
    baseUrl,
    slug,
    englishTitle,
    romajiTitle,
    season,
    episode,
    anilistId,
    isMovie,
    timeoutMs,
  } = args;

  if (!baseUrl || typeof baseUrl !== "string") {
    return emptyResult("error");
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, "").trim();
  if (!cleanBaseUrl.startsWith("http")) return emptyResult("error");

  const finalSeason = isMovie ? 1 : Math.max(1, season || 1);
  const finalEpisode = isMovie ? 1 : Math.max(1, episode || 1);

  const rawEnglish = (englishTitle || "").trim();
  const rawRomaji = (romajiTitle || "").trim();
  const slugAsTitle = (slug || "").replace(/-/g, " ").trim();

  const safeEnglish = rawEnglish || rawRomaji || slugAsTitle;
  const safeRomaji = rawRomaji || rawEnglish || slugAsTitle;

  // ✅ SINGLE slug — self-proxy handles title fallback internally
  // Priority: English-generated → provided slug → Romaji-generated
  const primarySlug =
    generateSlug(rawEnglish) ||
    (slug || "").trim() ||
    generateSlug(rawRomaji);

  if (!primarySlug) return emptyResult("empty");

  const result = await attemptFetch({
    baseUrl: cleanBaseUrl,
    slug: primarySlug,
    titleEnglish: safeEnglish,
    titleRomaji: safeRomaji,
    season: finalSeason,
    episode: finalEpisode,
    anilistId,
    timeoutMs,
  });

  // Reorder: Cloudy last
  result.eng_sub = reorderLowPriority(result.eng_sub);
  result.eng_dub = reorderLowPriority(result.eng_dub);
  result.hindi = reorderLowPriority(result.hindi);

  return result;
}

// ============================================================
// REORDER — Low-priority servers to the end (stable)
// ============================================================
function reorderLowPriority(list: StreamServer[]): StreamServer[] {
  const normal: StreamServer[] = [];
  const low: StreamServer[] = [];

  for (const s of list) {
    const name = s.server.toLowerCase().trim();
    if (LOW_PRIORITY_SERVERS.has(name)) {
      low.push(s);
    } else {
      normal.push(s);
    }
  }

  return [...normal, ...low];
}

// ============================================================
// SINGLE ATTEMPT
// ============================================================
async function attemptFetch(args: AttemptArgs): Promise<SelfProxyResult> {
  const {
    baseUrl,
    slug,
    titleEnglish,
    titleRomaji,
    season,
    episode,
    anilistId,
    timeoutMs,
  } = args;

  const params = new URLSearchParams();
  params.set("slug", slug);
  params.set("season", String(season));
  params.set("episode", String(episode));

  if (titleEnglish) params.set("title_english", titleEnglish);
  if (titleRomaji) params.set("title_romaji", titleRomaji);
  if (anilistId > 0) params.set("anilist_id", String(anilistId));

  const url = `${baseUrl}/api/streaming?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "GojoTV/2.0",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (res.status === 400 || res.status === 404) return emptyResult("empty");
    if (!res.ok) return emptyResult("error");

    let data: SelfProxyResponse;
    try {
      data = (await res.json()) as SelfProxyResponse;
    } catch {
      return emptyResult("error");
    }

    if (!data || typeof data !== "object") return emptyResult("empty");
    if (data.success !== true) return emptyResult("empty");
    if (!data.data || typeof data.data !== "object") return emptyResult("empty");
    if (!Array.isArray(data.data.servers)) return emptyResult("empty");
    if (data.data.servers.length === 0) return emptyResult("empty");

    return mapSelfProxyServers(data.data.servers);
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));
    return emptyResult(isAbort ? "timeout" : "error");
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// SLUG GENERATION
// ============================================================
function generateSlug(title: string): string {
  if (!title || typeof title !== "string") return "";
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function emptyResult(status: SelfProxyResult["status"]): SelfProxyResult {
  return { eng_sub: [], eng_dub: [], hindi: [], status };
}

function stripProviderPrefix(name: string): string {
  if (!name || typeof name !== "string") return "";
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf(" - ");
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 3).trim();
}

// ============================================================
// MAP SERVERS — NO DEDUP, keep everything from API
// ============================================================
function mapSelfProxyServers(
  servers: NonNullable<SelfProxyResponse["data"]>["servers"]
): SelfProxyResult {
  const eng_sub: StreamServer[] = [];
  const eng_dub: StreamServer[] = [];
  const hindi: StreamServer[] = [];

  for (const s of servers) {
    if (!s || typeof s !== "object") continue;
    if (!s.embed_url || !s.server_name) continue;

    const url = s.embed_url.trim();
    if (!url) continue;

    const cleanName = stripProviderPrefix(s.server_name);
    if (!cleanName) continue;

    const mapped: StreamServer = {
      server: cleanName,
      url,
      source: "self",
    };

    // ✅ Group by type/language — NO dedup, ALL servers preserved
    if (s.type === "sub" && s.language === "english") {
      eng_sub.push(mapped);
    } else if (s.type === "dub" && s.language === "english") {
      eng_dub.push(mapped);
    } else if (s.type === "dub" && s.language === "multi-audio") {
      hindi.push(mapped);
    } else if (s.type === "sub") {
      // Fallback: sub with any other language → eng_sub
      eng_sub.push(mapped);
    } else if (s.type === "dub") {
      // Fallback: dub with any other language → hindi
      hindi.push(mapped);
    }
  }

  const total = eng_sub.length + eng_dub.length + hindi.length;
  return {
    eng_sub,
    eng_dub,
    hindi,
    status: total > 0 ? "ok" : "empty",
  };
}
