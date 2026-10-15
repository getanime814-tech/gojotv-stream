import type {
  StreamServer,
  HindiDubbedSearchResponse,
  HindiDubbedAnimeResponse,
  DesiDubSearchResponse,
  DesiDubWatchResponse,
  DesiDubInfoResponse,
} from "./types";

// ============================================================
// TATAKAI CLIENT — Final v5 (95-99% accuracy target)
//
// Priority rules:
//   1. Info endpoint number-match (most accurate)
//   2. Constructed slug {animeId}-episode-{N} (user's pattern)
//   3. Info index-match (episode-1 position)
//   4. Other constructed patterns
//   5. Info first-entry (LAST RESORT — avoids wrong episodes)
//   6. Movie bare slug (only if isMovie)
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
// HINDI DUBBED (animehindidubbed)
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

    // ✅ SAFE PRIORITY: number-match first, then single-entry/movie
    const url = pickHindiServerUrl(list, episode, isMovie);
    if (!url) continue;

    result.servers.push({
      server: name,
      url,
      source: "tatakai-hindi",
    });
  }

  return result;
}

// ============================================================
// DESI DUB (desidubanime) — SAFE PRIORITY ORDER
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

  // ============================================================
  // Step 1: Fetch info (to get actual episode IDs)
  // ============================================================
  const infoUrl = `${baseUrl}/api/v1/desidubanime/anime/${animeId}`;
  const info = await fetchJsonWithRetry<DesiDubInfoResponse>(
    infoUrl,
    timeoutMs,
    1
  );

  // Build slug candidates in SAFE PRIORITY order
  const candidates: string[] = [];
  const addSlug = (s: string | undefined | null) => {
    if (!s || typeof s !== "string") return;
    const trimmed = s.trim();
    if (!trimmed || candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };

  let movieDetected = isMovie;
  const infoEpisodes = info.ok ? info.data?.data?.episodes : undefined;

  // ✅ PRIORITY 1: Info number-match
  if (Array.isArray(infoEpisodes) && infoEpisodes.length > 0) {
    const byNumber = infoEpisodes.find((e) => e.number === episode);
    if (byNumber?.id) addSlug(byNumber.id);

    // Detect movie: single entry with "Movie"/"Full" in title
    if (
      infoEpisodes.length === 1 &&
      /movie|full/i.test(infoEpisodes[0]?.title ?? "")
    ) {
      movieDetected = true;
    }
  } else if (info.timedOut) {
    result.timedOut = true;
  }

  // ✅ PRIORITY 2: Constructed slug (user's actual pattern)
  addSlug(`${animeId}-episode-${episode}`);

  // ✅ PRIORITY 3: Info index-match (episode-1 position)
  if (
    Array.isArray(infoEpisodes) &&
    episode > 0 &&
    episode <= infoEpisodes.length
  ) {
    const byIndex = infoEpisodes[episode - 1];
    if (byIndex?.id) addSlug(byIndex.id);
  }

  // ✅ PRIORITY 4: Other constructed patterns
  addSlug(`${animeId}-${episode}`);
  addSlug(`${animeId}-ep-${episode}`);
  addSlug(`${animeId}-episode-${episode}-english`);

  // ✅ PRIORITY 5: Info first-entry (LAST RESORT — wrong episode risk)
  if (Array.isArray(infoEpisodes) && infoEpisodes.length > 0) {
    // Only add if episode count suggests single-episode content
    // OR if constructed patterns matched nothing (we'll try in order anyway)
    if (infoEpisodes.length === 1 || isMovie) {
      addSlug(infoEpisodes[0]?.id);
    }
  }

  // ✅ PRIORITY 6: Movie bare slug
  if (movieDetected) {
    addSlug(animeId);
  }

  // ============================================================
  // Step 2: Try each candidate in order
  // ============================================================
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

  // ============================================================
  // Step 3: Map to StreamServer
  // ============================================================
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
    result.servers.push({
      server: nameMap[src.server] ?? src.server,
      url: src.url,
      source: "tatakai-desi",
    });
  }

  return result;
}

// ============================================================
// PICK HINDI SERVER URL
// Movie or single-entry → first URL
// Series → match by episode number, fallback first
// ============================================================
function pickHindiServerUrl(
  list: Array<{ name: string; url: string }>,
  episode: number,
  isMovie: boolean
): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;

  // Movie OR single entry → take first
  if (isMovie || list.length === 1) {
    return list[0]?.url ?? null;
  }

  // Series → number match
  for (const item of list) {
    const num = parseEpisodeNumber(item.name);
    if (num === episode && item.url) return item.url;
  }

  // Fallback: first (better than empty)
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
// TITLE VARIANT GENERATOR (10+ per title)
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

    // Strip "Season 2", "Part 1", "Cour 2"
    push(t.replace(/\s+(season|part|cour)\s*\d+/gi, " ").trim());

    // Strip "2nd Season", "3rd Season"
    push(t.replace(/\s+\d+(?:st|nd|rd|th)\s+season/gi, " ").trim());

    // Strip "Final Season"
    push(t.replace(/\s+final\s+season/gi, " ").trim());

    // Strip parentheses/brackets
    push(t.replace(/[\(\[].*?[\)\]]/g, " ").trim());

    // Strip after colon / before colon
    if (t.includes(":")) {
      push(t.split(":")[0]?.trim());
      push(t.split(":").pop()?.trim());
    }

    // Strip symbols
    push(t.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim());

    // First 3 words
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 3) push(words.slice(0, 3).join(" "));

    // First 2 words (extra fallback)
    if (words.length > 2) push(words.slice(0, 2).join(" "));
  }

  return out.filter(Boolean);
}

// ============================================================
// HELPERS
// ============================================================
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function titleMatches(returned: string, target: string): boolean {
  const a = normalize(returned);
  const b = normalize(target);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isAnyTitleMatch(returned: string, titles: string[]): boolean {
  return titles.some((t) => titleMatches(returned, t));
}

function bestTitleMatch<T extends { title: string }>(
  results: T[],
  target: string,
  originalTitles: string[]
): T | null {
  if (!results.length) return null;

  const t = normalize(target);

  // 1. Exact match
  const exact = results.find((r) => normalize(r.title) === t);
  if (exact) return exact;

  // 2. Starts with
  const starts = results.find((r) => normalize(r.title).startsWith(t));
  if (starts) return starts;

  // 3. Contains target
  const contains = results.find((r) => normalize(r.title).includes(t));
  if (contains) return contains;

  // 4. Reverse contains (target contains result)
  const revContains = results.find((r) => t.includes(normalize(r.title)));
  if (revContains) return revContains;

  // 5. Match against ORIGINAL titles (validates wrong-anime bug)
  const validMatch = results.find((r) =>
    isAnyTitleMatch(r.title, originalTitles)
  );
  if (validMatch) return validMatch;

  // 6. Fallback: first result (still return, don't reject)
  return results[0];
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
