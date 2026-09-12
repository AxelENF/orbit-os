import { describe, expect, it } from "vitest";

import { createCopyRetryHandler } from "@/app/api/content/[id]/copy/route";
import { CopyResultConflictError } from "@/lib/content/repository";

const contentId = "8ab76cc5-f59a-48ed-8bc8-186cc7007533";
const requestKey = "2cc4e6d7-4ccc-4b7b-8ddc-9988e6a4e5ff";

function requestWithKey(idempotencyKey: string = requestKey): Request {
  return new Request(`http://localhost/api/content/${contentId}/copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey }),
  });
}

const context = { params: Promise.resolve({ id: contentId }) };

describe("POST /api/content/[id]/copy", () => {
  it("queues a recoverable internal copy job with the caller's idempotency key", async () => {
    const enqueueCopyJob = async (input: { contentItemId: string; idempotencyKey: string }) => ({
      created: true,
      jobId: "6f1da566-7391-4d4a-a61d-3de88ca7e8ad",
      idempotencyKey: input.idempotencyKey,
    });
    const response = await createCopyRetryHandler({
      getRepository: async () => ({ enqueueCopyJob }),
    })(requestWithKey(), context);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      job: {
        created: true,
        jobId: "6f1da566-7391-4d4a-a61d-3de88ca7e8ad",
        idempotencyKey: requestKey,
      },
    });
  });

  it("does not enqueue when the durable state machine rejects the retry", async () => {
    const response = await createCopyRetryHandler({
      getRepository: async () => ({
        enqueueCopyJob: async () => {
          throw new CopyResultConflictError();
        },
      }),
    })(requestWithKey(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "COPY_RETRY_CONFLICT" });
  });
});
