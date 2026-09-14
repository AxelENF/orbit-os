import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  type CancelDurableJobInput,
  type CompleteDurableJobInput,
  type DurableJob,
  type DurableJobHealth,
  type DurableJobMutationResult,
  type DurableJobWorkerStore,
  type FailDurableJobInput,
  type RenewDurableJobLeaseInput,
} from "@/lib/automation/durable-job-contract";

const claimResponseSchema = z.union([
  z.object({ state: z.literal("NOT_CLAIMABLE") }),
  z.object({
    state: z.literal("FAILED"),
    jobId: z.string().uuid(),
  }),
  z.object({
    state: z.literal("CLAIMED"),
    job: z.object({
      id: z.string().uuid(),
      organizationId: z.string().uuid(),
      kind: z.literal("COPY"),
      provider: z.string().min(1),
      idempotencyKey: z.string().uuid(),
      leaseToken: z.string().uuid(),
      leaseExpiresAt: z.string().datetime({ offset: true }),
      contentItemId: z.string().uuid(),
      storagePath: z.string().min(1),
      brief: z.record(z.string(), z.unknown()),
      attempts: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      runAt: z.string().datetime({ offset: true }),
      nextAttemptAt: z.string().datetime({ offset: true }),
      createdAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
      startedAt: z.string().datetime({ offset: true }),
    }),
  }),
]);

const leaseResponseSchema = z.union([
  z.object({ state: z.literal("NOT_RENEWED") }),
  z.object({
    state: z.literal("RENEWED"),
    leaseExpiresAt: z.string().datetime({ offset: true }),
  }),
]);

const failureResponseSchema = z.object({
  state: z.enum(["RETRY_WAIT", "FAILED", "DEAD_LETTER"]),
  jobId: z.string().uuid(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime({ offset: true }),
});

const cancelResponseSchema = z.union([
  z.object({ state: z.literal("NOT_FOUND") }),
  z.object({ state: z.literal("NOT_CANCELLABLE"), status: z.string().min(1) }),
  z.object({ state: z.literal("CANCELLED"), jobId: z.string().uuid() }),
]);

const recoveryResponseSchema = z.object({ recovered: z.number().int().nonnegative() });

const healthResponseSchema = z.object({
  queuedCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  activeLeaseCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  deadLetterCount: z.number().int().nonnegative(),
  queueLagMs: z.number().nonnegative(),
  lastSuccessfulRun: z.string().datetime({ offset: true }).nullable(),
});

export type SupabaseCopyJobPayload = {
  contentItemId: string;
  storagePath: string;
  assetUrl: string;
  brief: Record<string, unknown>;
};

export type SupabaseCopyWorkerStoreOptions = {
  signedUrlSeconds?: number;
  provider?: string;
};

type CopyDurableJob = DurableJob<SupabaseCopyJobPayload, Record<string, unknown>>;

function clone<T>(value: T): T {
  const structuredCloneFunction = (
    globalThis as typeof globalThis & {
      structuredClone?: <Value>(input: Value) => Value;
    }
  ).structuredClone;
  if (structuredCloneFunction) return structuredCloneFunction(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: { message?: string } | null | undefined): string {
  return error?.message ?? "";
}

function normalizeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.trim().slice(0, 2000) || "Unknown worker error";
}

function requireUuid(value: string, name: string): void {
  if (!z.string().uuid().safeParse(value).success) {
    throw new Error(`${name} must be a UUID.`);
  }
}

function leaseSeconds(leaseDurationMs: number | undefined): number {
  if (leaseDurationMs === undefined) return 600;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs < 30_000 || leaseDurationMs > 3_600_000) {
    throw new Error("leaseDurationMs must be between 30000 and 3600000 milliseconds.");
  }
  return Math.ceil(leaseDurationMs / 1000);
}

/**
 * Supabase adapter for the worker-only side of copy jobs. The Next route uses
 * the `.server` guarded re-export; this core module is intentionally importable
 * by the standalone Node worker.
 *
 * Enqueue remains portal-owned by `SupabaseContentRepository`; this adapter
 * cannot create work or select an arbitrary tenant. A short-lived cache only
 * carries the claimed job between lease mutations; Postgres remains the source
 * of truth and the cache is discarded on process restart.
 */
