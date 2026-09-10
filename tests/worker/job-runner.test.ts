import { describe, expect, it } from "vitest";

import {
  InMemoryJobStore,
  NonRetryableJobError,
  type JobStatus,
  type WorkerJob,
} from "@/worker/job-runner";
import { JobRunner } from "@/worker/job-runner";
import { snapshotWorkerHealth } from "@/worker/health";

const start = Date.parse("2026-09-09T12:00:00.000Z");

function createClock() {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

function enqueue(
  store: InMemoryJobStore,
  input: Partial<Parameters<InMemoryJobStore["enqueue"]>[0]> = {},
) {
  return store.enqueue({
    organizationId: "org-1",
    kind: "copy",
    provider: "local-copy",
    payload: { brief: "hello" },
    idempotencyKey: "copy-1",
    ...input,
  });
}

describe("InMemoryJobStore", () => {
  it("deduplicates enqueue by organization, kind, and idempotency key", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now });

    const first = enqueue(store);
    const duplicate = enqueue(store, { payload: { brief: "changed" } });
    const otherOrganization = enqueue(store, {
      organizationId: "org-2",
      payload: { brief: "org 2" },
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(duplicate.job.payload).toEqual({ brief: "hello" });
    expect(otherOrganization.created).toBe(true);
  });

  it("deep clones tenant payloads and blocks cross-organization reads", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now });
    const payload = { nested: { value: "original" } };
    const queued = enqueue(store, { payload });

    payload.nested.value = "caller-mutated";
    (queued.job.payload as { nested: { value: string } }).nested.value =
      "returned-mutated";

    expect(store.get(queued.job.id, "org-2")).toBeNull();
    expect(store.get(queued.job.id, "org-1")?.payload).toEqual({
      nested: { value: "original" },
    });
    expect(store.list({ organizationId: "org-2" })).toEqual([]);
    expect(store.list({ organizationId: "org-1" })).toHaveLength(1);
  });

  it("isolates claims and permits at most one active job per organization", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now, leaseDurationMs: 1_000 });
    const orgOneFirst = enqueue(store, { idempotencyKey: "one-a" });
    const orgOneSecond = enqueue(store, { idempotencyKey: "one-b" });
    const orgTwo = enqueue(store, {
      organizationId: "org-2",
      idempotencyKey: "two-a",
    });

    const firstClaim = store.claimNext();
    const secondClaim = store.claimNext();
    const blockedSameOrganization = store.claimNext("org-1");

    expect(firstClaim?.id).toBe(orgOneFirst.job.id);
    expect(secondClaim?.id).toBe(orgTwo.job.id);
    expect(blockedSameOrganization).toBeNull();
    expect(orgOneSecond.job.organizationId).toBe("org-1");
  });

  it("requeues an expired lease and allows renewal before expiry", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now, leaseDurationMs: 1_000 });
    const queued = enqueue(store);
    const claimed = store.claimNext();

    expect(claimed?.id).toBe(queued.job.id);
    expect(
      store.renewLease({
        jobId: queued.job.id,
        organizationId: "org-1",
        leaseToken: claimed?.leaseToken ?? "",
      }),
    ).not.toBeNull();

    clock.advance(900);
    const renewed = store.renewLease({
      jobId: queued.job.id,
      organizationId: "org-1",
      leaseToken: claimed?.leaseToken ?? "",
    });

    expect(renewed?.leaseExpiresAt).toBe(new Date(start + 1_900).toISOString());
    clock.advance(200);
    expect(store.recoverExpiredLeases()).toBe(0);
    expect(store.claimNext()).toBeNull();

    clock.advance(800);
    const recovered = store.recoverExpiredLeases();
    const nextClaim = store.claimNext();

    expect(recovered).toBe(1);
    expect(nextClaim?.id).toBe(queued.job.id);
    expect(nextClaim?.attempts).toBe(2);
  });

  it("backs off failed attempts and dead-letters after maxAttempts", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({
      now: clock.now,
      baseBackoffMs: 100,
      leaseDurationMs: 1_000,
    });
    const queued = enqueue(store, { maxAttempts: 2 });

    const firstClaim = store.claimNext();
    const firstFailure = store.fail({
      jobId: queued.job.id,
      organizationId: "org-1",
      leaseToken: firstClaim?.leaseToken ?? "",
      error: new Error("temporary"),
    });

    expect(firstFailure?.status).toBe("RETRY_WAIT");
    expect(firstFailure?.nextAttemptAt).toBe(
      new Date(start + 100).toISOString(),
    );
    expect(store.claimNext()).toBeNull();

    clock.advance(100);
    const secondClaim = store.claimNext();
    const deadLetter = store.fail({
      jobId: queued.job.id,
      organizationId: "org-1",
      leaseToken: secondClaim?.leaseToken ?? "",
      error: "permanent",
    });

    expect(deadLetter?.status).toBe("DEAD_LETTER");
    expect(store.list({ organizationId: "org-1", status: "DEAD_LETTER" })).toHaveLength(1);
  });

  it("cancels queued work and rejects a claim for another organization", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now });
    const queued = enqueue(store);

    expect(
      store.cancel({ jobId: queued.job.id, organizationId: "org-2" }),
    ).toBeNull();
    expect(
      store.cancel({ jobId: queued.job.id, organizationId: "org-1" })?.status,
    ).toBe("CANCELLED");
    expect(store.claimNext()).toBeNull();
  });

  it("rejects cross-organization lease mutations", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now });
    const queued = enqueue(store);
    const claimed = store.claimNext();
    const leaseToken = claimed?.leaseToken ?? "";

    expect(
      store.renewLease({
        jobId: queued.job.id,
        organizationId: "org-2",
        leaseToken,
      }),
    ).toBeNull();
    expect(
      store.complete({
        jobId: queued.job.id,
        organizationId: "org-2",
        leaseToken,
        result: "should-not-complete",
      }),
    ).toBeNull();
    expect(
      store.fail({
        jobId: queued.job.id,
        organizationId: "org-2",
        leaseToken,
        error: "should-not-fail",
      }),
    ).toBeNull();
    expect(
      store.cancel({ jobId: queued.job.id, organizationId: "org-2" }),
    ).toBeNull();
    expect(
      store.markFailed({
        jobId: queued.job.id,
        organizationId: "org-1",
        error: "missing lease token",
      }),
    ).toBeNull();
    expect(store.get(queued.job.id, "org-1")?.status).toBe("PROCESSING");
  });
});

