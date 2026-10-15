import type { StreamServer } from "./types";

// ============================================================
// MERGE SERVERS FROM ALL SOURCES
// Rule: source order (self → anivexa → tatakai)
//       duplicate names get " 2", " 3" suffix
// ============================================================

export function mergeServers(
  selfServers: StreamServer[],
  anivexaServers: StreamServer[],
  tatakaiServers: StreamServer[]
): StreamServer[] {
  // Concatenate in source order
  const all: StreamServer[] = [
    ...selfServers,
    ...anivexaServers,
    ...tatakaiServers,
  ];

  // Deduplicate by name (case-insensitive)
  const nameCount = new Map<string, number>();
  const merged: StreamServer[] = [];

  for (const s of all) {
    if (!s.url || !s.server) continue;

    const baseName = s.server.trim();
    const key = baseName.toLowerCase();
    const count = (nameCount.get(key) ?? 0) + 1;
    nameCount.set(key, count);

    merged.push({
      server: count === 1 ? baseName : `${baseName} ${count}`,
      url: s.url,
      source: s.source,
    });
  }

  return merged;
}

// ============================================================
// MERGE ALL THREE LANGUAGE GROUPS
// ============================================================

export interface MergedStreams {
  eng_sub: StreamServer[];
  eng_dub: StreamServer[];
  hindi: StreamServer[];
}

export function mergeAllSources(sources: {
  self: { eng_sub: StreamServer[]; eng_dub: StreamServer[]; hindi: StreamServer[] };
  anivexa: { eng_sub: StreamServer[]; eng_dub: StreamServer[] };
  tatakai: { hindi: StreamServer[] };
}): MergedStreams {
  return {
    eng_sub: mergeServers(
      sources.self.eng_sub,
      sources.anivexa.eng_sub,
      []
    ),
    eng_dub: mergeServers(
      sources.self.eng_dub,
      sources.anivexa.eng_dub,
      []
    ),
    hindi: mergeServers(
      sources.self.hindi,
      [],
      sources.tatakai.hindi
    ),
  };
}
