/**
 * Storage-neutral contract for the portal-owned automation worker.
 *
 * This module describes the boundary between a scheduler and a durable store;
 * it intentionally performs no I/O and has no Supabase, n8n, or Meta imports.
 * The in-memory worker can implement this shape today and a Supabase adapter
 * can implement it later without changing the state-machine semantics.
 *
 * `runAt` is the original schedule supplied by the caller. `nextAttemptAt` is
 * the mutable retry due time and must never make work eligible before `runAt`.
 * `provider` is an explicit adapter key (for example, `local-copy`), not a
 * caller-provided URL or a credential.
 */

export const DURABLE_JOB_STATUSES = [
  "QUEUED",
  "PROCESSING",
  "RETRY_WAIT",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "DEAD_LETTER",
] as const;

export type DurableJobStatus = (typeof DURABLE_JOB_STATUSES)[number];

export type DurableJobTimestamp = string | number | Date;

export interface DurableJob<Payload = unknown, Result = unknown> {
  id: string;
  organizationId: string;
  kind: string;
  provider: string;
  payload: Payload;
  idempotencyKey: string;
  status: DurableJobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  nextAttemptAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  result?: Result;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt?: string | null;
}

export interface EnqueueDurableJobInput<Payload = unknown> {
  organizationId: string;
  kind: string;
  provider: string;
  payload: Payload;
  idempotencyKey: string;
  maxAttempts?: number;
  runAt?: DurableJobTimestamp;
}

export interface DurableJobEnqueueResult<Payload = unknown, Result = unknown> {
  created: boolean;
  job: DurableJob<Payload, Result>;
}

export interface ClaimDurableJobInput {
  organizationId?: string;
  now?: DurableJobTimestamp;
}

export interface RenewDurableJobLeaseInput {
  jobId: string;
  organizationId: string;
  leaseToken: string;
  leaseDurationMs?: number;
}

export interface CompleteDurableJobInput<Result = unknown> {
  jobId: string;
  organizationId: string;
  leaseToken: string;
  result?: Result;
}

export interface FailDurableJobInput {
  jobId: string;
  organizationId: string;
  leaseToken: string;
  error: unknown;
  retryable?: boolean;
}

export interface CancelDurableJobInput {
  jobId: string;
  organizationId: string;
  idempotencyKey?: string;
  /** Required when cancelling a processing job; absent for queued work. */
  leaseToken?: string | null;
  reason?: string;
}

export type DurableJobMutationResult<Payload = unknown, Result = unknown> =
  DurableJob<Payload, Result> | null;

export type MaybePromise<T> = T | Promise<T>;

/** A store adapter must keep every mutation tenant-scoped and lease-owned. */
export interface DurableJobStore<Payload = unknown, Result = unknown> {
  enqueue(
    input: EnqueueDurableJobInput<Payload>,
  ): MaybePromise<DurableJobEnqueueResult<Payload, Result>>;
  claimNext(
    input?: ClaimDurableJobInput,
  ): MaybePromise<DurableJobMutationResult<Payload, Result>>;
  renewLease(
    input: RenewDurableJobLeaseInput,
  ): MaybePromise<DurableJobMutationResult<Payload, Result>>;
  complete(
    input: CompleteDurableJobInput<Result>,
  ): MaybePromise<DurableJobMutationResult<Payload, Result>>;
  fail(
    input: FailDurableJobInput,
  ): MaybePromise<DurableJobMutationResult<Payload, Result>>;
  cancel(
    input: CancelDurableJobInput,
  ): MaybePromise<DurableJobMutationResult<Payload, Result>>;
}

/**
 * Worker-side subset. Enqueue remains a portal operation so a background
 * process cannot manufacture work on behalf of an arbitrary organization.
 */
export interface DurableJobWorkerStore<Payload = unknown, Result = unknown>
  extends Pick<
    DurableJobStore<Payload, Result>,
    "claimNext" | "renewLease" | "complete" | "fail" | "cancel"
  > {
  recoverExpired?(limit?: number): MaybePromise<number>;
  health?(): MaybePromise<DurableJobHealth>;
}

