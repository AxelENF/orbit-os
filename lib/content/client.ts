import type {
  ContentItem,
  ContentSummary,
  ContentRecord,
  FinalCopy,
  FinalCopySubmission,
  ManualPublicationDeliveryInput,
  PublicationResult,
  PublicationResultInput,
  PublicationTarget,
} from "@/lib/content/repository";

export class ContentClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "ContentClientError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | T | null;
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "CONTENT_REQUEST_FAILED";
    throw new ContentClientError(code, response.status);
  }
  return payload as T;
}

export async function listContentItems(): Promise<ContentItem[]> {
  const response = await fetch("/api/content", { credentials: "same-origin" });
  const payload = await readJson<{ items: ContentItem[] }>(response);
  return payload.items;
}

export async function listContentSummaries(): Promise<ContentSummary[]> {
  const response = await fetch("/api/content", { credentials: "same-origin" });
  const payload = await readJson<{ items: ContentSummary[] }>(response);
  return payload.items;
}

export async function getContentRecord(contentItemId: string): Promise<ContentRecord> {
  const response = await fetch(`/api/content/${contentItemId}`, { credentials: "same-origin" });
  return readJson<ContentRecord>(response);
}

export async function approveContentTarget(
  contentItemId: string,
  target: PublicationTarget,
): Promise<PublicationTarget> {
  const response = await fetch(
    `/api/content/${contentItemId}/targets/${target.id}/approve`,
    { method: "POST", credentials: "same-origin" },
  );
  const payload = await readJson<{ target: PublicationTarget }>(response);
  return payload.target;
}

export async function retryContentTarget(
  contentItemId: string,
  targetId: string,
): Promise<PublicationTarget> {
  const response = await fetch(
    `/api/content/${contentItemId}/targets/${targetId}/retry`,
    { method: "POST", credentials: "same-origin" },
  );
  const payload = await readJson<{ target: PublicationTarget }>(response);
  return payload.target;
}

export async function recordManualPublicationDelivery(
  input: ManualPublicationDeliveryInput,
): Promise<PublicationTarget> {
  const response = await fetch(
    `/api/content/${input.contentItemId}/targets/${input.publicationTargetId}/manual-delivery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        remoteUrl: input.remoteUrl,
        publishedAt: input.publishedAt,
        ...(input.note ? { note: input.note } : {}),
        idempotencyKey: input.idempotencyKey,
      }),
    },
  );
  const payload = await readJson<{ target: PublicationTarget }>(response);
  return payload.target;
}

export async function recordPublicationResult(
  input: PublicationResultInput,
): Promise<PublicationResult> {
  const response = await fetch(
    `/api/content/${input.contentItemId}/targets/${input.publicationTargetId}/result`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        observedAt: input.observedAt,
        reach: input.reach,
        impressions: input.impressions,
        conversations: input.conversations,
        qualifiedLeads: input.qualifiedLeads,
        appointments: input.appointments,
        spendMxn: input.spendMxn,
        ...(input.revenueMxn === undefined ? {} : { revenueMxn: input.revenueMxn }),
        ...(input.note ? { note: input.note } : {}),
        idempotencyKey: input.idempotencyKey,
      }),
    },
  );
  const payload = await readJson<{ result: PublicationResult }>(response);
  return payload.result;
}

export async function submitFinalCopy(
  contentItemId: string,
  input: FinalCopySubmission,
): Promise<FinalCopy> {
  const response = await fetch(`/api/content/${contentItemId}/final-copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  const payload = await readJson<{ finalCopy: FinalCopy }>(response);
  return payload.finalCopy;
}
