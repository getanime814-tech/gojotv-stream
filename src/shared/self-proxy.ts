import type {
  StreamServer,
  SelfProxyResponse,
} from "./types";

// ============================================================
// SELF-PROXY API CLIENT
// ============================================================

interface FetchSelfProxyArgs {
  baseUrl: string;
  slug: string;
  title: string;
  season: number;
  episode: number;
  anilistId: number;
  timeoutMs: number;
}

interface SelfProxyResult {
  eng_sub: StreamServer[];
  eng_dub: StreamServer[];
  hindi: StreamServer[];
  status: "ok" | "empty" | "timeout" | "error";
}

// ============ MAIN FETCH ============
export async function fetchSelfProxy(
  args: FetchSelfProxyArgs
): Promise<SelfProxyResult> {
  const { baseUrl, slug, title, season, episode, anilistId, timeoutMs } = args;

  const params = new URLSearchParams({
    slug,
    title,
    season: String(season),
    episode: String(episode),
    anilist_id: String(anilistId),
  });

  const url = `${baseUrl}/api/streaming?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "GojoTV/2.0",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        eng_sub: [],
        eng_dub: [],
        hindi: [],
        status: res.status === 404 ? "empty" : "error",
      };
    }

    const data = (await res.json()) as SelfProxyResponse;

    if (!data.success || !data.data || !data.data.servers) {
      return { eng_sub: [], eng_dub: [], hindi: [], status: "empty" };
    }

    return mapSelfProxyServers(data.data.servers);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      eng_sub: [],
      eng_dub: [],
      hindi: [],
      status: isAbort ? "timeout" : "error",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============ STRIP PREFIX ============
// "Anikoto - HD-1" → "HD-1"
// "ToonStream - FilesForever 1" → "FilesForever 1"
// If no " - " present → return as-is
function stripProviderPrefix(name: string): string {
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf(" - ");
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 3).trim();
}

// ============ MAP SERVERS ============
function mapSelfProxyServers(
  servers: NonNullable<SelfProxyResponse["data"]>["servers"]
): SelfProxyResult {
  const eng_sub: StreamServer[] = [];
  const eng_dub: StreamServer[] = [];
  const hindi: StreamServer[] = [];

  for (const s of servers) {
    if (!s.embed_url || !s.server_name) continue;

    const cleanName = stripProviderPrefix(s.server_name);
    if (!cleanName) continue;

    const mapped: StreamServer = {
      server: cleanName,
      url: s.embed_url,
      source: "self",
    };

    if (s.type === "sub" && s.language === "english") {
      eng_sub.push(mapped);
    } else if (s.type === "dub" && s.language === "english") {
      eng_dub.push(mapped);
    } else if (s.type === "dub" && s.language === "multi-audio") {
      hindi.push(mapped);
    }
  }

  const total = eng_sub.length + eng_dub.length + hindi.length;

  return {
    eng_sub,
    eng_dub,
    hindi,
    status: total > 0 ? "ok" : "empty",
  };
}
