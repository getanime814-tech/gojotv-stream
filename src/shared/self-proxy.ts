// ============================================================
// SELF-PROXY API CLIENT — v7 (Cloudy last, fast)
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
  debug?: boolean;
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

// ✅ Servers that go to the END of their list (less reliable)
const LOW_PRIORITY_SERVERS = new Set(["cloudy"]);

// ============================================================
// MAIN FETCH
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

  const candidates = dedupeStrings([
    (slug || "").trim(),
    generateSlug(rawEnglish),
    generateSlug(rawRomaji),
  ]);

  if (candidates.length === 0) return emptyResult("empty");

  const aggregated: SelfProxyResult = emptyResult("empty");
  const seenKeys = new Set<string>();
  let hasTimeout = false;
  let hasError = false;
  let hasAny = false;

  for (const trySlug of candidates) {
    if (!trySlug) continue;

    const result = await attemptFetch({
      baseUrl: cleanBaseUrl,
      slug: trySlug,
      titleEnglish: safeEnglish,
      titleRomaji: safeRomaji,
      season: finalSeason,
      episode: finalEpisode,
      anilistId,
      timeoutMs,
    });

    mergeInto(aggregated, result, seenKeys);

    if (result.status === "ok") hasAny = true;
    if (result.status === "timeout") hasTimeout = true;
    if (result.status === "error") hasError = true;
  }

  if (hasAny) aggregated.status = "ok";
  else if (hasTimeout) aggregated.status = "timeout";
  else if (hasError) aggregated.status = "error";
  else aggregated.status = "empty";

  // ✅ Move cloudy (and other low-priority) servers to the end
  aggregated.eng_sub = reorderLowPriority(aggregated.eng_sub);
  aggregated.eng_dub = reorderLowPriority(aggregated.eng_dub);
  aggregated.hindi = reorderLowPriority(aggregated.hindi);

  return aggregated;
}

// ============================================================
// REORDER — Low priority servers to the end (stable)
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
// MERGE — dedup by (name + url)
// ============================================================
function mergeInto(
  target: SelfProxyResult,
  src: SelfProxyResult,
  seenKeys: Set<string>
): void {
  const add = (list: StreamServer[], dest: StreamServer[]) => {
    for (const s of list) {
      if (!s.url || !s.server) continue;
      const key = `${s.server.toLowerCase()}|${s.url}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      dest.push(s);
    }
  };
  add(src.eng_sub, target.eng_sub);
  add(src.eng_dub, target.eng_dub);
  add(src.hindi, target.hindi);
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
// HELPERS
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

function dedupeStrings(arr: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
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
// MAP SERVERS
// ============================================================
function mapSelfProxyServers(
  servers: NonNullable<SelfProxyResponse["data"]>["servers"]
): SelfProxyResult {
  const eng_sub: StreamServer[] = [];
  const eng_dub: StreamServer[] = [];
  const hindi: StreamServer[] = [];
  const seenKeys = new Set<string>();

  for (const s of servers) {
    if (!s || typeof s !== "object") continue;
    if (!s.embed_url || !s.server_name) continue;

    const url = s.embed_url.trim();
    if (!url) continue;

    const cleanName = stripProviderPrefix(s.server_name);
    if (!cleanName) continue;

    const key = `${cleanName.toLowerCase()}|${url}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const mapped: StreamServer = {
      server: cleanName,
      url,
      source: "self",
    };

    if (s.type === "sub" && s.language === "english") {
      eng_sub.push(mapped);
    } else if (s.type === "dub" && s.language === "english") {
      eng_dub.push(mapped);
    } else if (s.type === "dub" && s.language === "multi-audio") {
      hindi.push(mapped);
    } else if (s.type === "sub") {
      eng_sub.push(mapped);
    } else if (s.type === "dub") {
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
