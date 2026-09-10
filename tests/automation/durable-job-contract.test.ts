import { describe, expect, it } from "vitest";

import {
  assertDurableJobTransition,
  canTransitionDurableJob,
  DurableJobContractError,
  DURABLE_JOB_STATUSES,
  isDurableJobClaimable,
  isDurableJobLeaseActive,
  statusAfterDurableJobFailure,
  validateDurableJob,
  type DurableJob,
} from "@/lib/automation/durable-job-contract";

const start = "2026-09-09T12:00:00.000Z";

function makeJob(overrides: Partial<DurableJob> = {}): DurableJob {
  return {
    id: "job-1",
    organizationId: "org-1",
    kind: "COPY",
    provider: "local-copy",
    payload: { brief: "hello" },
    idempotencyKey: "copy-1",
    status: "QUEUED",
    attempts: 0,
    maxAttempts: 3,
    runAt: start,
    nextAttemptAt: start,
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: start,
    updatedAt: start,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("durable job contract", () => {
  it("defines the complete lifecycle status vocabulary", () => {
    expect(DURABLE_JOB_STATUSES).toEqual([
      "QUEUED",
      "PROCESSING",
      "RETRY_WAIT",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "DEAD_LETTER",
    ]);
  });

  it("allows only explicit lifecycle transitions", () => {
    expect(canTransitionDurableJob("QUEUED", "PROCESSING")).toBe(true);
    expect(canTransitionDurableJob("PROCESSING", "RETRY_WAIT")).toBe(true);
    expect(canTransitionDurableJob("PROCESSING", "DEAD_LETTER")).toBe(true);
    expect(canTransitionDurableJob("COMPLETED", "PROCESSING")).toBe(false);
    expect(() => assertDurableJobTransition("FAILED", "QUEUED")).toThrow(
      DurableJobContractError,
    );
  });

  it("keeps runAt as the lower bound for retry scheduling", () => {
    const now = Date.parse(start) + 1_000;
    expect(
      isDurableJobClaimable(
        { status: "QUEUED", runAt: start, nextAttemptAt: start },
        now,
      ),
    ).toBe(true);
    expect(
      isDurableJobClaimable(
        {
          status: "RETRY_WAIT",
          runAt: start,
          nextAttemptAt: new Date(now + 1_000).toISOString(),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isDurableJobClaimable(
        { status: "QUEUED", runAt: new Date(now + 1_000).toISOString(), nextAttemptAt: start },
        now,
      ),
    ).toBe(false);
  });

  it("requires a live lease only while processing", () => {
    const now = Date.parse(start);
    expect(
      isDurableJobLeaseActive(
        {
          status: "PROCESSING",
          leaseToken: "lease-1",
          leaseExpiresAt: new Date(now + 1_000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isDurableJobLeaseActive(
        {
          status: "PROCESSING",
          leaseToken: "lease-1",
          leaseExpiresAt: new Date(now).toISOString(),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isDurableJobLeaseActive({
        status: "RETRY_WAIT",
        leaseToken: "lease-1",
        leaseExpiresAt: new Date(now + 1_000).toISOString(),
      }),
    ).toBe(false);
  });

  it("maps retryable failures to retry or dead-letter and preserves terminal failures", () => {
    expect(
      statusAfterDurableJobFailure({ retryable: true, attempts: 1, maxAttempts: 3 }),
    ).toBe("RETRY_WAIT");
    expect(
      statusAfterDurableJobFailure({ retryable: true, attempts: 3, maxAttempts: 3 }),
    ).toBe("DEAD_LETTER");
    expect(
      statusAfterDurableJobFailure({ retryable: false, attempts: 1, maxAttempts: 3 }),
    ).toBe("FAILED");
    expect(() =>
      statusAfterDurableJobFailure({ retryable: true, attempts: 0, maxAttempts: 3 }),
    ).toThrow(DurableJobContractError);
    expect(() =>
      statusAfterDurableJobFailure({ retryable: false, attempts: 0, maxAttempts: 3 }),
    ).toThrow(DurableJobContractError);
  });

  it("validates provider, scheduling, and lease invariants", () => {
    expect(() => validateDurableJob(makeJob())).not.toThrow();
    expect(() =>
      validateDurableJob(
        makeJob({
          nextAttemptAt: new Date(Date.parse(start) - 1_000).toISOString(),
        }),
      ),
    ).toThrow(/nextAttemptAt/);
    expect(() =>
      validateDurableJob(
        makeJob({
          status: "PROCESSING",
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      ),
    ).toThrow(/lease/);
    expect(() =>
      validateDurableJob(
        makeJob({ status: "QUEUED", leaseToken: "stale", leaseExpiresAt: start }),
      ),
    ).toThrow(/Only PROCESSING/);
  });
});
