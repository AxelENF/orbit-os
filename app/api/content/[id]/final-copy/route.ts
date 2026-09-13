import { z } from "zod";

import {
  CopyResultConflictError,
  type ContentRepository,
  type FinalCopy,
} from "@/lib/content/repository";
import {
  ContentAuthenticationError,
  ContentConfigurationError,
  createContentRepository,
} from "@/lib/content/repository-factory";

const contentIdSchema = z.string().uuid();
const finalCopySchema = z.object({
  selectedCopyDraftId: z.string().uuid().optional(),
  headline: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(5000),
  cta: z.string().trim().min(1).max(240),
  hashtags: z.array(z.string().trim().min(1)).max(8).optional(),
});
const MAX_REQUEST_BYTES = 16_000;

type FinalCopyHandlerDependencies = {
  getRepository?: () => Promise<
    Pick<
      ContentRepository,
      | "getContentRecord"
      | "submitFinalCopyForReview"
      | "applyPublicationDiagnosisForContentItem"
    >
  >;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function isSameFinalCopy(
  stored: FinalCopy,
  submitted: z.infer<typeof finalCopySchema>,
): boolean {
  const submittedHashtags = (submitted.hashtags ?? []).map((tag) => tag.trim());
  return stored.selectedCopyDraftId === submitted.selectedCopyDraftId &&
    stored.headline === submitted.headline.trim() &&
    stored.body === submitted.body.trim() &&
    stored.cta === submitted.cta.trim() &&
    stored.hashtags.length === submittedHashtags.length &&
    stored.hashtags.every((tag, index) => tag === submittedHashtags[index]);
}

export function createFinalCopySubmissionHandler(
  dependencies: FinalCopyHandlerDependencies = {},
): (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleFinalCopySubmission(request, context): Promise<Response> {
    const params = await context.params;
    const contentItemId = contentIdSchema.safeParse(params.id);
    if (!contentItemId.success) return jsonError("INVALID_CONTENT_ID", 400);

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return jsonError("REQUEST_TOO_LARGE", 413);
    }
    let rawPayload: string;
    try {
      rawPayload = await request.text();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    if (new TextEncoder().encode(rawPayload).byteLength > MAX_REQUEST_BYTES) {
      return jsonError("REQUEST_TOO_LARGE", 413);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    const finalCopy = finalCopySchema.safeParse(payload);
    if (!finalCopy.success) return jsonError("INVALID_FINAL_COPY", 400);

    const repository = await getRepository();
    try {
      const result = await repository.submitFinalCopyForReview(
        contentItemId.data,
        finalCopy.data,
      );
      try {
        await repository.applyPublicationDiagnosisForContentItem(contentItemId.data, result);
      } catch (diagnosisError) {
        console.error(JSON.stringify({
          message: "publication diagnosis failed",
          contentItemId: contentItemId.data,
          error: String(diagnosisError),
        }));
      }
      return Response.json({ finalCopy: result }, { status: 201 });
    } catch (error) {
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      if (error instanceof CopyResultConflictError) {
        try {
          const record = await repository.getContentRecord(contentItemId.data);
          if (record?.finalCopy && isSameFinalCopy(record.finalCopy, finalCopy.data)) {
            return Response.json({ finalCopy: record.finalCopy, reconciled: true });
          }
        } catch {
          // A read failure cannot turn a conflicting immutable submission into success.
        }
        return jsonError("FINAL_COPY_NOT_REVIEWABLE", 409);
      }
      return jsonError("FINAL_COPY_SUBMISSION_FAILED", 500);
    }
  };
}

export const POST = createFinalCopySubmissionHandler();
