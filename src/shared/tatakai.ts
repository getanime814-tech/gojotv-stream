import type {
  StreamServer,
  HindiDubbedSearchResponse,
  HindiDubbedAnimeResponse,
  DesiDubSearchResponse,
  DesiDubWatchResponse,
  DesiDubInfoResponse,
} from "./types";

// ============================================================
// TATAKAI CLIENT — Final v8
// Distinctive-token matching prevents wrong-anime matches
// ============================================================

interface FetchTatakaiArgs {
  baseUrl: string;
  episode: number;
  titles: string[];
  timeoutMs: number;
  isMovie?: boolean;
}

interface TatakaiResult {
  hindi: StreamServer[];
  status: "ok" | "empty" | "timeout" | "error";
}

interface SourceFetchResult {
  servers: StreamServer[];
  timedOut: boolean;
  errored: boolean;
}

// ============================================================
// MAIN ENTRY
// ============================================================
export async function fetchTatakai(
  args: FetchTatakaiArgs
): Promise<TatakaiResult> {
  const { baseUrl, episode, titles, timeoutMs, isMovie = false } = args;

  const [hindiRes, desiRes] = await Promise.allSettled([
    fetchHindiDubbed(baseUrl, episode, titles, timeoutMs, isMovie),
    fetchDesiDub(baseUrl, episode, titles, timeoutMs, isMovie),
  ]);

  const hindi: StreamServer[] = [];
  let hasTimeout = false;
  let hasError = false;
  let hasSuccess = false;

  for (const r of [hindiRes, desiRes]) {
    if (r.status === "fulfilled") {
      hindi.push(...r.value.servers);
      if (r.value.servers.length > 0) hasSuccess = true;
      if (r.value.timedOut) hasTimeout = true;
      if (r.value.errored) hasError = true;
    } else {
      hasError = true;
    }
  }

  let status: TatakaiResult["status"];
  if (hasSuccess) status = "ok";
  else if (hasTimeout) status = "timeout";
  else if (hasError) status = "error";
  else status = "empty";

  return { hindi, status };
}

// ============================================================
// HINDI DUBBED
// ============================================================
async function fetchHindiDubbed(
  baseUrl: string,
  episode: number,
  titles: string[],
  timeoutMs: number,
  isMovie: boolean
): Promise<SourceFetchResult> {
  const result: SourceFetchResult = {
    servers: [],
    timedOut: false,
    errored: false,
  };

  const search = await searchHindiDubbed(baseUrl, titles, timeoutMs);
  if (!search) return result;

  const animeUrl = `${baseUrl}/api/v1/hindidubbed/anime/${search.slug}`;
  const detail = await fetchJsonWithRetry<HindiDubbedAnimeResponse>(
    animeUrl,
    timeoutMs,
    1
  );

  if (!detail.ok) {
    result.timedOut = detail.timedOut;
    result.errored = !detail.timedOut;
    return result;
  }

  const servers = detail.data?.data?.servers;
  if (!servers) return result;

  for (const { key, name } of [
    { key: "filemoon", name: "Filemoon" },
    { key: "servabyss", name: "Servabyss" },
  ] as const) {
    const list = servers[key];
    if (!Array.isArray(list) || list.length === 0) continue;

    const url = pickHindiServerUrl(list, episode, isMovie);
    if (!url) continue;

    const cleanUrl = extractUrl(url);
    if (!cleanUrl) continue;

    result.servers.push({
      server: name,
      url: cleanUrl,
      source: "tatakai-hindi",
    });
  }

  return result;
}

