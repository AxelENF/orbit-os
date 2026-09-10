import "server-only";

import { z } from "zod";

import type {
  PublishRequestRepository,
} from "@/lib/content/repository";
import type { CopyJobEnqueueRepository } from "@/lib/automation/jobs";
import { signN8nPayload } from "@/lib/integrations/n8n-signature";

const requiredText = z.string().trim().min(1).max(10_000);

export const n8nPublishRequestInputSchema = z
  .object({
    contentItemId: z.string().uuid(),
    publicationTargetId: z.string().uuid(),
    assetUrl: z
      .url()
      .max(2_000)
      .refine((value) => new URL(value).protocol === "https:"),
    idempotencyKey: z.string().uuid().optional(),
    copy: z
      .object({
        headline: z.string().trim().max(500).optional(),
        body: requiredText,
        cta: z.string().trim().min(1).max(500),
      })
      .strict(),
  })
  .strict();

type N8nClientEnvironment = Record<string, string | undefined>;

function requireHttpsEndpoint(value: string | undefined, name: string): string {
  if (!value) throw new N8nPublishConfigurationError(name);
  try {
    if (new URL(value).protocol !== "https:") {
      throw new Error("not https");
    }
  } catch {
    throw new N8nPublishConfigurationError(name);
  }
  return value;
}

type RequestN8nPublishDependencies = {
  repository: PublishRequestRepository;
  environment?: N8nClientEnvironment;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  createId?: () => string;
};

export type N8nPublishRequestResult = {
  created: boolean;
  status: "DRY_RUN_QUEUED" | "QUEUED";
  idempotencyKey: string;
  publicationTargetId: string;
  platform: "FACEBOOK" | "INSTAGRAM";
};

export class N8nPublishConfigurationError extends Error {
  constructor(integration = "publish") {
    super(`The n8n ${integration} integration is not configured.`);
    this.name = "N8nPublishConfigurationError";
  }
}

export class N8nPublishDeliveryError extends Error {
  constructor(status: number) {
    super(`n8n rejected the publish request with status ${status}.`);
    this.name = "N8nPublishDeliveryError";
  }
}

export const n8nCopyRequestInputSchema = z
  .object({
    contentItemId: z.string().uuid(),
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

type RequestN8nCopyDependencies = {
  repository: CopyJobEnqueueRepository;
  environment?: N8nClientEnvironment;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  createId?: () => string;
};

export type N8nCopyRequestResult = {
  created: boolean;
  status: "DRY_RUN_QUEUED" | "QUEUED" | "DELIVERY_UNCONFIRMED";
  idempotencyKey: string;
  jobId: string;
  contentItemId: string;
};

/** Begins a copy job in the portal before sending the signed n8n request. */
export async function requestN8nCopy(
  input: unknown,
  dependencies: RequestN8nCopyDependencies,
): Promise<N8nCopyRequestResult> {
  const parsed = n8nCopyRequestInputSchema.parse(input);
  const environment = dependencies.environment ?? process.env;
  const idempotencyKey = parsed.idempotencyKey ??
    (dependencies.createId ?? crypto.randomUUID)();
  const endpoint = environment.SNAPGAD_N8N_COPY_URL;
  const secret = environment.SNAPGAD_N8N_SHARED_SECRET;
  const isDemo = !environment.NEXT_PUBLIC_SUPABASE_URL &&
    !environment.SUPABASE_SERVICE_ROLE_KEY;

  if (!endpoint || !secret) {
    if (!isDemo) throw new N8nPublishConfigurationError("copy");
    const job = await dependencies.repository.enqueueCopyJob({
      contentItemId: parsed.contentItemId,
      idempotencyKey,
    });
    return {
      created: job.created,
      status: "DRY_RUN_QUEUED",
      idempotencyKey,
      jobId: job.jobId,
      contentItemId: parsed.contentItemId,
    };
  }

  const copyEndpoint = requireHttpsEndpoint(endpoint, "copy");
  const job = await dependencies.repository.enqueueCopyJob({
    contentItemId: parsed.contentItemId,
    idempotencyKey,
  });
  const payload = {
    jobId: job.jobId,
    idempotencyKey,
  };
  const timestamp = String(
    Math.floor((dependencies.nowMs ?? Date.now)() / 1_000),
  );
  try {
    const response = await (dependencies.fetchFn ?? fetch)(
      copyEndpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-snapgad-timestamp": timestamp,
          "x-snapgad-signature": signN8nPayload(payload, timestamp, secret),
        },
        body: JSON.stringify(payload),
      },
    );
    if (response.ok) {
      return {
        created: job.created,
        status: "QUEUED",
        idempotencyKey,
        jobId: job.jobId,
        contentItemId: parsed.contentItemId,
      };
    }
  } catch {
    // The request can reach n8n even if its response is lost. Preserve the key for a safe retry.
  }

  return {
    created: job.created,
    status: "DELIVERY_UNCONFIRMED",
    idempotencyKey,
    jobId: job.jobId,
    contentItemId: parsed.contentItemId,
  };
}

