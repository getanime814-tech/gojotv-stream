import type {
  StreamServer,
  HindiDubbedSearchResponse,
  HindiDubbedAnimeResponse,
  DesiDubSearchResponse,
  DesiDubWatchResponse,
  DesiDubInfoResponse,
} from "./types";

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

export async function fetchTatakai(
  args: FetchTatakaiArgs
): Promise<TatakaiResult> {
  const { baseUrl, episode, titles, timeoutMs, isMovie = false } = args;

  const results = await Promise.allSettled([
    fetchHindiDubbed(baseUrl, episode, titles, timeoutMs, isMovie),
    fetchDesiDub(baseUrl, episode, titles, timeoutMs, isMovie),
  ]);

  const hindi: StreamServer[] = [];
  let hasTimeout = false;
  let hasError = false;

  for (const r of results) {
    if (r.status === "fulfilled") {
      hindi.push(...r.value.servers);
      if (r.value.timedOut) hasTimeout = true;
      if (r.value.errored) hasError = true;
    } else {
      if (r.reason?.name === "AbortError") hasTimeout = true;
      else hasError = true;
    }
  }

  let status: TatakaiResult["status"] = "ok";
  if (hindi.length === 0) {
    if (hasTimeout) status = "timeout";
    else if (hasError) status = "error";
    else status = "empty";
  }

  return { hindi, status };
}

// ============================================================
// HINDI DUBBED (Tatakai animehindidubbed)
// ============================================================
async function fetchHindiDubbed(
  baseUrl: string,
  episode: number,
  titles: string[],
  timeoutMs: number,
  isMovie: boolean
): Promise<{
  servers: StreamServer[];
  timedOut: boolean;
  errored: boolean;
}> {
  const servers: StreamServer[] = [];
  let timedOut = false;
  let errored = false;

  const found = await searchWithFallback(
    baseUrl,
    titles,
    `${baseUrl}/api/v1/hindidubbed/search?title=`,
    timeoutMs
  );

  if (!found) return { servers, timedOut: false, errored: false };

  const animeUrl = `${baseUrl}/api/v1/hindidubbed/anime/${found.slug}`;
  const data = await fetchJsonWithTimeout<HindiDubbedAnimeResponse>(
    animeUrl,
    timeoutMs
  );

  if (!data.ok) {
    if (data.timedOut) timedOut = true;
    else errored = true;
    return { servers, timedOut, errored };
  }

  const serversData = data.data?.data?.servers;
  if (!serversData) return { servers, timedOut, errored };

  const mappings: Array<{ key: "filemoon" | "servabyss"; name: string }> = [
    { key: "filemoon", name: "Filemoon" },
    { key: "servabyss", name: "Servabyss" },
  ];

  for (const { key, name } of mappings) {
    const list = serversData[key];
    if (!Array.isArray(list) || list.length === 0) continue;

    // ✅ Movie OR single-entry list → take all
    // ✅ Series with multiple entries → match episode number
    const useAll = isMovie || list.length === 1;

    for (const item of list) {
      if (!item.url) continue;

      if (!useAll) {
        const num = parseEpisodeNumber(item.name);
        if (num !== episode) continue;
      }

      servers.push({
        server: name,
        url: item.url,
        source: "tatakai-hindi",
      });

      // Series: only take first matching entry
      if (!useAll) break;
    }
  }

  return { servers, timedOut, errored };
}

// ============================================================
// DESI DUB (Tatakai desidubanime)
// ============================================================
async function fetchDesiDub(
  baseUrl: string,
  episode: number,
  titles: string[],
  timeoutMs: number,
  isMovie: boolean
): Promise<{
  servers: StreamServer[];
  timedOut: boolean;
  errored: boolean;
}> {
  const servers: StreamServer[] = [];
  let timedOut = false;
  let errored = false;

  const found = await searchWithFallback(
    baseUrl,
    titles,
    `${baseUrl}/api/v1/desidubanime/search/`,
    timeoutMs,
    true
  );

  if (!found) return { servers, timedOut, errored };

  const animeId = found.slug;

  const infoUrl = `${baseUrl}/api/v1/desidubanime/anime/${animeId}`;
  const infoData = await fetchJsonWithTimeout<DesiDubInfoResponse>(
    infoUrl,
    timeoutMs
  );

  let watchSlug = `${animeId}-episode-${episode}`;
  let isMovieDetected = isMovie;

  if (infoData.ok && infoData.data?.data?.episodes) {
    const eps = infoData.data.data.episodes;
    if (eps.length === 0) isMovieDetected = true;
    const matched = eps.find((e) => e.number === episode);
    if (matched) watchSlug = matched.id;
  } else {
    if (infoData.timedOut) timedOut = true;
    else errored = true;
  }

  let watchData = await fetchJsonWithTimeout<DesiDubWatchResponse>(
    `${baseUrl}/api/v1/desidubanime/watch/${watchSlug}`,
    timeoutMs
  );

  // Movie fallback: try bare slug (no -episode-N)
  if (
    (!watchData.ok || !watchData.data?.data?.sources?.length) &&
    isMovieDetected
  ) {
    watchData = await fetchJsonWithTimeout<DesiDubWatchResponse>(
      `${baseUrl}/api/v1/desidubanime/watch/${animeId}`,
      timeoutMs
    );
  }

  if (!watchData.ok || !watchData.data?.data?.sources) {
    return { servers, timedOut, errored };
  }

  const nameMap: Record<string, string> = {
    Mirrordub: "Mirror",
    Abyssdub: "Abyss",
    VMolydub: "VMoly",
  };

  for (const src of watchData.data.data.sources) {
    const name = nameMap[src.server] ?? src.server;
    if (!src.url) continue;
    servers.push({
      server: name,
      url: src.url,
      source: "tatakai-desi",
    });
  }

  return { servers, timedOut, errored };
}

// ============================================================
// HELPERS
// ============================================================

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number
): Promise<{
  ok: boolean;
  data: T | null;
  timedOut: boolean;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

async function searchWithFallback(
  baseUrl: string,
  titles: string[],
  endpointPrefix: string,
  timeoutMs: number,
  isDesi = false
): Promise<{ slug: string; title: string } | null> {
  const cleanedTitles = Array.from(
    new Set(titles.map((t) => t?.trim()).filter((t): t is string => !!t))
  );

  for (const title of cleanedTitles) {
    const url = `${endpointPrefix}${encodeURIComponent(title)}`;

    if (isDesi) {
      const res = await fetchJsonWithTimeout<DesiDubSearchResponse>(
        url,
        timeoutMs
      );
      if (
        res.ok &&
        res.data?.data?.results &&
        res.data.data.results.length > 0
      ) {
        const best = bestTitleMatch(res.data.data.results, title);
        return { slug: best.id, title: best.title };
      }
    } else {
      const res = await fetchJsonWithTimeout<HindiDubbedSearchResponse>(
        url,
        timeoutMs
      );
      if (
        res.ok &&
        res.data?.data?.animeList &&
        res.data.data.animeList.length > 0
      ) {
        const best = bestTitleMatch(res.data.data.animeList, title);
        return { slug: best.slug, title: best.title };
      }
    }
  }

  return null;
}

function bestTitleMatch<T extends { title: string }>(
  results: T[],
  target: string
): T {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = norm(target);

  const exact = results.find((r) => norm(r.title) === t);
  if (exact) return exact;

  const starts = results.find((r) => norm(r.title).startsWith(t));
  if (starts) return starts;

  const contains = results.find((r) => norm(r.title).includes(t));
  if (contains) return contains;

  return results[0];
}

function parseEpisodeNumber(name: string): number | null {
  const m = name.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
