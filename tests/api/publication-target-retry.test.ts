import { describe, expect, it, vi } from "vitest";

import { createRetryPublicationTargetHandler } from "@/app/api/content/[id]/targets/[targetId]/retry/route";
import { ContentAuthenticationError, ContentConfigurationError } from "@/lib/content/repository-factory";
import type { PublicationTarget } from "@/lib/content/repository";

const contentItemId = "00000000-0000-4000-8000-000000000001";
const publicationTargetId = "10000000-0000-4000-8000-000000000001";

const retriedTarget: PublicationTarget = {
  id: publicationTargetId,
  contentItemId,
  platform: "FACEBOOK",
  status: "APPROVED",
};

function request() {
  return new Request("https://orbit.example/api/content/retry", { method: "POST" });
}

function context() {
  return { params: Promise.resolve({ id: contentItemId, targetId: publicationTargetId }) };
}

describe("POST /api/content/[id]/targets/[targetId]/retry", () => {
  it("retries exactly the target from the route convention", async () => {
    const retryPublicationTarget = vi.fn().mockResolvedValue(retriedTarget);
    const response = await createRetryPublicationTargetHandler({
      getRepository: async () => ({ retryPublicationTarget }),
    })(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ target: retriedTarget });
    expect(retryPublicationTarget).toHaveBeenCalledWith(contentItemId, publicationTargetId);
  });

  it("maps missing authentication and configuration to safe API errors", async () => {
    const authentication = await createRetryPublicationTargetHandler({
      getRepository: async () => {
        throw new ContentAuthenticationError();
      },
    })(request(), context());
    const configuration = await createRetryPublicationTargetHandler({
      getRepository: async () => {
        throw new ContentConfigurationError();
      },
    })(request(), context());

    expect(authentication.status).toBe(401);
    expect(configuration.status).toBe(503);
  });
});