// ============================================================
// DESI DUB (prefix-aware)
// ============================================================
async function fetchDesiDub(
  baseUrl: string,
  episode: number,
  titles: string[],
  timeoutMs: number,
  isMovie: boolean
): Promise<SourceFetchResult> {
  const result: SourceFetchResult = {
    servers: [],
    timedOut: false,
    errored: false,
  };

  const search = await searchDesiDub(baseUrl, titles, timeoutMs);
  if (!search) return result;

  const animeId = search.slug;

  const infoUrl = `${baseUrl}/api/v1/desidubanime/anime/${animeId}`;
  const info = await fetchJsonWithRetry<DesiDubInfoResponse>(
    infoUrl,
    timeoutMs,
    1
  );

  const infoEpisodes = info.ok ? info.data?.data?.episodes : undefined;

  let realPrefix = animeId;
  if (Array.isArray(infoEpisodes) && infoEpisodes.length > 0) {
    const firstId = infoEpisodes[0]?.id;
    if (firstId) {
      const m = firstId.match(/^(.+?)-episode-\d+$/);
      if (m?.[1]) realPrefix = m[1];
    }
  }

  const candidates: string[] = [];
  const addSlug = (s: string | undefined | null) => {
    if (!s || typeof s !== "string") return;
    const trimmed = s.trim();
    if (!trimmed || candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };

  const movieDetected = isMovie;

  addSlug(`${realPrefix}-episode-${episode}`);

  if (Array.isArray(infoEpisodes) && infoEpisodes.length > 0) {
    const byNumber = infoEpisodes.find((e) => e.number === episode);
    if (byNumber?.id) addSlug(byNumber.id);
  } else if (info.timedOut) {
    result.timedOut = true;
  }

  if (
    Array.isArray(infoEpisodes) &&
    episode > 0 &&
    episode <= infoEpisodes.length
  ) {
    const byIndex = infoEpisodes[episode - 1];
    if (byIndex?.id) addSlug(byIndex.id);
  }

  addSlug(`${animeId}-episode-${episode}`);
  addSlug(`${animeId}-${episode}`);

  if (movieDetected) {
    addSlug(animeId);
    addSlug(realPrefix);
  }

  let sources: Array<{ server: string; url: string }> = [];

  for (const slug of candidates) {
    const watch = await fetchJson<DesiDubWatchResponse>(
      `${baseUrl}/api/v1/desidubanime/watch/${slug}`,
      timeoutMs
    );

    if (!watch.ok) {
      if (watch.timedOut) result.timedOut = true;
      continue;
    }

    const s = watch.data?.data?.sources;
    if (Array.isArray(s) && s.length > 0) {
      sources = s;
      break;
    }
  }

  if (sources.length === 0) return result;

  const nameMap: Record<string, string> = {
    Mirrordub: "Mirror",
    Abyssdub: "Abyss",
    VMolydub: "VMoly",
    Streamp2pdub: "Streamp2pdub",
    PlayerXdub: "PlayerX",
    Rubydub: "Ruby",
  };

  for (const src of sources) {
    if (!src.url) continue;
    const cleanUrl = extractUrl(src.url);
    if (!cleanUrl) continue;

    result.servers.push({
      server: nameMap[src.server] ?? src.server,
      url: cleanUrl,
      source: "tatakai-desi",
    });
  }

  return result;
}

// ============================================================
// EXTRACT CLEAN URL
// ============================================================
function extractUrl(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();

  const iframeMatch = trimmed.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  if (iframeMatch?.[1]) {
    let url = iframeMatch[1].trim();
    if (url.startsWith("//")) url = "https:" + url;
    return url;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return "https:" + trimmed;
  }

  return null;
}

// ============================================================
// PICK HINDI SERVER URL
// ============================================================
function pickHindiServerUrl(
  list: Array<{ name: string; url: string }>,
  episode: number,
  isMovie: boolean
): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;

  if (isMovie || list.length === 1) {
    return list[0]?.url ?? null;
  }

  for (const item of list) {
    const num = parseEpisodeNumber(item.name);
    if (num === episode && item.url) return item.url;
  }

  return list[0]?.url ?? null;
}

// ============================================================
// SEARCH — animehindidubbed
// ============================================================
async function searchHindiDubbed(
  baseUrl: string,
  titles: string[],
  timeoutMs: number
): Promise<{ slug: string; title: string } | null> {
  const queries = generateTitleVariants(titles);

  for (const query of queries) {
    const url = `${baseUrl}/api/v1/hindidubbed/search?title=${encodeURIComponent(query)}`;
    const res = await fetchJson<HindiDubbedSearchResponse>(url, timeoutMs);

    if (!res.ok || !res.data?.data?.animeList?.length) continue;

    const best = bestTitleMatch(res.data.data.animeList, query, titles);
    if (!best) continue;

    return { slug: best.slug, title: best.title };
  }

  return null;
}

// ============================================================
// SEARCH — desidubanime
// ============================================================
async function searchDesiDub(
  baseUrl: string,
  titles: string[],
  timeoutMs: number
): Promise<{ slug: string; title: string } | null> {
  const queries = generateTitleVariants(titles);

  for (const query of queries) {
    const url = `${baseUrl}/api/v1/desidubanime/search/${encodeURIComponent(query)}`;
    const res = await fetchJson<DesiDubSearchResponse>(url, timeoutMs);

    if (!res.ok || !res.data?.data?.results?.length) continue;

    const best = bestTitleMatch(res.data.data.results, query, titles);
    if (!best) continue;

    return { slug: best.id, title: best.title };
  }

  return null;
}

