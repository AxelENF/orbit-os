import type {
  DurableJob,
  DurableJobMutationResult,
  DurableJobStatus,
  DurableJobWorkerStore,
} from "@/lib/automation/durable-job-contract";

export type DurableJobProcessor<Payload = unknown, Result = unknown> = (
  job: DurableJob<Payload, Result>,
) => Result | Promise<Result>;

export type DurableWorkerLogger = {
  info?: (message: string, metadata?: Record<string, unknown>) => void;
  error?: (message: string, metadata?: Record<string, unknown>) => void;
};

export type DurableWorkerOptions = {
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  recoveryIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  logger?: DurableWorkerLogger;
  isRetryable?: (error: unknown) => boolean;
};

export type DurableRunOnceResult<Result = unknown> = {
  status: "IDLE" | DurableJobStatus;
  state: "IDLE" | DurableJobStatus;
  job: DurableJob | null;
  result: Result | null;
  error: string | null;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_DURATION_MS = 600_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 300_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;

function validateDuration(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum} milliseconds.`);
  }
}

function normalizeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.trim().slice(0, 2_000) || "Unknown worker error";
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true },
    );
  });
}

/**
 * Persistent polling loop for the portal-owned durable store.
 *
 * The processor is deliberately injected: this runner owns scheduling and
 * lease safety, while OpenRouter/Meta/n8n providers remain separate adapters.
 * A single process runs one claim at a time; Postgres additionally prevents
 * concurrent COPY claims for the same organization.
 */
export class DurableJobRunner<Payload = unknown, Result = unknown> {
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly logger: DurableWorkerLogger;
  private readonly isRetryable: (error: unknown) => boolean;
  private running = false;
  private stopController: AbortController | null = null;

  public constructor(
    private readonly store: DurableJobWorkerStore<Payload, Result>,
    private readonly processor: DurableJobProcessor<Payload, Result>,
    options: DurableWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? {};
    this.isRetryable = options.isRetryable ?? (() => true);

    validateDuration(this.pollIntervalMs, "pollIntervalMs", 250, 300_000);
    validateDuration(this.leaseDurationMs, "leaseDurationMs", 30_000, 3_600_000);
    validateDuration(this.heartbeatIntervalMs, "heartbeatIntervalMs", 1_000, 3_590_000);
    validateDuration(this.recoveryIntervalMs, "recoveryIntervalMs", 1_000, 3_600_000);
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error("heartbeatIntervalMs must be shorter than leaseDurationMs.");
    }
  }

  /** Request a graceful stop after the current processor call settles. */
  public stop(): void {
    this.stopController?.abort();
  }

  public async runOnce(): Promise<DurableRunOnceResult<Result>> {
    const claimed = await this.store.claimNext();
    if (claimed === null) {
      return { status: "IDLE", state: "IDLE", job: null, result: null, error: null };
    }

    const leaseToken = claimed.leaseToken;
    if (!leaseToken) {
      const error = "Claimed durable job did not include a lease token.";
      this.logger.error?.(error, { jobId: claimed.id, organizationId: claimed.organizationId });
      return { status: "FAILED", state: "FAILED", job: claimed, result: null, error };
    }

    let leaseLost = false;
    let pendingRenewal: Promise<void> | null = null;
    const renew = () => {
      if (pendingRenewal) return;
      const attempt = Promise.resolve(
        this.store.renewLease({
          jobId: claimed.id,
          organizationId: claimed.organizationId,
          leaseToken,
          leaseDurationMs: this.leaseDurationMs,
        }),
      )
        .then((renewed) => {
          if (renewed === null) leaseLost = true;
        })
        .catch((error: unknown) => {
          leaseLost = true;
          this.logger.error?.("Durable job lease renewal failed.", {
            jobId: claimed.id,
            organizationId: claimed.organizationId,
            error: normalizeError(error),
          });
        });
      pendingRenewal = attempt;
      void attempt.finally(() => {
        if (pendingRenewal === attempt) pendingRenewal = null;
      });
    };
    const heartbeat = setInterval(renew, this.heartbeatIntervalMs);
    const settleHeartbeat = async () => {
      if (pendingRenewal) await pendingRenewal;
    };

    try {
      const result = await this.processor(claimed);
      await settleHeartbeat();
      const completed = await this.store.complete({
        jobId: claimed.id,
        organizationId: claimed.organizationId,
        leaseToken,
        result,
      });
      if (completed === null) {
        const error = leaseLost
          ? "Durable job lease was lost before completion."
          : "Durable job completion was rejected.";
        this.logger.error?.(error, { jobId: claimed.id, organizationId: claimed.organizationId });
        return {
          status: "FAILED",
          state: "FAILED",
          job: completed ?? claimed,
          result: null,
          error,
        };
      }
      return { status: "COMPLETED", state: "COMPLETED", job: completed, result, error: null };
    } catch (error: unknown) {
      await settleHeartbeat();
      let failed: DurableJobMutationResult<Payload, Result> = null;
      try {
        failed = await this.store.fail({
          jobId: claimed.id,
          organizationId: claimed.organizationId,
          leaseToken,
          error,
          retryable: this.isRetryable(error),
        });
      } catch (failureError: unknown) {
        this.logger.error?.("Durable job failure could not be persisted.", {
          jobId: claimed.id,
          organizationId: claimed.organizationId,
          error: normalizeError(failureError),
        });
      }
      return {
        status: failed?.status ?? "FAILED",
        state: failed?.status ?? "FAILED",
        job: failed,
        result: null,
        error: normalizeError(error),
      };
    } finally {
      clearInterval(heartbeat);
    }
  }

  public async runUntilStopped(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Durable job runner is already running.");
    this.running = true;
    const controller = new AbortController();
    this.stopController = controller;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    let recoveryInitialized = false;

    try {
      while (!controller.signal.aborted) {
        const now = this.now();
        if (
          !recoveryInitialized ||
          now - (this.lastRecoveryAt ?? now) >= this.recoveryIntervalMs
        ) {
          if (this.store.recoverExpired) await this.store.recoverExpired();
          this.lastRecoveryAt = now;
          recoveryInitialized = true;
        }
        const outcome = await this.runOnce();
        if (outcome.status === "IDLE") await this.sleep(this.pollIntervalMs, controller.signal);
      }
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.stopController === controller) this.stopController = null;
      this.running = false;
    }
  }

  private lastRecoveryAt: number | null = null;
}
