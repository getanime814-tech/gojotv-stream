import type {
  Env,
  StreamRequest,
  StreamResponse,
  PrefetchJob,
  SourceStatus,
} from "./types";
import { getCached, setCached } from "./redis";
import { fetchSelfProxy } from "./self-proxy";
import { fetchAnivexa } from "./anivexa";
import { mergeAllSources } from "./merge";

// ============================================================
// MAIN RESOLVER
// ============================================================
export async function resolveStreams(
  req: StreamRequest,
  env: Env,
  options: { skipCache?: boolean } = {}
): Promise<StreamResponse> {
  const ttl = parseInt(env.CACHE_TTL_SECONDS, 10);

  // 1. Cache check
  if (!options.skipCache) {
    const cached = await getCached(env, req.anilist_id, req.episode);
    if (cached) return cached;
  }

  // 2. Prepare titles
  const englishTitle = req.english_title?.trim() || req.title?.trim() || "";
  const romajiTitle = req.romaji_title?.trim() || englishTitle;

  // 3. Fire both sources in parallel
  const [selfResult, anivexaResult] = await Promise.allSettled([
    fetchSelfProxy({
      baseUrl: env.SELF_PROXY_BASE,
      slug: req.slug,
      englishTitle,
      romajiTitle,
      season: req.season,
      episode: req.episode,
      anilistId: req.anilist_id,
      isMovie: req.is_movie,
      timeoutMs: parseInt(env.SELF_PROXY_TIMEOUT_MS, 10),
    }),
    fetchAnivexa({
      baseUrl: env.ANIVEXA_BASE,
      anilistId: req.anilist_id,
      episode: req.episode,
      timeoutMs: parseInt(env.ANIVEXA_TIMEOUT_MS, 10),
    }),
  ]);

  // 4. Extract results safely
  const self =
    selfResult.status === "fulfilled"
      ? selfResult.value
      : { eng_sub: [], eng_dub: [], hindi: [], status: "error" as const };

  const anivexa =
    anivexaResult.status === "fulfilled"
      ? anivexaResult.value
      : { eng_sub: [], eng_dub: [], status: "error" as const };

  // 5. Merge
  const merged = mergeAllSources({
    self: {
      eng_sub: self.eng_sub,
      eng_dub: self.eng_dub,
      hindi: self.hindi,
    },
    anivexa: {
      eng_sub: anivexa.eng_sub,
      eng_dub: anivexa.eng_dub,
    },
  });

  // 6. Build response
  const response: StreamResponse = {
    anilist_id: req.anilist_id,
    episode: req.episode,
    eng_sub: merged.eng_sub,
    eng_dub: merged.eng_dub,
    hindi: merged.hindi,
    sources_status: {
      self_proxy: self.status as SourceStatus,
      anivexa: anivexa.status as SourceStatus,
    },
    cached: false,
    resolved_at: new Date().toISOString(),
  };

  // 7. Cache write — only if BOTH sources didn't hit timeout
  // (prevents caching partial results that will never refresh)
  const total =
    merged.eng_sub.length + merged.eng_dub.length + merged.hindi.length;

  const selfNotTimeout = self.status !== "timeout";
  const anivexaNotTimeout = anivexa.status !== "timeout";
  const hasAnySuccess = self.status === "ok" || anivexa.status === "ok";

  const shouldCache =
    total > 0 && hasAnySuccess && selfNotTimeout && anivexaNotTimeout;

  if (shouldCache) {
    await setCached(env, req.anilist_id, req.episode, response, ttl);
  }

  return response;
}

// ============================================================
// PREFETCH — schedule next episode (no delay)
// ============================================================
export async function schedulePrefetch(
  req: StreamRequest,
  env: Env
): Promise<void> {
  // Skip if last episode
  if (req.total_episodes && req.episode >= req.total_episodes) return;

  const nextJob: PrefetchJob = {
    anilist_id: req.anilist_id,
    episode: req.episode + 1,
    slug: req.slug,
    title: req.title,
    english_title: req.english_title ?? null,
    romaji_title: req.romaji_title ?? null,
    is_movie: req.is_movie,
    season: req.season,
    total_episodes: req.total_episodes ?? null,
    enqueued_at: new Date().toISOString(),
  };

  try {
    await env.PREFETCH_QUEUE.send(nextJob);
  } catch (err) {
    console.error(`[W3] Prefetch queue push failed: ${err}`);
  }
}
