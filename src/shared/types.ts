// ============================================================
// W3 Worker — Type definitions
// ============================================================

// ============ ENV BINDINGS ============
export interface Env {
  PREFETCH_QUEUE: Queue<PrefetchJob>;
  SELF_PROXY_BASE: string;
  ANIVEXA_BASE: string;
  SELF_PROXY_TIMEOUT_MS: string;
  ANIVEXA_TIMEOUT_MS: string;
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
  server: string;
  url: string;
  source: string;
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
  language: string;
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
