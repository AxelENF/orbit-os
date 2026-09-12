import { getPilotReadiness, type PilotReadiness } from "@/lib/pilot/readiness";

type Dependencies = {
  getReadiness?: () => PilotReadiness;
};

export function createPilotReadinessHandler(dependencies: Dependencies = {}) {
  const getReadiness = dependencies.getReadiness ?? getPilotReadiness;
  return async function GET(): Promise<Response> {
    return Response.json(getReadiness(), {
      headers: { "cache-control": "no-store" },
    });
  };
}

export const GET = createPilotReadinessHandler();
