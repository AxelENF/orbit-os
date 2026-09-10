import { timingSafeEqual } from "node:crypto";

import { createSupabaseCopyWorkerStore } from "@/lib/automation/supabase-copy-worker-store.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

type HealthStore = Pick<ReturnType<typeof createSupabaseCopyWorkerStore>, "health">;

type Dependencies = {
  getToken?: () => string | undefined;
  getStore?: () => HealthStore | Promise<HealthStore>;
};

function hasMatchingToken(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Internal worker health boundary. It is intentionally token-gated instead of
 * session-gated because the polling process is not a browser request. The
 * response contains aggregate queue telemetry only and never job payloads.
 */
export function createWorkerHealthHandler(dependencies: Dependencies = {}) {
  const getToken = dependencies.getToken ?? (() => process.env.SNAPGAD_WORKER_HEALTH_TOKEN);
  const getStore = dependencies.getStore ?? (() => createSupabaseCopyWorkerStore(createSupabaseServiceRoleClient()));

  return async function GET(request: Request): Promise<Response> {
    const expected = getToken();
    if (!expected) {
      return Response.json({ error: "WORKER_HEALTH_NOT_CONFIGURED" }, { status: 503 });
    }
    if (!hasMatchingToken(expected, bearerToken(request))) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    try {
      const health = await (await getStore()).health();
      return Response.json(
        { status: "ok", ...health },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "WORKER_HEALTH_UNAVAILABLE" }, { status: 503 });
    }
  };
}

export const GET = createWorkerHealthHandler();
