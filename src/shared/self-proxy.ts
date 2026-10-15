import type {
  StreamServer,
  SelfProxyResponse,
} from "./types";

// ============================================================
// SELF-PROXY API CLIENT — Final v3
// Bulletproof multi-slug strategy for 99% accuracy
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
}

interface SelfProxyResult {
  eng_sub: StreamServer[];
  eng_dub: StreamServer[];
  hindi: StreamServer[];
  status: "ok" | "empty" | "timeout" | "error";
}

// ============ MAIN FETCH (multi-slug strategy) ============
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

  // Spec Rule 3 & 7: Movies must be season=1, episode=1
  const finalSeason = isMovie ? 1 : season;
  const finalEpisode = isMovie ? 1 : episode;

  // Spec Rule 1: Send both titles separately
  const safeEnglish = englishTitle?.trim() || romajiTitle?.trim() || "";
  const safeRomaji = romajiTitle?.trim() || englishTitle?.trim() || "";

  // ============================================================
  // Multi-slug candidates in PRIORITY ORDER
  // ============================================================
  // Self-proxy uses SLUG as primary key for search, so the right
  // slug format matters. We try in this order:
  //   1. English-generated slug (self-proxy's primary expectation)
  //   2. W6-provided slug (from DB)
  //   3. Romaji-generated slug (last resort)
  // ============================================================
  const candidates = dedupe([
    generateSlug(safeEnglish),
    slug?.trim(),
    generateSlug(safeRomaji),
  ]);

  let bestResult: SelfProxyResult = {
    eng_sub: [],
    eng_dub: [],
    hindi: [],
    status: "empty",
  };

  for (const trySlug of candidates) {
    if (!trySlug) continue;

    const result = await attemptFetch({
      baseUrl,
      slug: trySlug,
      titleEnglish: safeEnglish,
      titleRomaji: safeRomaji,
      season: finalSeason,
      episode: finalEpisode,
      anilistId,
      timeoutMs,
    });

    // ✅ Got servers — return immediately (best case)
    if (result.status === "ok") return result;

    // ✅ Network/server error — don't retry with other slugs
    // (Different slug won't fix a network error)
    if (result.status === "error" || result.status === "timeout") {
      return result;
    }

    // ⚠️ Empty result — remember it, try next slug
    if (bestResult.status === "empty") {
      bestResult = result;
    }
  }

  return bestResult;
}

// ============ SINGLE ATTEMPT ============
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

  const params = new URLSearchParams({
    slug,
    title_romaji: titleRomaji,
    title_english: titleEnglish,
    season: String(season),
    episode: String(episode),
    anilist_id: String(anilistId),
  });

  const url = `${baseUrl}/api/streaming?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "GojoTV/2.0",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        eng_sub: [],
        eng_dub: [],
        hindi: [],
        status: res.status === 404 ? "empty" : "error",
      };
    }

    const data = (await res.json()) as SelfProxyResponse;

    if (!data.success || !data.data || !data.data.servers) {
      return { eng_sub: [], eng_dub: [], hindi: [], status: "empty" };
    }

    return mapSelfProxyServers(data.data.servers);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      eng_sub: [],
      eng_dub: [],
      hindi: [],
      status: isAbort ? "timeout" : "error",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============ SLUG GENERATION (Spec Rules) ============
function generateSlug(title: string): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ============ DEDUPE ARRAY ============
function dedupe(arr: Array<string | undefined>): string[] {
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

// ============ STRIP PREFIX ============
function stripProviderPrefix(name: string): string {
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf(" - ");
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 3).trim();
}

// ============ MAP SERVERS ============
function mapSelfProxyServers(
  servers: NonNullable<SelfProxyResponse["data"]>["servers"]
): SelfProxyResult {
  const eng_sub: StreamServer[] = [];
  const eng_dub: StreamServer[] = [];
  const hindi: StreamServer[] = [];

  for (const s of servers) {
    if (!s.embed_url || !s.server_name) continue;

    const cleanName = stripProviderPrefix(s.server_name);
    if (!cleanName) continue;

    const mapped: StreamServer = {
      server: cleanName,
      url: s.embed_url,
      source: "self",
    };

    if (s.type === "sub" && s.language === "english") {
      eng_sub.push(mapped);
    } else if (s.type === "dub" && s.language === "english") {
      eng_dub.push(mapped);
    } else if (s.type === "dub" && s.language === "multi-audio") {
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
