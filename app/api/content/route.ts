import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ContentAuthenticationError,
  ContentConfigurationError,
  createContentRepository,
} from "@/lib/content/repository-factory";
import { campaignBriefSchema } from "@/lib/content/campaign";
import { AssetValidationError, MAX_ASSET_BYTES, validateAsset } from "@/lib/content/asset-validation";
import type { ContentRepository } from "@/lib/content/repository";

type ContentListHandlerDependencies = {
  getRepository?: () => Promise<
    Pick<ContentRepository, "listContentItems"> &
      Partial<Pick<ContentRepository, "listContentSummaries">>
  >;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createContentListHandler(
  dependencies: ContentListHandlerDependencies = {},
): () => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleContentList(): Promise<Response> {
    try {
      const repository = await getRepository();
      const items = repository.listContentSummaries
        ? await repository.listContentSummaries()
        : await repository.listContentItems();
      return Response.json({ items });
    } catch (error) {
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      return jsonError("CONTENT_LIST_FAILED", 500);
    }
  };
}

export const GET = createContentListHandler();

const MAX_MULTIPART_BYTES = MAX_ASSET_BYTES + 64_000;

type ContentCreateHandlerDependencies = {
  getRepository?: () => Promise<
    Pick<ContentRepository, "createContentItemWithAsset" | "enqueueCopyJob">
  >;
  createId?: () => string;
};

function isFilePart(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value &&
      typeof value !== "string" &&
      typeof value.arrayBuffer === "function" &&
      typeof value.name === "string",
  );
}

export function createContentCreateHandler(
  dependencies: ContentCreateHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;
  const createId = dependencies.createId ?? randomUUID;

  return async function handleContentCreate(request: Request): Promise<Response> {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
      return jsonError("ASSET_TOO_LARGE", 413);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("INVALID_MULTIPART_REQUEST", 400);
    }

    const rawBrief = formData.get("brief");
    const assetFile = formData.get("asset");
    if (typeof rawBrief !== "string" || !isFilePart(assetFile)) {
      return jsonError("BRIEF_AND_ASSET_REQUIRED", 400);
    }

    let briefPayload: unknown;
    try {
      briefPayload = JSON.parse(rawBrief);
    } catch {
      return jsonError("INVALID_BRIEF", 400);
    }

    try {
      const brief = campaignBriefSchema.parse(briefPayload);
      const validatedAsset = await validateAsset(assetFile);
      const checksum = createHash("sha256")
        .update(validatedAsset.bytes)
        .digest("hex");
      const repository = await getRepository();
      const content = await repository.createContentItemWithAsset({
        brief,
        asset: {
          id: createId(),
          filename: assetFile.name,
          mimeType: validatedAsset.mimeType,
          width: validatedAsset.width,
          height: validatedAsset.height,
          checksum,
          bytes: validatedAsset.bytes,
        },
      });
      try {
        await repository.enqueueCopyJob({
          contentItemId: content.id,
          idempotencyKey: createId(),
        });
      } catch {
        // Asset persistence is durable even when the queue is temporarily
        // unavailable. Return the id so the user can retry from the draft
        // screen instead of silently creating an unreachable orphan.
        return Response.json(
          { content, warning: "COPY_QUEUE_PENDING" },
          { status: 202 },
        );
      }
      return Response.json({ content: { ...content, state: "GENERATING" } }, { status: 201 });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof AssetValidationError) {
        return jsonError("INVALID_CONTENT_ASSET", 400);
      }
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      return jsonError("CONTENT_CREATE_FAILED", 500);
    }
  };
}

export const POST = createContentCreateHandler();
