import { z } from "zod";

import type { PublishRequestRepository } from "@/lib/content/repository";
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
  constructor() {
    super("The n8n publish integration is not configured.");
    this.name = "N8nPublishConfigurationError";
  }
}

export class N8nPublishDeliveryError extends Error {
  constructor(status: number) {
    super(`n8n rejected the publish request with status ${status}.`);
    this.name = "N8nPublishDeliveryError";
  }
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

  const environment = dependencies.environment ?? process.env;
  const endpoint = environment.SNAPGAD_N8N_PUBLISH_URL;
  const secret = environment.SNAPGAD_N8N_SHARED_SECRET;
  if (!endpoint || !secret) throw new N8nPublishConfigurationError();

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
