import { describe, expect, it } from "vitest";

import { createPilotReadinessHandler } from "@/app/api/pilot/readiness/route";

describe("pilot readiness API", () => {
  it("returns only an operator-safe configuration posture", async () => {
    const handler = createPilotReadinessHandler({
      getReadiness: () => ({
        mode: "demo",
        nextAction: "Configura Supabase.",
        checks: [{ id: "persistence", title: "Persistencia", status: "ACTION_REQUIRED", detail: "Demo local." }],
      }),
    });

    const response = await handler();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      mode: "demo",
      nextAction: "Configura Supabase.",
      checks: [{ id: "persistence", title: "Persistencia", status: "ACTION_REQUIRED", detail: "Demo local." }],
    });
  });
});
