import type {
  StreamServer,
  HindiDubbedSearchResponse,
  HindiDubbedAnimeResponse,
  DesiDubSearchResponse,
  DesiDubWatchResponse,
  DesiDubInfoResponse,
} from "./types";

// ============================================================
// TATAKAI CLIENT — Final Version
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
  const detail = await fetchJson<HindiDubbedAnimeResponse>(animeUrl, timeoutMs);

  if (!detail.ok) {
    result.timedOut = detail.timedOut;
    result.errored = !detail.timedOut;
    return result;
  }

  const servers = detail.data?.data?.servers;
  if (!servers) return result;

  // Filemoon + Servabyss
  for (const { key, name } of [
    { key: "filemoon", name: "Filemoon" },
    { key: "servabyss", name: "Servabyss" },
  ] as const) {
    const list = servers[key];
    if (!Array.isArray(list) || list.length === 0) continue;

    const url = pickServerUrl(list, episode, isMovie);
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
// DESI DUB (desidubanime)
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

  // Fetch info to get accurate watch slugs
  const infoUrl = `${baseUrl}/api/v1/desidubanime/anime/${animeId}`;
  const info = await fetchJson<DesiDubInfoResponse>(infoUrl, timeoutMs);

  let watchSlug = `${animeId}-episode-${episode}`;
  let movieDetected = isMovie;

  if (info.ok && info.data?.data?.episodes) {
    const eps = info.data.data.episodes;
    if (eps.length === 0) movieDetected = true;
    const matched = eps.find((e) => e.number === episode);
    if (matched?.id) watchSlug = matched.id;
  } else if (info.timedOut) {
    result.timedOut = true;
  }

  // Try watch slug
  let watch = await fetchJson<DesiDubWatchResponse>(
    `${baseUrl}/api/v1/desidubanime/watch/${watchSlug}`,
    timeoutMs
  );

  // Fallback: bare slug (movies)
  if (
    (!watch.ok || !watch.data?.data?.sources?.length) &&
    movieDetected
  ) {
    watch = await fetchJson<DesiDubWatchResponse>(
      `${baseUrl}/api/v1/desidubanime/watch/${animeId}`,
      timeoutMs
    );
  }

  if (!watch.ok) {
    if (watch.timedOut) result.timedOut = true;
    else result.errored = true;
    return result;
  }

  const sources = watch.data?.data?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return result;

  const nameMap: Record<string, string> = {
    Mirrordub: "Mirror",
    Abyssdub: "Abyss",
    VMolydub: "VMoly",
    Streamp2pdub: "Streamp2pdub",
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
// PICK SERVER URL — Movie: any, Series: episode match
// ============================================================
function pickServerUrl(
  list: Array<{ name: string; url: string }>,
  episode: number,
  isMovie: boolean
): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;

  // Movie OR single entry → take first
  if (isMovie || list.length === 1) {
    const first = list[0];
    return first?.url ?? null;
  }

  // Series → match by episode number
  for (const item of list) {
    const num = parseEpisodeNumber(item.name);
    if (num === episode && item.url) return item.url;
  }

  // Series fallback: take first (better than nothing)
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
  const queries = uniqueTitles(titles);

  for (const query of queries) {
    const url = `${baseUrl}/api/v1/hindidubbed/search?title=${encodeURIComponent(query)}`;
    const res = await fetchJson<HindiDubbedSearchResponse>(url, timeoutMs);

    if (!res.ok || !res.data?.data?.animeList?.length) continue;

    const best = bestTitleMatch(res.data.data.animeList, query);
    if (!best) continue;

    // ✅ Verify: check upstream didn't return wrong anime
    if (!titleMatches(best.title, query) && !isAnyTitleMatch(best.title, queries)) {
      continue; // Skip wrong match (e.g. "Your Name" → Tokyo Godfathers)
    }

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
  const queries = uniqueTitles(titles);

  for (const query of queries) {
    const url = `${baseUrl}/api/v1/desidubanime/search/${encodeURIComponent(query)}`;
    const res = await fetchJson<DesiDubSearchResponse>(url, timeoutMs);

    if (!res.ok || !res.data?.data?.results?.length) continue;

    const best = bestTitleMatch(res.data.data.results, query);
    if (!best) continue;

    return { slug: best.id, title: best.title };
  }

  return null;
}

// ============================================================
// HELPERS
// ============================================================

function uniqueTitles(titles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of titles) {
    if (!t || typeof t !== "string") continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
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
  target: string
): T | null {
  if (!results.length) return null;

  const t = normalize(target);

  // 1. Exact
  const exact = results.find((r) => normalize(r.title) === t);
  if (exact) return exact;

  // 2. Starts with
  const starts = results.find((r) => normalize(r.title).startsWith(t));
  if (starts) return starts;

  // 3. Contains
  const contains = results.find((r) => normalize(r.title).includes(t));
  if (contains) return contains;

  // 4. Reverse contains
  const revContains = results.find((r) => t.includes(normalize(r.title)));
  if (revContains) return revContains;

  // 5. Fallback: first
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
