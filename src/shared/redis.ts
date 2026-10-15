import { Redis } from "@upstash/redis";
import type { StreamResponse } from "./types";

// ============ REDIS CLIENT (singleton) ============
let redisClient: Redis | null = null;

export function getRedis(env: {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisClient;
}

// ============ CACHE KEY ============
export function cacheKey(anilistId: number, episode: number): string {
  return `stream:${anilistId}:${episode}`;
}

// ============ GET CACHED ============
export async function getCached(
  redis: Redis,
  anilistId: number,
  episode: number
): Promise<StreamResponse | null> {
  try {
    const key = cacheKey(anilistId, episode);
    const cached = await redis.get<StreamResponse>(key);
    if (cached && typeof cached === "object") {
      return { ...cached, cached: true };
    }
    return null;
  } catch (err) {
    console.error(`[Redis] GET error: ${err}`);
    return null;
  }
}

// ============ SET CACHED ============
export async function setCached(
  redis: Redis,
  anilistId: number,
  episode: number,
  response: StreamResponse,
  ttlSeconds: number
): Promise<void> {
  try {
    const key = cacheKey(anilistId, episode);
    const toStore: StreamResponse = { ...response, cached: false };
    await redis.set(key, toStore, { ex: ttlSeconds });
  } catch (err) {
    console.error(`[Redis] SET error: ${err}`);
  }
}
