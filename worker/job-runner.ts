/**
 * Local, dependency-free worker kernel.
 *
 * This module intentionally owns no persistence or network integration. A
 * Supabase-backed store, n8n adapter, or Meta adapter can implement the same
 * boundary later without changing the state machine below.
 */

export const JOB_STATUSES = [
  "QUEUED",
  "PROCESSING",
  "RETRY_WAIT",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "DEAD_LETTER",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type TimestampInput = string | number | Date;
export type WorkerClock = () => number;

export interface WorkerJob<Payload = unknown, Result = unknown> {
  id: string;
  organizationId: string;
  kind: string;
  provider: string;
  payload: Payload;
  idempotencyKey: string;
  status: JobStatus;
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
}

export interface EnqueueJobInput<Payload = unknown> {
  organizationId: string;
  kind: string;
  provider: string;
  payload: Payload;
  idempotencyKey: string;
  maxAttempts?: number;
  runAt?: TimestampInput;
}

export interface EnqueueJobResult<Payload = unknown, Result = unknown> {
  created: boolean;
  job: WorkerJob<Payload, Result>;
}

export interface InMemoryJobStoreOptions {
  now?: WorkerClock;
  leaseDurationMs?: number;
  baseBackoffMs?: number;
  idGenerator?: () => string;
}

export interface RenewLeaseInput {
  jobId: string;
  leaseToken: string;
  organizationId: string;
  leaseDurationMs?: number;
}

export interface CompleteJobInput<Result = unknown> {
  jobId: string;
  leaseToken: string;
  organizationId: string;
  result?: Result;
}

export interface FailJobInput {
  jobId: string;
  leaseToken: string;
  organizationId: string;
  error: unknown;
  retryable?: boolean;
}

export interface CancelJobInput {
  jobId: string;
  organizationId: string;
}

export interface JobListFilter {
  organizationId: string;
  status?: JobStatus;
  kind?: string;
  provider?: string;
}

export interface MarkFailedInput {
  jobId: string;
  organizationId: string;
  error: unknown;
  leaseToken?: string;
}

export interface JobStoreStats {
  queuedCount: number;
  retryCount: number;
  activeLeaseCount: number;
  deadLetterCount: number;
  queueLagMs: number;
  lastSuccessfulRun: string | null;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function timestampFrom(value: TimestampInput | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Invalid job timestamp");
  }
  return milliseconds;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function backoff(baseBackoffMs: number, attempts: number): number {
  return baseBackoffMs * 2 ** Math.max(0, attempts - 1);
}

function cloneJob<Payload, Result>(job: WorkerJob<Payload, Result>): WorkerJob<Payload, Result> {
  return {
    ...job,
    payload: deepClone(job.payload),
    ...(Object.prototype.hasOwnProperty.call(job, "result")
      ? { result: deepClone(job.result) }
      : {}),
  };
}

export class NonRetryableJobError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

export class InMemoryJobStore<Payload = unknown, Result = unknown> {
  private readonly jobs = new Map<string, WorkerJob<Payload, Result>>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly now: WorkerClock;
  private readonly leaseDurationMs: number;
  private readonly baseBackoffMs: number;
  private readonly idGenerator?: () => string;
  private idSequence = 0;
  private leaseSequence = 0;
  private successfulRunAt: string | null = null;

  public constructor(options: InMemoryJobStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.idGenerator = options.idGenerator;
    if (
      !Number.isFinite(this.leaseDurationMs) ||
      this.leaseDurationMs <= 0 ||
      !Number.isFinite(this.baseBackoffMs) ||
      this.baseBackoffMs < 0
    ) {
      throw new Error("Worker timing options must be non-negative and lease duration must be positive");
    }
  }

  public currentTime(): number {
    return this.now();
  }

  public enqueue(input: EnqueueJobInput<Payload>): EnqueueJobResult<Payload, Result> {
    if (!input.organizationId || !input.kind || !input.provider || !input.idempotencyKey) {
      throw new Error("organizationId, kind, provider, and idempotencyKey are required");
    }
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("maxAttempts must be a positive integer");
    }

    const key = this.idempotencyKey(input.organizationId, input.kind, input.idempotencyKey);
    const existingId = this.idempotencyIndex.get(key);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (existing !== undefined) {
        return { created: false, job: cloneJob(existing) };
      }
    }

    const now = this.now();
    const runAt = timestampFrom(input.runAt, now);
    const job: WorkerJob<Payload, Result> = {
      id: this.nextJobId(),
      organizationId: input.organizationId,
      kind: input.kind,
      provider: input.provider,
      payload: deepClone(input.payload),
      idempotencyKey: input.idempotencyKey,
      status: "QUEUED",
      attempts: 0,
      maxAttempts,
      runAt: iso(runAt),
      nextAttemptAt: iso(runAt),
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: iso(now),
      updatedAt: iso(now),
      startedAt: null,
      completedAt: null,
    };
    this.jobs.set(job.id, job);
    this.idempotencyIndex.set(key, job.id);
    return { created: true, job: cloneJob(job) };
  }

  public get(jobId: string, organizationId: string): WorkerJob<Payload, Result> | null {
    const job = this.jobs.get(jobId);
    return job === undefined || job.organizationId !== organizationId ? null : cloneJob(job);
  }

  public list(filter: JobListFilter): Array<WorkerJob<Payload, Result>> {
    return [...this.jobs.values()]
      .filter((job) => job.organizationId === filter.organizationId)
      .filter((job) => filter.status === undefined || job.status === filter.status)
      .filter((job) => filter.kind === undefined || job.kind === filter.kind)
      .filter((job) => filter.provider === undefined || job.provider === filter.provider)
      .map((job) => cloneJob(job));
  }

  /**
   * Internal scheduler operation. It may scan all organizations because the
   * worker, rather than a tenant-facing request, owns the claim boundary.
   */
  public claimNext(organizationId?: string): WorkerJob<Payload, Result> | null {
    this.recoverExpiredLeases(organizationId);
    const now = this.now();
    const activeOrganizations = new Set(
      [...this.jobs.values()]
        .filter((job) => job.status === "PROCESSING" && this.hasLiveLease(job, now))
        .map((job) => job.organizationId),
    );
    const eligible = [...this.jobs.values()]
      .filter((job) => job.status === "QUEUED" || job.status === "RETRY_WAIT")
      .filter((job) => organizationId === undefined || job.organizationId === organizationId)
      .filter((job) => !activeOrganizations.has(job.organizationId))
      .filter((job) => Date.parse(job.nextAttemptAt) <= now)
      .sort((left, right) => {
        const due = Date.parse(left.nextAttemptAt) - Date.parse(right.nextAttemptAt);
        return due === 0 ? left.createdAt.localeCompare(right.createdAt) : due;
      });
    const job = eligible[0];
    if (job === undefined) {
      return null;
    }

    job.status = "PROCESSING";
    job.attempts += 1;
    job.leaseToken = this.nextLeaseToken();
    job.leaseExpiresAt = iso(now + this.leaseDurationMs);
    job.startedAt = job.startedAt ?? iso(now);
    job.updatedAt = iso(now);
    return cloneJob(job);
  }

  public renewLease(input: RenewLeaseInput): WorkerJob<Payload, Result> | null {
    const job = this.ownedProcessingJob(input.jobId, input.organizationId, input.leaseToken);
    if (job === null) {
      return null;
    }
    const now = this.now();
    const duration = input.leaseDurationMs ?? this.leaseDurationMs;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("leaseDurationMs must be positive");
    }
    job.leaseExpiresAt = iso(now + duration);
    job.updatedAt = iso(now);
    return cloneJob(job);
  }

  public complete(input: CompleteJobInput<Result>): WorkerJob<Payload, Result> | null {
    const job = this.ownedProcessingJob(input.jobId, input.organizationId, input.leaseToken);
    if (job === null) {
      return null;
    }
    const now = this.now();
    job.status = "COMPLETED";
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.nextAttemptAt = iso(now);
    job.updatedAt = iso(now);
    job.completedAt = iso(now);
    job.result = deepClone(input.result);
    this.successfulRunAt = iso(now);
    return cloneJob(job);
  }

  public fail(input: FailJobInput): WorkerJob<Payload, Result> | null {
    const job = this.ownedProcessingJob(input.jobId, input.organizationId, input.leaseToken);
    if (job === null) {
      return null;
    }
    const now = this.now();
    job.lastError = normalizeError(input.error);
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = iso(now);
    if (input.retryable === false) {
      // FAILED is a terminal operator-visible state for errors that should not
      // be retried. RETRY_WAIT and DEAD_LETTER remain for retryable failures.
      job.status = "FAILED";
      job.nextAttemptAt = iso(now);
    } else if (job.attempts >= job.maxAttempts) {
      job.status = "DEAD_LETTER";
      job.nextAttemptAt = iso(now);
    } else {
      job.status = "RETRY_WAIT";
      job.nextAttemptAt = iso(now + backoff(this.baseBackoffMs, job.attempts));
    }
    return cloneJob(job);
  }

  public markFailed(input: MarkFailedInput): WorkerJob<Payload, Result> | null {
    const job = this.jobs.get(input.jobId);
    if (
      job === undefined ||
      job.organizationId !== input.organizationId ||
      job.status === "COMPLETED" ||
      job.status === "CANCELLED" ||
      job.status === "DEAD_LETTER" ||
      (job.status === "PROCESSING" &&
        (input.leaseToken === undefined || job.leaseToken !== input.leaseToken))
    ) {
      return null;
    }
    const now = this.now();
    job.status = "FAILED";
    job.lastError = normalizeError(input.error);
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.nextAttemptAt = iso(now);
    job.updatedAt = iso(now);
    return cloneJob(job);
  }

  public cancel(input: CancelJobInput): WorkerJob<Payload, Result> | null {
    const job = this.jobs.get(input.jobId);
    if (job === undefined || job.organizationId !== input.organizationId) {
      return null;
    }
    if (job.status === "COMPLETED" || job.status === "DEAD_LETTER" || job.status === "CANCELLED") {
      return null;
    }
    const now = this.now();
    job.status = "CANCELLED";
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = iso(now);
    return cloneJob(job);
  }

  /** Internal scheduler recovery; tenant-facing callers use no store access. */
  public recoverExpiredLeases(organizationId?: string): number {
    const now = this.now();
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (
        job.status !== "PROCESSING" ||
        (organizationId !== undefined && job.organizationId !== organizationId) ||
        job.leaseExpiresAt === null ||
        Date.parse(job.leaseExpiresAt) > now
      ) {
        continue;
      }
      recovered += 1;
      job.lastError = job.lastError ?? "Lease expired";
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.updatedAt = iso(now);
      if (job.attempts >= job.maxAttempts) {
        job.status = "DEAD_LETTER";
        job.nextAttemptAt = iso(now);
      } else {
        job.status = "RETRY_WAIT";
        // A lease expiry means the worker disappeared, not that the provider
        // returned a retryable error. Make the recovered job immediately
        // claimable; provider failures use exponential backoff in fail().
        job.nextAttemptAt = iso(now);
      }
    }
    return recovered;
  }

  /** Process-wide health aggregation for the internal worker only. */
  public stats(): JobStoreStats {
    this.recoverExpiredLeases();
    const now = this.now();
    const waiting = [...this.jobs.values()].filter(
      (job) => (job.status === "QUEUED" || job.status === "RETRY_WAIT") && Date.parse(job.nextAttemptAt) <= now,
    );
    const oldest = waiting.reduce<number | null>((oldestValue, job) => {
      const due = Date.parse(job.nextAttemptAt);
      return oldestValue === null ? due : Math.min(oldestValue, due);
    }, null);
    return {
      queuedCount: this.jobsForStatus("QUEUED").length,
      retryCount: this.jobsForStatus("RETRY_WAIT").length,
      activeLeaseCount: this.jobsForStatus("PROCESSING").filter((job) => this.hasLiveLease(job, now)).length,
      deadLetterCount: this.jobsForStatus("DEAD_LETTER").length,
      queueLagMs: oldest === null ? 0 : Math.max(0, now - oldest),
      lastSuccessfulRun: this.successfulRunAt,
    };
  }

  private idempotencyKey(organizationId: string, kind: string, idempotencyKey: string): string {
    return `${organizationId}\u0000${kind}\u0000${idempotencyKey}`;
  }

  private nextJobId(): string {
    if (this.idGenerator !== undefined) {
      return this.idGenerator();
    }
    this.idSequence += 1;
    return `worker-job-${this.idSequence}`;
  }

  private nextLeaseToken(): string {
    this.leaseSequence += 1;
    return `worker-lease-${this.leaseSequence}`;
  }

  private jobsForStatus(status: JobStatus): Array<WorkerJob<Payload, Result>> {
    return [...this.jobs.values()].filter((job) => job.status === status);
  }

  private hasLiveLease(job: WorkerJob<Payload, Result>, now: number): boolean {
    return job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) > now;
  }

  private ownedProcessingJob(jobId: string, organizationId: string, leaseToken: string): WorkerJob<Payload, Result> | null {
    const job = this.jobs.get(jobId);
    if (
      job === undefined ||
      (organizationId !== undefined && job.organizationId !== organizationId) ||
      job.status !== "PROCESSING" ||
      job.leaseToken !== leaseToken ||
      job.leaseExpiresAt === null ||
      Date.parse(job.leaseExpiresAt) <= this.now()
    ) {
      return null;
    }
    return job;
  }
}

