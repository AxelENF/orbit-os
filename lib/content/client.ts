import type {
  ContentItem,
  ContentSummary,
  ContentRecord,
  FinalCopy,
  FinalCopySubmission,
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