/**
 * Validates approval against repository state before signing a target-specific
 * request. A demo repository returns DRY_RUN_QUEUED and short-circuits fetch.
 */
export async function requestN8nPublish(
  input: unknown,
  dependencies: RequestN8nPublishDependencies,
): Promise<N8nPublishRequestResult> {
  const parsed = n8nPublishRequestInputSchema.parse(input);
  const environment = dependencies.environment ?? process.env;
  const isDemo = !environment.NEXT_PUBLIC_SUPABASE_URL &&
    !environment.SUPABASE_SERVICE_ROLE_KEY;

  // Publication is intentionally fail-closed until tenant Meta credentials,
  // target-scoped leases, and the reviewed worker are staged and enabled.
  // Demo mode still records a local dry-run for UI tests without any network.
  if (!isDemo && environment.SNAPGAD_PUBLISH_WORKER_ENABLED !== "true") {
    throw new N8nPublishConfigurationError("publish");
  }

  const idempotencyKey = parsed.idempotencyKey ??
    (dependencies.createId ?? crypto.randomUUID)();
  const preparation = await dependencies.repository.preparePublishRequest({
    contentItemId: parsed.contentItemId,
    publicationTargetId: parsed.publicationTargetId,
    idempotencyKey,
  });

  if (preparation.status === "DRY_RUN_QUEUED") {
    return {
      created: preparation.created,
      status: "DRY_RUN_QUEUED",
      idempotencyKey,
      publicationTargetId: preparation.target.id,
      platform: preparation.target.platform,
    };
  }

  const endpoint = requireHttpsEndpoint(
    environment.SNAPGAD_N8N_PUBLISH_URL,
    "publish",
  );
  const secret = environment.SNAPGAD_N8N_SHARED_SECRET;
  if (!secret) throw new N8nPublishConfigurationError();

  const payload = {
    contentItemId: parsed.contentItemId,
    publicationTargetId: preparation.target.id,
    ownerId: preparation.ownerId,
    platform: preparation.target.platform,
    assetUrl: parsed.assetUrl,
    idempotencyKey,
    approvalState: "APPROVED" as const,
    approvedAt: preparation.approvedAt,
    approvedBy: preparation.ownerId,
    copy: parsed.copy,
  };
  const timestamp = String(
    Math.floor((dependencies.nowMs ?? Date.now)() / 1_000),
  );
  const response = await (dependencies.fetchFn ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-snapgad-timestamp": timestamp,
      "x-snapgad-signature": signN8nPayload(payload, timestamp, secret),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new N8nPublishDeliveryError(response.status);

  return {
    created: preparation.created,
    status: "QUEUED",
    idempotencyKey,
    publicationTargetId: preparation.target.id,
    platform: preparation.target.platform,
  };
}