export interface JobProcessor<Payload = unknown, Result = unknown> {
  (job: WorkerJob<Payload, Result>): Promise<Result> | Result;
}

export interface RunOnceResult<Result = unknown> {
  status: "IDLE" | JobStatus;
  state: "IDLE" | JobStatus;
  job: WorkerJob | null;
  result: Result | null;
  error: string | null;
}

export class JobRunner<Payload = unknown, Result = unknown> {
  private readonly activeOrganizations = new Set<string>();

  public constructor(
    private readonly store: InMemoryJobStore<Payload, Result>,
    private readonly processor: JobProcessor<Payload, Result>,
  ) {}

  public async runOnce(): Promise<RunOnceResult<Result>> {
    const claimed = this.store.claimNext();
    if (claimed === null) {
      return { status: "IDLE", state: "IDLE", job: null, result: null, error: null };
    }
    if (this.activeOrganizations.has(claimed.organizationId)) {
      return { status: "IDLE", state: "IDLE", job: null, result: null, error: null };
    }
    this.activeOrganizations.add(claimed.organizationId);
    try {
      const result = await this.processor(claimed);
      const completed = this.store.complete({
        jobId: claimed.id,
        organizationId: claimed.organizationId,
        leaseToken: claimed.leaseToken ?? "",
        result,
      });
      if (completed === null) {
        const failed = this.store.markFailed({
          jobId: claimed.id,
          organizationId: claimed.organizationId,
          leaseToken: claimed.leaseToken ?? "",
          error: "Job lease was lost before completion",
        });
        return {
          status: "FAILED",
          state: "FAILED",
          job: failed ?? this.store.get(claimed.id, claimed.organizationId),
          result: null,
          error: "Job lease was lost before completion",
        };
      }
      return { status: "COMPLETED", state: "COMPLETED", job: completed, result, error: null };
    } catch (error: unknown) {
      const failed = this.store.fail({
        jobId: claimed.id,
        organizationId: claimed.organizationId,
        leaseToken: claimed.leaseToken ?? "",
        error,
        retryable: !(error instanceof NonRetryableJobError),
      });
      return {
        status: failed?.status ?? "FAILED",
        state: failed?.status ?? "FAILED",
        job: failed,
        result: null,
        error: normalizeError(error),
      };
    } finally {
      this.activeOrganizations.delete(claimed.organizationId);
    }
  }
}