export interface DurableJobHealth {
  queuedCount: number;
  retryCount: number;
  activeLeaseCount: number;
  failedCount: number;
  deadLetterCount: number;
  queueLagMs: number;
  lastSuccessfulRun: string | null;
}

const DURABLE_JOB_TRANSITIONS: Readonly<
  Record<DurableJobStatus, readonly DurableJobStatus[]>
> = {
  QUEUED: ["PROCESSING", "CANCELLED"],
  PROCESSING: [
    "RETRY_WAIT",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "DEAD_LETTER",
  ],
  RETRY_WAIT: ["PROCESSING", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  DEAD_LETTER: [],
};

export class DurableJobContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DurableJobContractError";
  }
}

export function canTransitionDurableJob(
  from: DurableJobStatus,
  to: DurableJobStatus,
): boolean {
  return DURABLE_JOB_TRANSITIONS[from].includes(to);
}

export function assertDurableJobTransition(
  from: DurableJobStatus,
  to: DurableJobStatus,
): void {
  if (!canTransitionDurableJob(from, to)) {
    throw new DurableJobContractError(
      `Invalid durable job transition: ${from} -> ${to}`,
    );
  }
}

export function isDurableJobClaimable(
  job: Pick<DurableJob, "status" | "runAt" | "nextAttemptAt">,
  now: DurableJobTimestamp = Date.now(),
): boolean {
  if (job.status !== "QUEUED" && job.status !== "RETRY_WAIT") {
    return false;
  }
  const nowMs = timestampMilliseconds(now);
  return (
    timestampMilliseconds(job.runAt) <= nowMs &&
    timestampMilliseconds(job.nextAttemptAt) <= nowMs
  );
}

export function isDurableJobLeaseActive(
  job: Pick<DurableJob, "status" | "leaseToken" | "leaseExpiresAt">,
  now: DurableJobTimestamp = Date.now(),
): boolean {
  return (
    job.status === "PROCESSING" &&
    job.leaseToken !== null &&
    job.leaseExpiresAt !== null &&
    timestampMilliseconds(job.leaseExpiresAt) > timestampMilliseconds(now)
  );
}

export function statusAfterDurableJobFailure(input: {
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
}): Extract<DurableJobStatus, "RETRY_WAIT" | "FAILED" | "DEAD_LETTER"> {
  if (
    !Number.isInteger(input.attempts) ||
    !Number.isInteger(input.maxAttempts) ||
    input.attempts <= 0 ||
    input.maxAttempts <= 0
  ) {
    throw new DurableJobContractError(
      "attempts and maxAttempts must be positive integers",
    );
  }
  if (input.retryable === false) {
    return "FAILED";
  }
  return input.attempts >= input.maxAttempts ? "DEAD_LETTER" : "RETRY_WAIT";
}

export function validateDurableJob<Payload, Result>(
  job: DurableJob<Payload, Result>,
): void {
  if (!job.organizationId || !job.kind || !job.provider || !job.idempotencyKey) {
    throw new DurableJobContractError(
      "organizationId, kind, provider, and idempotencyKey are required",
    );
  }
  if (
    !Number.isInteger(job.attempts) ||
    job.attempts < 0 ||
    !Number.isInteger(job.maxAttempts) ||
    job.maxAttempts <= 0 ||
    job.attempts > job.maxAttempts
  ) {
    throw new DurableJobContractError(
      "attempts must be between zero and maxAttempts",
    );
  }
  const runAt = timestampMilliseconds(job.runAt);
  const nextAttemptAt = timestampMilliseconds(job.nextAttemptAt);
  if (nextAttemptAt < runAt) {
    throw new DurableJobContractError(
      "nextAttemptAt cannot be earlier than runAt",
    );
  }
  if (job.status === "PROCESSING") {
    if (job.leaseToken === null || job.leaseExpiresAt === null) {
      throw new DurableJobContractError(
        "PROCESSING jobs require an active lease token and expiry",
      );
    }
  } else if (job.leaseToken !== null || job.leaseExpiresAt !== null) {
    throw new DurableJobContractError(
      "Only PROCESSING jobs may retain a lease",
    );
  }
}

function timestampMilliseconds(value: DurableJobTimestamp): number {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new DurableJobContractError("Invalid durable job timestamp");
  }
  return milliseconds;
}
