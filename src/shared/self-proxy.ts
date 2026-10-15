// ============================================================
// SELF-PROXY API CLIENT — v5 (Merge-All-Slugs)
// ============================================================
// Fixes over v4:
//   • NO early return on "ok" — tries ALL slugs
//   • Merges results across slugs (deduped by URL)
//   • Hindi servers never lost due to partial slug match
//   • All v4 validations retained
// ============================================================

import type {
  StreamServer,
  SelfProxyResponse,
} from "./types";

// ============================================================
// TYPES
// ============================================================
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
  debug?: boolean;
}

// ============================================================
// MAIN FETCH — Try all slugs, merge results
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
    debug = false,
  } = args;

  // ---- Base URL guard ----
  if (!baseUrl || typeof baseUrl !== "string") {
    if (debug) console.warn("[SelfProxy] Missing base URL");
    return emptyResult("error");
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, "").trim();
  if (!cleanBaseUrl.startsWith("http")) {
    if (debug) console.warn("[SelfProxy] Invalid base URL:", baseUrl);
    return emptyResult("error");
  }

  // ---- Movie: force season=1, episode=1 ----
  const finalSeason = isMovie ? 1 : Math.max(1, season || 1);
  const finalEpisode = isMovie ? 1 : Math.max(1, episode || 1);

  // ---- Title fallback chain ----
  const rawEnglish = (englishTitle || "").trim();
  const rawRomaji = (romajiTitle || "").trim();
  const slugAsTitle = (slug || "").replace(/-/g, " ").trim();

  const safeEnglish = rawEnglish || rawRomaji || slugAsTitle;
  const safeRomaji = rawRomaji || rawEnglish || slugAsTitle;

  // ---- Slug candidates: ALL tried, results merged ----
  // Priority order only affects which one is tried FIRST
  // (result ordering in merged output follows candidate order)
  const candidates = dedupeStrings([
    (slug || "").trim(),              // DB slug first
    generateSlug(rawEnglish),         // English slug second
    generateSlug(rawRomaji),          // Romaji slug third
  ]);

  if (candidates.length === 0) {
    if (debug) console.warn("[SelfProxy] No slug candidates");
    return emptyResult("empty");
  }

  if (debug) {
    console.log("[SelfProxy] Candidate slugs:", candidates);
    console.log("[SelfProxy] Season/Episode:", { season: finalSeason, episode: finalEpisode });
  }

  // ---- Try ALL slugs, collect results ----
  const aggregated: SelfProxyResult = emptyResult("empty");
  const seenUrls = new Set<string>();
  let hasTimeout = false;
  let hasError = false;
  let hasAny = false;

  for (let i = 0; i < candidates.length; i++) {
    const trySlug = candidates[i];
    if (!trySlug) continue;

    if (debug) {
      console.log(`[SelfProxy] Attempt ${i + 1}/${candidates.length}: slug="${trySlug}"`);
    }

    const result = await attemptFetch({
      baseUrl: cleanBaseUrl,
      slug: trySlug,
      titleEnglish: safeEnglish,
      titleRomaji: safeRomaji,
      season: finalSeason,
      episode: finalEpisode,
      anilistId,
      timeoutMs,
      debug,
    });

    if (debug) {
      const c =
        result.eng_sub.length + result.eng_dub.length + result.hindi.length;
      console.log(`[SelfProxy] Result for "${trySlug}": status=${result.status}, servers=${c}`);
    }

    // Merge into aggregated (dedupe by URL)
    mergeInto(aggregated, result, seenUrls);

    if (result.status === "ok") hasAny = true;
    if (result.status === "timeout") hasTimeout = true;
    if (result.status === "error") hasError = true;
  }

  // ---- Determine final status ----
  if (hasAny) {
    aggregated.status = "ok";
  } else if (hasTimeout) {
    aggregated.status = "timeout";
  } else if (hasError) {
    aggregated.status = "error";
  } else {
    aggregated.status = "empty";
  }

  if (debug) {
    const c = aggregated.eng_sub.length + aggregated.eng_dub.length + aggregated.hindi.length;
    console.log(`[SelfProxy] Merged total: ${c} servers, status=${aggregated.status}`);
  }

  return aggregated;
}

// ============================================================
// MERGE HELPER — dedupe by URL
// ============================================================
function mergeInto(
  target: SelfProxyResult,
  src: SelfProxyResult,
  seenUrls: Set<string>
): void {
  for (const s of src.eng_sub) {
    if (!s.url || seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);
    target.eng_sub.push(s);
  }
  for (const s of src.eng_dub) {
    if (!s.url || seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);
    target.eng_dub.push(s);
  }
  for (const s of src.hindi) {
    if (!s.url || seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);
    target.hindi.push(s);
  }
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
    debug = false,
  } = args;

  // ---- Build query params ----
  const params = new URLSearchParams();
  params.set("slug", slug);
  params.set("season", String(season));
  params.set("episode", String(episode));

  if (titleEnglish && titleEnglish.trim().length > 0) {
    params.set("title_english", titleEnglish.trim());
  }
  if (titleRomaji && titleRomaji.trim().length > 0) {
    params.set("title_romaji", titleRomaji.trim());
  }
  if (anilistId && anilistId > 0) {
    params.set("anilist_id", String(anilistId));
  }

  const url = `${baseUrl}/api/streaming?${params.toString()}`;
  if (debug) console.log("[SelfProxy] Fetching:", url);

  // ---- Timeout ----
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

    if (res.status === 400 || res.status === 404) {
      if (debug) console.log(`[SelfProxy] HTTP ${res.status} → empty`);
      return emptyResult("empty");
    }

    if (!res.ok) {
      if (debug) console.log(`[SelfProxy] HTTP ${res.status} → error`);
      return emptyResult("error");
    }

    let data: SelfProxyResponse;
    try {
      data = (await res.json()) as SelfProxyResponse;
    } catch (jsonErr) {
      if (debug) console.warn("[SelfProxy] JSON parse error:", jsonErr);
      return emptyResult("error");
    }

    // ---- Strict validation ----
    if (!data || typeof data !== "object") {
      return emptyResult("empty");
    }
    if (data.success !== true) {
      return emptyResult("empty");
    }
    if (!data.data || typeof data.data !== "object") {
      return emptyResult("empty");
    }
    if (!Array.isArray(data.data.servers)) {
      return emptyResult("empty");
    }
    if (data.data.servers.length === 0) {
      return emptyResult("empty");
    }

    return mapSelfProxyServers(data.data.servers);
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));

    if (debug) console.warn("[SelfProxy] Fetch error:", err);
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

// ============================================================
// DEDUPE STRING ARRAY
// ============================================================
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

// ============================================================
// EMPTY RESULT
// ============================================================
function emptyResult(status: SelfProxyResult["status"]): SelfProxyResult {
  return {
    eng_sub: [],
    eng_dub: [],
    hindi: [],
    status,
  };
}

// ============================================================
// STRIP PROVIDER PREFIX
// ============================================================
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
  const seenUrls = new Set<string>();

  for (const s of servers) {
    if (!s || typeof s !== "object") continue;
    if (!s.embed_url || !s.server_name) continue;

    const url = s.embed_url.trim();
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const cleanName = stripProviderPrefix(s.server_name);
    if (!cleanName) continue;

    const mapped: StreamServer = {
      server: cleanName,
      url,
      source: "self",
    };

    // Grouping by type + language
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
