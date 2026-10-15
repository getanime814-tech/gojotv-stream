// ============================================================
// SELF-PROXY API CLIENT — Final v4 (Production Ready)
// ============================================================
// Fixes over v3:
//   • Correct slug priority (DB slug first)
//   • No early return on error/timeout — tries all candidates
//   • Strict response validation
//   • Sanitized base URL
//   • Optional empty title params skipped
//   • Detailed debug logging (opt-in)
//   • Handles all edge cases: 400, 404, 5xx, timeout, malformed JSON
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
// MAIN FETCH (multi-slug strategy, bulletproof)
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

  // ---- Guard: Base URL ----
  if (!baseUrl || typeof baseUrl !== "string") {
    if (debug) console.warn("[SelfProxy] Missing base URL");
    return emptyResult("error");
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, "").trim();
  if (!cleanBaseUrl.startsWith("http")) {
    if (debug) console.warn("[SelfProxy] Invalid base URL:", baseUrl);
    return emptyResult("error");
  }

  // ---- Spec Rule 3 & 7: Movies must be season=1, episode=1 ----
  const finalSeason = isMovie ? 1 : Math.max(1, season || 1);
  const finalEpisode = isMovie ? 1 : Math.max(1, episode || 1);

  // ---- Spec Rule 1: Both titles sent separately ----
  // Build clean fallback chain (never send empty strings)
  const rawEnglish = (englishTitle || "").trim();
  const rawRomaji = (romajiTitle || "").trim();
  const slugAsTitle = (slug || "").replace(/-/g, " ").trim();

  const safeEnglish = rawEnglish || rawRomaji || slugAsTitle;
  const safeRomaji = rawRomaji || rawEnglish || slugAsTitle;

  // ---- Multi-slug candidates (PRIORITY ORDER FIXED) ----
  //   1. DB slug (AniList canonical) — most reliable
  //   2. English-generated slug
  //   3. Romaji-generated slug
  const candidates = dedupeStrings([
    (slug || "").trim(),
    generateSlug(rawEnglish),
    generateSlug(rawRomaji),
  ]);

  if (candidates.length === 0) {
    if (debug) console.warn("[SelfProxy] No slug candidates generated");
    return emptyResult("empty");
  }

  if (debug) {
    console.log("[SelfProxy] Candidate slugs:", candidates);
    console.log("[SelfProxy] Titles:", { english: safeEnglish, romaji: safeRomaji });
    console.log("[SelfProxy] Season/Episode:", { season: finalSeason, episode: finalEpisode });
  }

  // ---- Try each slug, keep going on failure ----
  let bestEmptyResult: SelfProxyResult = emptyResult("empty");
  let lastErrorResult: SelfProxyResult | null = null;

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
      console.log(`[SelfProxy] Result for "${trySlug}": status=${result.status}, servers=${
        result.eng_sub.length + result.eng_dub.length + result.hindi.length
      }`);
    }

    // ✅ Success — return immediately
    if (result.status === "ok") return result;

    // ⚠️ Error/timeout — remember, but KEEP TRYING other slugs
    if (result.status === "error" || result.status === "timeout") {
      if (!lastErrorResult) lastErrorResult = result;
      continue;
    }

    // ⚠️ Empty — remember first empty, try next slug
    if (result.status === "empty" && bestEmptyResult.status === "empty") {
      bestEmptyResult = result;
    }
  }

  // All candidates exhausted
  if (debug) {
    console.warn("[SelfProxy] All candidates failed. Returning best result.");
  }
  return lastErrorResult || bestEmptyResult;
}

// ============================================================
// SINGLE ATTEMPT (strict validation)
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

  // ---- Build query params (only non-empty values) ----
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

  // ---- Timeout setup ----
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

    // ---- HTTP status handling ----
    if (res.status === 400 || res.status === 404) {
      if (debug) console.log(`[SelfProxy] HTTP ${res.status} → empty`);
      return emptyResult("empty");
    }

    if (!res.ok) {
      if (debug) console.log(`[SelfProxy] HTTP ${res.status} → error`);
      return emptyResult("error");
    }

    // ---- Parse JSON safely ----
    let data: SelfProxyResponse;
    try {
      data = (await res.json()) as SelfProxyResponse;
    } catch (jsonErr) {
      if (debug) console.warn("[SelfProxy] JSON parse error:", jsonErr);
      return emptyResult("error");
    }

    // ---- Strict response validation ----
    if (!data || typeof data !== "object") {
      if (debug) console.warn("[SelfProxy] Invalid response object");
      return emptyResult("empty");
    }

    if (data.success !== true) {
      if (debug) console.log("[SelfProxy] success !== true");
      return emptyResult("empty");
    }

    if (!data.data || typeof data.data !== "object") {
      if (debug) console.log("[SelfProxy] Missing data object");
      return emptyResult("empty");
    }

    if (!Array.isArray(data.data.servers)) {
      if (debug) console.log("[SelfProxy] servers is not an array");
      return emptyResult("empty");
    }

    if (data.data.servers.length === 0) {
      if (debug) console.log("[SelfProxy] Empty servers array");
      return emptyResult("empty");
    }

    // ---- Map servers ----
    return mapSelfProxyServers(data.data.servers);
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));

    if (debug) {
      console.warn("[SelfProxy] Fetch error:", err);
    }

    return emptyResult(isAbort ? "timeout" : "error");
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// SLUG GENERATION (Spec Rules)
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
// EMPTY RESULT HELPER
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
// MAP SERVERS (grouped by type/language)
// ============================================================
function mapSelfProxyServers(
  servers: NonNullable<SelfProxyResponse["data"]>["servers"]
): SelfProxyResult {
  const eng_sub: StreamServer[] = [];
  const eng_dub: StreamServer[] = [];
  const hindi: StreamServer[] = [];

  // Dedupe by URL to avoid duplicate servers
  const seenUrls = new Set<string>();

  for (const s of servers) {
    if (!s || typeof s !== "object") continue;
    if (!s.embed_url || !s.server_name) continue;

    const url = s.embed_url.trim();
    if (!url) continue;

    // Skip duplicates
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const cleanName = stripProviderPrefix(s.server_name);
    if (!cleanName) continue;

    const mapped: StreamServer = {
      server: cleanName,
      url: url,
      source: "self",
    };

    // Group by type + language
    if (s.type === "sub" && s.language === "english") {
      eng_sub.push(mapped);
    } else if (s.type === "dub" && s.language === "english") {
      eng_dub.push(mapped);
    } else if (s.type === "dub" && s.language === "multi-audio") {
      hindi.push(mapped);
    } else if (s.type === "sub") {
      // Fallback: any sub not marked english goes to eng_sub
      eng_sub.push(mapped);
    } else if (s.type === "dub") {
      // Fallback: any dub not marked english/multi goes to hindi
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
