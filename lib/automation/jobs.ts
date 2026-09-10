import type { CopyResultCallback } from "@/lib/content/repository";

export const AUTOMATION_JOB_STATUSES = [
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;

export type AutomationJobStatus = (typeof AUTOMATION_JOB_STATUSES)[number];

export type ClaimedCopyJob = {
  id: string;
  idempotencyKey: string;
  leaseToken: string;
  leaseExpiresAt: string;
  contentItemId: string;
  assetUrl: string;
  brief: Record<string, unknown>;
};

export type CopyJobClaim =
  | { state: "CLAIMED"; job: ClaimedCopyJob }
  | { state: "NOT_CLAIMABLE" };

export type CopyJobEnqueue = {
  created: boolean;
  jobId: string;
  idempotencyKey: string;
};

/**
 * The portal owns copy jobs. n8n only receives a job reference, claims the
 * server-derived payload, and returns a result under a short-lived lease.
 */
export interface CopyJobEnqueueRepository {
  enqueueCopyJob(input: {
    contentItemId: string;
    idempotencyKey: string;
  }): Promise<CopyJobEnqueue>;
}

export interface CopyJobRepository
  extends CopyJobEnqueueRepository,
    CopyJobWorkerRepository {}

export interface CopyJobWorkerRepository {
  claimCopyJob(input: {
    jobId: string;
    idempotencyKey: string;
  }): Promise<CopyJobClaim>;
  completeCopyJob(input: {
    jobId: string;
    idempotencyKey: string;
    leaseToken: string;
    result: Omit<CopyResultCallback, "contentItemId" | "idempotencyKey">;
  }): Promise<{ created: boolean }>;
}
