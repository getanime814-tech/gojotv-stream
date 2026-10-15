// W3 Worker — Type definitions

// ============ ENV BINDINGS ============
export interface Env {
  PREFETCH_QUEUE: Queue<PrefetchJob>;
  SELF_PROXY_BASE: string;
  ANIVEXA_BASE: string;
  TATAKAI_BASE: string;
  SELF_PROXY_TIMEOUT_MS: string;
  ANIVEXA_TIMEOUT_MS: string;
  TATAKAI_TIMEOUT_MS: string;
  CACHE_TTL_SECONDS: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

// ============ W6 → W3 REQUEST ============
export interface StreamRequest {
  anilist_id: number;
  episode: number;
  slug: string;
  title: string;
  english_title?: string | null;
  romaji_title?: string | null;
  is_movie: boolean;
  season: number;
  total_episodes?: number | null;
  request_id?: string;
}

// ============ INDIVIDUAL SERVER ============
export interface StreamServer {
  server: string;         // "HD 1", "Animegg", "Filemoon"
  url: string;            // iframe embed URL
  source: string;         // "self" | "anivexa" | "tatakai-hindi" | "tatakai-desi"
}

// ============ SOURCE STATUS ============
export type SourceStatus = "ok" | "empty" | "timeout" | "error" | "skipped";

// ============ W3 RESPONSE ============
export interface StreamResponse {
  anilist_id: number;
  episode: number;
  eng_sub: StreamServer[];
  eng_dub: StreamServer[];
  hindi: StreamServer[];
  sources_status: {
    self_proxy: SourceStatus;
    anivexa: SourceStatus;
    tatakai_hindi: SourceStatus;
    tatakai_desi: SourceStatus;
  };
  cached: boolean;
  resolved_at: string;
}

// ============ W9 PREFETCH JOB ============
export interface PrefetchJob {
  anilist_id: number;
  episode: number;
  slug: string;
  title: string;
  english_title?: string | null;
  romaji_title?: string | null;
  is_movie: boolean;
  season: number;
  total_episodes?: number | null;
  enqueued_at: string;
}

// ============ SELF-PROXY API TYPES ============
export interface SelfProxyServer {
  server_name: string;
  source: string;
  type: "sub" | "dub";
  language: string;        // "english" | "multi-audio"
  embed_url: string;
  ready_to_use: boolean;
}

export interface SelfProxyResponse {
  success: boolean;
  data?: {
    anilist_id: string | null;
    slug: string;
    title_english: string;
    title_romaji: string;
    season: number;
    episode: number;
    total_servers: number;
    sub_count: number;
    dub_count: number;
    servers: SelfProxyServer[];
  };
  error?: string;
}

// ============ ANIVEXA API TYPES ============
export interface AnivexaStream {
  url: string;
  embedUrl?: string;
  type: string;
  server: string;
  referer?: string;
  isActive?: boolean;
}

export interface AnivexaWatchResponse {
  anilistId?: number;
  episode?: number;
  audio?: string;
  streams: AnivexaStream[];
  error?: string;
}

// ============ TATAKAI API TYPES ============
export interface HindiDubbedSearchResult {
  title: string;
  slug: string;
  url: string;
  thumbnail?: string;
}

export interface HindiDubbedSearchResponse {
  status: number;
  data: {
    animeList: HindiDubbedSearchResult[];
    totalFound: number;
  } | null;
}

export interface HindiDubbedServer {
  name: string;
  url: string;
}

export interface HindiDubbedAnimeResponse {
  status: number;
  data: {
    title: string;
    slug: string;
    servers: {
      filemoon?: HindiDubbedServer[];
      servabyss?: HindiDubbedServer[];
      vidgroud?: HindiDubbedServer[];
    };
  } | null;
}

export interface DesiDubSearchResult {
  id: string;
  title: string;
  poster: string;
  type: string;
  url: string;
}

export interface DesiDubSearchResponse {
  status: number;
  data: {
    results: DesiDubSearchResult[];
    query: string;
    totalFound: number;
  };
}

export interface DesiDubSource {
  server: string;
  url: string;
  type: string;
  referer: string;
}

export interface DesiDubWatchResponse {
  status: number;
  data: {
    id: string;
    title: string;
    sources: DesiDubSource[];
  };
}

export interface DesiDubEpisode {
  number: number;
  title: string;
  url: string;
  id: string;
}

export interface DesiDubInfoResponse {
  status: number;
  data: {
    id: string;
    title: string;
    episodes: DesiDubEpisode[];
  };
}
