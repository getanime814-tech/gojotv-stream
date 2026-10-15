import type { Env, StreamRequest } from "./shared/types";
import { resolveStreams, schedulePrefetch } from "./shared/resolve";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, worker: "gojotv-stream", version: "2.0.0" });
    }

    // Main resolve endpoint
    if (url.pathname === "/resolve" && request.method === "POST") {
      return handleResolve(request, env, ctx);
    }

    return json({ error: "Not found" }, 404);
  },
};

// ============================================================
// HANDLE /resolve
// ============================================================
async function handleResolve(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let req: StreamRequest;

  try {
    req = (await request.json()) as StreamRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Validate required fields
  if (
    typeof req.anilist_id !== "number" ||
    typeof req.episode !== "number" ||
    typeof req.slug !== "string" ||
    typeof req.title !== "string" ||
    typeof req.season !== "number"
  ) {
    return json(
      {
        error: "Missing required fields",
        required: [
          "anilist_id (number)",
          "episode (number)",
          "slug (string)",
          "title (string)",
          "season (number)",
        ],
      },
      400
    );
  }

  try {
    const result = await resolveStreams(req, env);

    // Schedule prefetch (fire and forget — ctx.waitUntil ensures completion)
    ctx.waitUntil(schedulePrefetch(req, env));

    return json(result);
  } catch (err) {
    console.error(`[W3] Resolve failed: ${err}`);
    return json(
      {
        error: "Internal error",
        message: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
}

// ============================================================
// HELPER
// ============================================================
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
