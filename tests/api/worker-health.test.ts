import { describe, expect, it, vi } from "vitest";

import { createWorkerHealthHandler } from "@/app/api/internal/worker/health/route";

const token = "worker-health-secret";

function request(authorization?: string): Request {
  return new Request("http://localhost/api/internal/worker/health", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("internal worker health endpoint", () => {
  it("fails closed when the health token is not configured", async () => {
    const health = vi.fn();
    const handler = createWorkerHealthHandler({ getToken: () => undefined, getStore: () => ({ health }) });

    const response = await handler(request(`Bearer ${token}`));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "WORKER_HEALTH_NOT_CONFIGURED" });
    expect(health).not.toHaveBeenCalled();
  });

  it("requires a bearer token and returns aggregate telemetry only", async () => {
    const health = vi.fn().mockResolvedValue({
      queuedCount: 2,
      retryCount: 1,
      activeLeaseCount: 1,
      failedCount: 0,
      deadLetterCount: 0,
      queueLagMs: 120,
      lastSuccessfulRun: null,
    });
    const handler = createWorkerHealthHandler({ getToken: () => token, getStore: () => ({ health }) });

    await expect(handler(request("Bearer wrong-token"))).resolves.toHaveProperty("status", 401);
    const response = await handler(request(`Bearer ${token}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ok", queuedCount: 2, activeLeaseCount: 1 });
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("does not leak provider errors", async () => {
    const handler = createWorkerHealthHandler({
      getToken: () => token,
      getStore: () => ({ health: vi.fn().mockRejectedValue(new Error("secret database details")) }),
    });

    const response = await handler(request(`Bearer ${token}`));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "WORKER_HEALTH_UNAVAILABLE" });
  });
});