export class SupabaseCopyWorkerStore
  implements DurableJobWorkerStore<SupabaseCopyJobPayload, Record<string, unknown>>
{
  private readonly claimed = new Map<string, CopyDurableJob>();
  private readonly signedUrlSeconds: number;
  private readonly provider: string;

  constructor(
    private readonly client: SupabaseClient,
    options: SupabaseCopyWorkerStoreOptions = {},
  ) {
    this.signedUrlSeconds = options.signedUrlSeconds ?? 600;
    this.provider = options.provider ?? "local";
    if (!Number.isInteger(this.signedUrlSeconds) || this.signedUrlSeconds < 60 || this.signedUrlSeconds > 3600) {
      throw new Error("signedUrlSeconds must be an integer between 60 and 3600.");
    }
    if (!this.provider.trim() || this.provider.length > 100) {
      throw new Error("provider must be a non-empty key of at most 100 characters.");
    }
  }

  async claimNext(input: { organizationId?: string } = {}): Promise<DurableJobMutationResult<SupabaseCopyJobPayload, Record<string, unknown>>> {
    if (input.organizationId !== undefined) requireUuid(input.organizationId, "organizationId");
    const { data, error } = await this.client.rpc("claim_next_copy_automation_job", {
      p_provider: this.provider,
      p_organization_id: input.organizationId ?? null,
    });
    if (error) throw new Error("Unable to claim a durable copy job.");
    const parsed = claimResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Supabase returned an invalid durable copy job claim.");
    if (parsed.data.state !== "CLAIMED") return null;

    const signed = await this.client.storage
      .from("content-assets")
      .createSignedUrl(parsed.data.job.storagePath, this.signedUrlSeconds);
    if (signed.error || !signed.data?.signedUrl) {
      await this.failUncachedClaim(parsed.data.job).catch(() => undefined);
      throw new Error("Unable to create a signed copy-job asset URL.");
    }

    const now = new Date().toISOString();
    const job: CopyDurableJob = {
      id: parsed.data.job.id,
      organizationId: parsed.data.job.organizationId,
      kind: parsed.data.job.kind,
      provider: parsed.data.job.provider,
      payload: {
        contentItemId: parsed.data.job.contentItemId,
        storagePath: parsed.data.job.storagePath,
        assetUrl: signed.data.signedUrl,
        brief: clone(parsed.data.job.brief),
      },
      idempotencyKey: parsed.data.job.idempotencyKey,
      status: "PROCESSING",
      attempts: parsed.data.job.attempts,
      maxAttempts: parsed.data.job.maxAttempts,
      runAt: parsed.data.job.runAt,
      nextAttemptAt: parsed.data.job.nextAttemptAt,
      leaseToken: parsed.data.job.leaseToken,
      leaseExpiresAt: parsed.data.job.leaseExpiresAt,
      lastError: null,
      createdAt: parsed.data.job.createdAt,
      updatedAt: parsed.data.job.updatedAt || now,
      startedAt: parsed.data.job.startedAt,
      completedAt: null,
    };
    this.claimed.set(job.id, job);
    return clone(job);
  }

  async renewLease(input: RenewDurableJobLeaseInput): Promise<DurableJobMutationResult<SupabaseCopyJobPayload, Record<string, unknown>>> {
    requireUuid(input.jobId, "jobId");
    requireUuid(input.organizationId, "organizationId");
    requireUuid(input.leaseToken, "leaseToken");
    const claimedJob = this.claimed.get(input.jobId);
    if (!claimedJob || claimedJob.organizationId !== input.organizationId || claimedJob.leaseToken !== input.leaseToken) {
      return null;
    }
    const { data, error } = await this.client.rpc("renew_copy_automation_job", {
      p_job_id: input.jobId,
      p_idempotency_key: claimedJob.idempotencyKey,
      p_lease_token: input.leaseToken,
      p_lease_seconds: leaseSeconds(input.leaseDurationMs),
    });
    if (error) throw new Error("Unable to renew the durable copy job lease.");
    const parsed = leaseResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Supabase returned an invalid lease response.");
    if (parsed.data.state === "NOT_RENEWED") return null;
    claimedJob.leaseExpiresAt = parsed.data.leaseExpiresAt;
    claimedJob.updatedAt = new Date().toISOString();
    return clone(claimedJob);
  }

  async complete(input: CompleteDurableJobInput<Record<string, unknown>>): Promise<DurableJobMutationResult<SupabaseCopyJobPayload, Record<string, unknown>>> {
    const job = this.requireClaim(input.jobId, input.organizationId, input.leaseToken);
    const { data, error } = await this.client.rpc("complete_copy_automation_job", {
      p_job_id: input.jobId,
      p_idempotency_key: job.idempotencyKey,
      p_lease_token: input.leaseToken,
      p_result: input.result ?? {},
    });
    if (error) {
      if (errorMessage(error) === "COPY_JOB_NOT_FOUND" || errorMessage(error) === "COPY_JOB_LEASE_INVALID") {
        this.claimed.delete(input.jobId);
        return null;
      }
      throw new Error("Unable to complete the durable copy job.");
    }
    if (!z.object({ created: z.boolean() }).safeParse(data).success) {
      throw new Error("Supabase returned an invalid copy job completion.");
    }
    job.status = "COMPLETED";
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.result = clone(input.result ?? {});
    this.claimed.delete(input.jobId);
    return clone(job);
  }

  async fail(input: FailDurableJobInput): Promise<DurableJobMutationResult<SupabaseCopyJobPayload, Record<string, unknown>>> {
    const job = this.requireClaim(input.jobId, input.organizationId, input.leaseToken);
    const { data, error } = await this.client.rpc("fail_copy_automation_job", {
      p_job_id: input.jobId,
      p_idempotency_key: job.idempotencyKey,
      p_lease_token: input.leaseToken,
      p_error: normalizeError(input.error),
      p_retryable: input.retryable !== false,
    });
    if (error) {
      if (errorMessage(error) === "COPY_JOB_NOT_FOUND" || errorMessage(error) === "COPY_JOB_LEASE_INVALID") {
        this.claimed.delete(input.jobId);
        return null;
      }
      throw new Error("Unable to fail the durable copy job.");
    }
    const parsed = failureResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Supabase returned an invalid copy job failure.");
    job.status = parsed.data.state;
    job.attempts = parsed.data.attempts;
    job.nextAttemptAt = parsed.data.nextAttemptAt;
    job.lastError = normalizeError(input.error);
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = new Date().toISOString();
    this.claimed.delete(input.jobId);
    return clone(job);
  }

  async cancel(input: CancelDurableJobInput): Promise<DurableJobMutationResult<SupabaseCopyJobPayload, Record<string, unknown>>> {
    requireUuid(input.jobId, "jobId");
    requireUuid(input.organizationId, "organizationId");
    if (input.idempotencyKey !== undefined) requireUuid(input.idempotencyKey, "idempotencyKey");
    if (input.leaseToken !== undefined && input.leaseToken !== null) requireUuid(input.leaseToken, "leaseToken");
    if (input.reason !== undefined && (input.reason.trim().length === 0 || input.reason.length > 500)) {
      throw new Error("reason must be between 1 and 500 characters.");
    }
    const job = this.claimed.get(input.jobId);
    if (job && (job.organizationId !== input.organizationId || (input.leaseToken && job.leaseToken !== input.leaseToken))) {
      return null;
    }
    const idempotencyKey = job?.idempotencyKey ?? input.idempotencyKey;
    if (!idempotencyKey) return null;
    const { data, error } = await this.client.rpc("cancel_copy_automation_job", {
      p_job_id: input.jobId,
      p_idempotency_key: idempotencyKey,
      p_lease_token: input.leaseToken ?? null,
      p_reason: input.reason ?? "Cancelled by operator",
    });
    if (error) {
      if (errorMessage(error) === "COPY_JOB_LEASE_INVALID") return null;
      throw new Error("Unable to cancel the durable copy job.");
    }
    const parsed = cancelResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Supabase returned an invalid copy job cancellation.");
    if (parsed.data.state !== "CANCELLED" || !job) return null;
    job.status = "CANCELLED";
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.cancelledAt = new Date().toISOString();
    job.updatedAt = job.cancelledAt;
    this.claimed.delete(input.jobId);
    return clone(job);
  }

  async recoverExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("limit must be an integer between 1 and 1000.");
    }
    const { data, error } = await this.client.rpc("recover_expired_copy_automation_jobs", { p_limit: limit });
    if (error) throw new Error("Unable to recover expired durable copy jobs.");
    const parsed = recoveryResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Supabase returned an invalid recovery response.");

    // DurableJobRunner invokes recoverExpired at startup and on every recovery
    // interval. Keep OAuth cleanup here so abandoned token-bearing sessions use
    // the existing periodic worker maintenance without a new scheduler.
    try {
      const { error: cleanupError } = await this.client.rpc("delete_expired_meta_oauth_sessions", {
        p_limit: limit,
      });
      if (cleanupError) {
        console.error(JSON.stringify({
          message: "Unable to clean expired Meta OAuth sessions.",
          error: normalizeError(cleanupError.message),
        }));
      }
    } catch (error: unknown) {
      console.error(JSON.stringify({
        message: "Unable to clean expired Meta OAuth sessions.",
        error: normalizeError(error),
      }));
    }

    return parsed.data.recovered;
  }

  async health(): Promise<DurableJobHealth> {
    const { data, error } = await this.client.rpc("summarize_copy_automation_jobs");
    if (error) throw new Error("Unable to read durable copy worker health.");
    const parsed = healthResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Supabase returned invalid durable worker health.");
    return parsed.data;
  }

  private requireClaim(jobId: string, organizationId: string, leaseToken: string): CopyDurableJob {
    requireUuid(jobId, "jobId");
    requireUuid(organizationId, "organizationId");
    requireUuid(leaseToken, "leaseToken");
    const job = this.claimed.get(jobId);
    if (!job || job.organizationId !== organizationId || job.leaseToken !== leaseToken) {
      throw new Error("The durable copy job lease is not owned by this worker.");
    }
    return job;
  }

  private async failUncachedClaim(job: {
    id: string;
    idempotencyKey: string;
    leaseToken: string;
  }): Promise<void> {
    await this.client.rpc("fail_copy_automation_job", {
      p_job_id: job.id,
      p_idempotency_key: job.idempotencyKey,
      p_lease_token: job.leaseToken,
      p_error: "COPY_JOB_ASSET_URL_FAILED",
      p_retryable: true,
    });
  }
}

export function createSupabaseCopyWorkerStore(
  client: SupabaseClient,
  options?: SupabaseCopyWorkerStoreOptions,
): SupabaseCopyWorkerStore {
  return new SupabaseCopyWorkerStore(client, options);
}