// ============================================================
// TITLE VARIANT GENERATOR
// ============================================================
function generateTitleVariants(titles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (t: string | undefined | null) => {
    if (!t || typeof t !== "string") return;
    const trimmed = t.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  for (const t of titles) {
    if (!t) continue;

    push(t);
    push(t.replace(/\s+(season|part|cour)\s*\d+/gi, " ").trim());
    push(t.replace(/\s+\d+(?:st|nd|rd|th)\s+season/gi, " ").trim());
    push(t.replace(/\s+final\s+season/gi, " ").trim());
    push(t.replace(/[\(\[].*?[\)\]]/g, " ").trim());

    if (t.includes(":")) {
      push(t.split(":")[0]?.trim());
      push(t.split(":").pop()?.trim());
    }

    push(t.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim());

    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 3) push(words.slice(0, 3).join(" "));
    if (words.length > 2) push(words.slice(0, 2).join(" "));
  }

  return out.filter(Boolean);
}

// ============================================================
// STOPWORDS — common series words that aren't distinctive
// ============================================================
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "at",
  "demon", "slayer", "kimetsu", "yaiba", "no", "wa", "ga", "wo",
  "season", "part", "cour", "arc", "tv", "series", "movie", "film",
]);

// ============================================================
// TITLE MATCHING — distinctive tokens only
// ============================================================
function bestTitleMatch<T extends { title: string }>(
  results: T[],
  target: string,
  originalTitles: string[]
): T | null {
  if (!results.length) return null;

  const t = normalize(target);

  // 1. Exact normalized match
  const exact = results.find((r) => normalize(r.title) === t);
  if (exact) return exact;

  // 2. Token-based distinctive matching (main filter)
  return distinctiveMatch(results, target, originalTitles);
}

// ============================================================
// DISTINCTIVE MATCH — rejects partial matches (movie vs series)
// ============================================================
function distinctiveMatch<T extends { title: string }>(
  results: T[],
  target: string,
  originalTitles: string[]
): T | null {
  // Collect distinctive tokens from all original titles + target
  const queryTokens = new Set<string>();
  for (const orig of [...originalTitles, target]) {
    if (!orig) continue;
    normalize(orig)
      .split(/[\s\-_]+/)
      .filter((tk) => tk.length > 2 && !STOPWORDS.has(tk))
      .forEach((tk) => queryTokens.add(tk));
  }

  // If query has no distinctive tokens (short generic title),
  // fall back to first result (best-effort)
  if (queryTokens.size === 0) {
    return results[0];
  }

  // Score each result by distinctive token overlap
  const scored = results.map((r) => {
    const rTokens = new Set(
      normalize(r.title)
        .split(/[\s\-_]+/)
        .filter((tk) => tk.length > 2 && !STOPWORDS.has(tk))
    );

    let matched = 0;
    for (const qt of queryTokens) {
      if (rTokens.has(qt)) matched++;
    }

    return {
      result: r,
      matched,
      ratio: matched / queryTokens.size,
    };
  });

  scored.sort((a, b) => b.ratio - a.ratio);

  const best = scored[0];
  // Require at least 30% distinctive token overlap
  if (!best || best.ratio < 0.3) return null;

  return best.result;
}

// ============================================================
// HELPERS
// ============================================================
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function parseEpisodeNumber(name: string): number | null {
  if (!name) return null;
  const m = name.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; data: T | null; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) return { ok: false, data: null, timedOut: false };

    const data = (await res.json()) as T;
    return { ok: true, data, timedOut: false };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return { ok: false, data: null, timedOut: isAbort };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetry<T>(
  url: string,
  timeoutMs: number,
  retries = 1
): Promise<{ ok: boolean; data: T | null; timedOut: boolean }> {
  let lastResult: { ok: boolean; data: T | null; timedOut: boolean } = {
    ok: false,
    data: null,
    timedOut: false,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fetchJson<T>(url, timeoutMs);
    lastResult = result;

    if (result.ok && result.data) return result;
    if (!result.timedOut) return result;

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  return lastResult;
  }