describe("JobRunner", () => {
  it("processes one claimed job and exposes its result", async () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now });
    const queued = enqueue(store);
    const runner = new JobRunner(store, async (job) => ({
      id: job.id,
      copy: "ready",
    }));

    const result = await runner.runOnce();

    expect(result.status).toBe("COMPLETED");
    expect(result.job?.id).toBe(queued.job.id);
    expect(result.result).toEqual({ id: queued.job.id, copy: "ready" });
    expect(store.get(queued.job.id, "org-1")?.status).toBe("COMPLETED");
    expect((await runner.runOnce()).status).toBe("IDLE");
  });

  it("does not run two jobs for the same organization concurrently", async () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now });
    enqueue(store, { idempotencyKey: "first" });
    enqueue(store, { idempotencyKey: "second" });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runner = new JobRunner(store, async () => {
      calls += 1;
      await gate;
      return "done";
    });

    const firstRun = runner.runOnce();
    await Promise.resolve();
    const secondRun = await runner.runOnce();
    release?.();
    await firstRun;

    expect(calls).toBe(1);
    expect(secondRun.status).toBe("IDLE");
  });

  it("records failure observably and leaves retry work for a future run", async () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now, baseBackoffMs: 10 });
    const queued = enqueue(store);
    const runner = new JobRunner(store, () => {
      throw new Error("provider unavailable");
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("RETRY_WAIT");
    expect(result.error).toBe("provider unavailable");
    expect(store.get(queued.job.id, "org-1")?.status).toBe("RETRY_WAIT");
  });

  it("marks a non-retryable processor failure as FAILED", async () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now });
    const queued = enqueue(store);
    const runner = new JobRunner(store, () => {
      throw new NonRetryableJobError("invalid provider payload");
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("FAILED");
    expect(result.job?.status).toBe("FAILED");
    expect(store.get(queued.job.id, "org-1")?.status).toBe("FAILED");
  });

  it("marks a lost lease as FAILED instead of silently completing", async () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now, leaseDurationMs: 100 });
    const queued = enqueue(store);
    const runner = new JobRunner(store, () => {
      clock.advance(101);
      return "late-result";
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/lease/i);
    expect(store.get(queued.job.id, "org-1")?.status).toBe("FAILED");
  });
});

describe("worker health", () => {
  it("returns deterministic queue, lease, dead-letter, and lag metrics", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now, leaseDurationMs: 10_000 });
    enqueue(store, { idempotencyKey: "ready" });
    enqueue(store, {
      idempotencyKey: "future",
      runAt: new Date(start + 5_000).toISOString(),
    });
    const claimed = store.claimNext();

    const health = snapshotWorkerHealth(store);

    expect(claimed).not.toBeNull();
    expect(health).toMatchObject({
      queuedCount: 1,
      retryCount: 0,
      activeLeaseCount: 1,
      deadLetterCount: 0,
      lastSuccessfulRun: null,
      queueLagMs: 0,
    });
  });

  it("recovers expired leases before reporting active health", () => {
    const clock = createClock();
    const store = new InMemoryJobStore({ now: clock.now, leaseDurationMs: 100 });
    const queued = enqueue(store);
    store.claimNext();
    clock.advance(101);

    const health = snapshotWorkerHealth(store);

    expect(health.activeLeaseCount).toBe(0);
    expect(store.get(queued.job.id, "org-1")?.status).toBe("RETRY_WAIT");
  });
});

describe("provider adapters", () => {
  it("keeps copy and publish providers injectable and local", async () => {
    const { LocalCopyProviderAdapter } = await import("@/worker/providers/copy-provider");
    const { LocalPublishProviderAdapter } = await import("@/worker/providers/publish-provider");
    const copy = new LocalCopyProviderAdapter(async (input) => ({
      ...input,
      text: "copy",
    }));
    const publish = new LocalPublishProviderAdapter(async (input) => ({
      ...input,
      publicationId: "local-publication",
    }));

    await expect(copy.generate({ organizationId: "org-1", payload: { brief: "x" } })).resolves.toEqual({
      organizationId: "org-1",
      payload: { brief: "x" },
      text: "copy",
    });
    await expect(publish.publish({ organizationId: "org-1", payload: { copy: "x" } })).resolves.toEqual({
      organizationId: "org-1",
      payload: { copy: "x" },
      publicationId: "local-publication",
    });
  });
});

type _StatusIsExhaustive = JobStatus extends WorkerJob["status"] ? true : never;
const statusIsExhaustive: _StatusIsExhaustive = true;
void statusIsExhaustive;
