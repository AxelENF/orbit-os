import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DurableJob,
  DurableJobWorkerStore,
} from "@/lib/automation/durable-job-contract";
import { DurableJobRunner } from "@/worker/durable-runner";
import { parseWorkerDuration } from "@/worker/entrypoint";

const organizationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "44444444-4444-4444-8444-444444444444";
const leaseToken = "55555555-5555-4555-8555-555555555555";

type Payload = { message: string };
type Result = { ok: boolean };
type Job = DurableJob<Payload, Result>;

function makeJob(): Job {
  return {
    id: jobId,
    organizationId,
    kind: "COPY",
    provider: "local",
    payload: { message: "process this" },
    idempotencyKey,
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    runAt: "2026-09-10T12:00:00.000Z",
    nextAttemptAt: "2026-09-10T12:00:00.000Z",
    leaseToken,
    leaseExpiresAt: "2026-09-10T12:10:00.000Z",
    lastError: null,
    createdAt: "2026-09-10T11:59:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    startedAt: "2026-09-10T12:00:00.000Z",
    completedAt: null,
  };
}

function storeWith(job: Job, overrides: Partial<DurableJobWorkerStore<Payload, Result>> = {}) {
  return {
    claimNext: vi.fn().mockResolvedValue(job),
    renewLease: vi.fn().mockResolvedValue(job),
    complete: vi.fn().mockResolvedValue({ ...job, status: "COMPLETED" as const }),
    fail: vi.fn().mockResolvedValue({ ...job, status: "RETRY_WAIT" as const }),
    cancel: vi.fn().mockResolvedValue(null),
    recoverExpired: vi.fn().mockResolvedValue(0),
    ...overrides,
  } satisfies DurableJobWorkerStore<Payload, Result>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("DurableJobRunner", () => {
  it("renews a long-running lease and completes through the durable store", async () => {
    vi.useFakeTimers();
    const job = makeJob();
    let resolveProcessor!: (result: Result) => void;
    const processor = vi.fn().mockReturnValue(new Promise<Result>((resolve) => { resolveProcessor = resolve; }));
    const store = storeWith(job);
    const runner = new DurableJobRunner(store, processor, {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 1_000,
    });

    const running = runner.runOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.renewLease).toHaveBeenCalledWith({
      jobId,
      organizationId,
      leaseToken,
      leaseDurationMs: 30_000,
    });

    resolveProcessor({ ok: true });
    await expect(running).resolves.toMatchObject({ status: "COMPLETED", result: { ok: true } });
    expect(store.complete).toHaveBeenCalledWith({
      jobId,
      organizationId,
      leaseToken,
      result: { ok: true },
    });
  });

  it("persists a retryable processor error and sanitizes the returned error", async () => {
    const job = makeJob();
    const store = storeWith(job, {
      fail: vi.fn().mockResolvedValue({ ...job, status: "RETRY_WAIT" as const, lastError: "provider down" }),
    });
    const runner = new DurableJobRunner(store, async () => {
      throw new Error("provider down\nsecret payload");
    });

    const result = await runner.runOnce();

    expect(result).toMatchObject({ status: "RETRY_WAIT", error: "provider down\nsecret payload" });
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({
      jobId,
      organizationId,
      leaseToken,
      retryable: true,
    }));
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("recovers expired leases before polling and stops without another network call", async () => {
    const job = makeJob();
    const store = storeWith(job, {
      claimNext: vi.fn().mockResolvedValue(null),
    });
    const sleep = vi.fn().mockImplementation(async () => runner.stop());
    const runner = new DurableJobRunner<Payload, Result>(store, vi.fn(), {
      pollIntervalMs: 250,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 1_000,
      recoveryIntervalMs: 1_000,
      sleep,
    });

    await runner.runUntilStopped();

    expect(store.recoverExpired).toHaveBeenCalledTimes(1);
    expect(store.claimNext).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250, expect.any(AbortSignal));
  });

  it("rejects unsafe timing configuration before running", () => {
    const store = storeWith(makeJob());
    expect(() => new DurableJobRunner(store, vi.fn(), { leaseDurationMs: 20_000 })).toThrow(/leaseDurationMs/);
    expect(() => new DurableJobRunner(store, vi.fn(), { leaseDurationMs: 30_000, heartbeatIntervalMs: 30_000 })).toThrow(/heartbeat/);
  });

  it("fails closed on malformed environment timing", () => {
    vi.stubEnv("SNAPGAD_WORKER_POLL_INTERVAL_MS", "not-a-duration");
    expect(() => parseWorkerDuration("SNAPGAD_WORKER_POLL_INTERVAL_MS", 5_000)).toThrow(/positive integer/);
  });
});
