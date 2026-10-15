import type { StreamServer, AnivexaWatchResponse } from "./types";

// ============================================================
// ANIVEXA API CLIENT
// Provider names hidden — mapped to neutral display names
// ============================================================

interface FetchAnivexaArgs {
  baseUrl: string;
  anilistId: number;
  episode: number;
  timeoutMs: number;
}

interface AnivexaResult {
  eng_sub: StreamServer[];
  eng_dub: StreamServer[];
  status: "ok" | "empty" | "timeout" | "error";
}

// ✅ Neutral display names (no provider branding)
const PROVIDERS: Array<{
  provider: string;
  serverName: string;
}> = [
  { provider: "anikoto", serverName: "MG play" },
  { provider: "animegg", serverName: "GG play" },
];

// ============ MAIN FETCH (parallel) ============
export async function fetchAnivexa(
  args: FetchAnivexaArgs
): Promise<AnivexaResult> {
  const { baseUrl, anilistId, episode, timeoutMs } = args;

  const tasks: Array<Promise<StreamServer | null>> = [];

  for (const { provider, serverName } of PROVIDERS) {
    // Sub
    tasks.push(
      fetchOne({
        baseUrl,
        provider,
        anilistId,
        episode,
        audio: "sub",
        serverName,
        timeoutMs,
      })
    );
    // Dub
    tasks.push(
      fetchOne({
        baseUrl,
        provider,
        anilistId,
        episode,
        audio: "dub",
        serverName,
        timeoutMs,
      })
    );
  }

  const results = await Promise.allSettled(tasks);

  const eng_sub: StreamServer[] = [];
  const eng_dub: StreamServer[] = [];
  let hasTimeout = false;
  let hasError = false;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const isDub = i % 2 === 1;

    if (r.status === "fulfilled" && r.value) {
      if (isDub) eng_dub.push(r.value);
      else eng_sub.push(r.value);
    } else if (r.status === "rejected") {
      if (r.reason?.name === "AbortError") hasTimeout = true;
      else hasError = true;
    }
  }

  let status: AnivexaResult["status"] = "ok";
  if (eng_sub.length === 0 && eng_dub.length === 0) {
    if (hasTimeout) status = "timeout";
    else if (hasError) status = "error";
    else status = "empty";
  }

  return { eng_sub, eng_dub, status };
}

// ============ FETCH SINGLE STREAM ============
async function fetchOne(params: {
  baseUrl: string;
  provider: string;
  anilistId: number;
  episode: number;
  audio: "sub" | "dub";
  serverName: string;
  timeoutMs: number;
}): Promise<StreamServer | null> {
  const { baseUrl, provider, anilistId, episode, audio, serverName, timeoutMs } =
    params;

  const url = `${baseUrl}/watch/${provider}/${anilistId}/${audio}/${provider}-${episode}`;

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

    if (!res.ok) return null;

    const data = (await res.json()) as AnivexaWatchResponse;
    if (data.error || !data.streams || data.streams.length === 0) return null;

    const embed = data.streams.find((s) => s.embedUrl);
    const url_ = embed?.embedUrl ?? data.streams[0]?.url;

    if (!url_) return null;

    return {
      server: serverName,
      url: url_,
      source: "anivexa",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
