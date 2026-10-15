import type { StreamResponse } from "./types";

// ============================================================
// UPSTASH REDIS CLIENT — Direct REST API (no SDK)
// ============================================================

interface RedisEnv {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

// ============ LOW-LEVEL COMMAND ============
async function upstashCommand(
  env: RedisEnv,
  command: (string | number)[]
): Promise<any> {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    throw new Error(`Upstash HTTP ${res.status}`);
  }

  const data = (await res.json()) as { result: any; error?: string };
  if (data.error) {
    throw new Error(`Upstash: ${data.error}`);
  }
  return data.result;
}

// ============ CACHE KEY ============
export function cacheKey(anilistId: number, episode: number): string {
  return `stream:${anilistId}:${episode}`;
}

// ============ GET CACHED ============
export async function getCached(
  env: RedisEnv,
  anilistId: number,
  episode: number
): Promise<StreamResponse | null> {
  try {
    const key = cacheKey(anilistId, episode);
    const raw = await upstashCommand(env, ["GET", key]);

    if (!raw) return null;

    let parsed: StreamResponse;
    if (typeof raw === "string") {
      parsed = JSON.parse(raw) as StreamResponse;
    } else {
      parsed = raw as StreamResponse;
    }

    if (parsed && typeof parsed === "object") {
      return { ...parsed, cached: true };
    }
    return null;
  } catch (err) {
    console.error(`[Redis] GET error: ${err}`);
    return null;
  }
}

// ============ SET CACHED ============
export async function setCached(
  env: RedisEnv,
  anilistId: number,
  episode: number,
  response: StreamResponse,
  ttlSeconds: number
): Promise<void> {
  try {
    const key = cacheKey(anilistId, episode);
    const toStore: StreamResponse = { ...response, cached: false };
    const serialized = JSON.stringify(toStore);

    await upstashCommand(env, ["SET", key, serialized, "EX", ttlSeconds]);
  } catch (err) {
    console.error(`[Redis] SET error: ${err}`);
  }
}
