import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPublishResultHandler,
  publishResultSchema,
} from "@/app/api/integrations/n8n/publish-result/route";
import { PublishTargetConflictError } from "@/lib/content/repository";
import { createDemoRepository } from "@/lib/demo/repository";
import { signN8nPayload } from "@/lib/integrations/n8n-signature";

const SECRET = "a-test-secret-that-never-leaves-this-process";
const NOW_MS = Date.parse("2026-09-02T18:00:00.000Z");
const TIMESTAMP = String(NOW_MS / 1000);

const validBrief = {
  businessLine: "CONTROLAR",
  service: "pos",
  niche: "clinicas",
  contentType: "educativo",
  objective: "conversaciones_whatsapp",
  format: "feed_4_5",
  cta: "Escribe POS por WhatsApp",
  humanDescription: "Mostrar el corte de caja de una clínica.",
  allowedFacts: ["El POS registra ventas y cortes de caja."],
};

function validSuccessCallback(
  contentItemId = "1e62a32f-64c2-4da4-bad0-2837baad7812",
  publicationTargetId = "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
) {
  return {
    contentItemId,
    publicationTargetId,
    platform: "FACEBOOK" as const,
    idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
    remotePostId: "facebook-post-123",
    remoteUrl: "https://www.facebook.com/facebook-post-123",
    publishedAt: "2026-09-02T18:02:00.000Z",
  };
}

function signedRequest(payload: unknown, signature?: string): Request {
  return new Request("http://localhost/api/integrations/n8n/publish-result", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-snapgad-timestamp": TIMESTAMP,
      ...(signature === "missing"
        ? {}
        : {
            "x-snapgad-signature":
              signature ?? signN8nPayload(payload, TIMESTAMP, SECRET),
          }),
    },
    body: JSON.stringify(payload),
  });
}

describe("publish result schema", () => {
  it("accepts one strict success or sanitized error shape", () => {
    expect(publishResultSchema.safeParse(validSuccessCallback()).success).toBe(true);
    expect(
      publishResultSchema.safeParse({
        contentItemId: validSuccessCallback().contentItemId,
        publicationTargetId: validSuccessCallback().publicationTargetId,
        platform: "FACEBOOK",
        idempotencyKey: validSuccessCallback().idempotencyKey,
        error: { code: "META_FACEBOOK_ERROR", message: "Meta rejected the post." },
      }).success,
    ).toBe(true);
    expect(
      publishResultSchema.safeParse({
        ...validSuccessCallback(),
        accessToken: "must-never-be-accepted",
      }).success,
    ).toBe(false);
  });

  it("rejects mixed outcomes and unsupported error fields", () => {
    expect(
      publishResultSchema.safeParse({
        ...validSuccessCallback(),
        error: { code: "META_ERROR", message: "failed" },
      }).success,
    ).toBe(false);
    expect(
      publishResultSchema.safeParse({
        contentItemId: validSuccessCallback().contentItemId,
        publicationTargetId: validSuccessCallback().publicationTargetId,
        platform: "FACEBOOK",
        idempotencyKey: validSuccessCallback().idempotencyKey,
        error: { code: "META_ERROR", message: "failed", rawPayload: {} },
      }).success,
    ).toBe(false);
  });
});

describe("demo publish bridge", () => {
  it("rejects an unapproved target before queueing any publish request", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(validBrief);
    const [facebook] = await repository.listPublicationTargets(item.id);

    await expect(
      repository.preparePublishRequest({
        contentItemId: item.id,
        publicationTargetId: facebook!.id,
        idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
      }),
    ).rejects.toBeInstanceOf(PublishTargetConflictError);
    expect(await repository.listAuditEvents(item.id)).toEqual([]);
  });

  it("records one DRY_RUN_QUEUED event for an approved target without network", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(validBrief);
    const [facebook, instagram] = await repository.listPublicationTargets(item.id);
    await repository.approvePublicationTarget(item.id, facebook!.id);

    const request = {
      contentItemId: item.id,
      publicationTargetId: facebook!.id,
      idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
    };
    const first = await repository.preparePublishRequest(request);
    const retry = await repository.preparePublishRequest(request);

    expect(first).toMatchObject({
      created: true,
      status: "DRY_RUN_QUEUED",
      target: { id: facebook!.id, platform: "FACEBOOK", status: "APPROVED" },
    });
    expect(retry).toMatchObject({ created: false, status: "DRY_RUN_QUEUED" });
    expect((await repository.listPublicationTargets(item.id))[1]).toEqual(instagram);
    expect(await repository.listAuditEvents(item.id)).toEqual([
      expect.objectContaining({
        type: "DRY_RUN_QUEUED",
        metadata: { platform: "FACEBOOK", publicationTargetId: facebook!.id },
      }),
    ]);
  });

  it("publishes only the approved target and applies the callback once", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(validBrief);
    const [facebook, instagram] = await repository.listPublicationTargets(item.id);
    await repository.approvePublicationTarget(item.id, facebook!.id);
    const callback = {
      contentItemId: item.id,
      publicationTargetId: facebook!.id,
      platform: "FACEBOOK" as const,
      idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
      remotePostId: "facebook-post-123",
      remoteUrl: "https://www.facebook.com/facebook-post-123",
      publishedAt: "2026-09-02T18:02:00.000Z",
    };

    await expect(repository.ingestPublishResult(callback)).resolves.toEqual({
      created: true,
    });
    await expect(repository.ingestPublishResult(callback)).resolves.toEqual({
      created: false,
    });

    const targets = await repository.listPublicationTargets(item.id);
    expect(targets.find((target) => target.id === facebook!.id)).toMatchObject({
      platform: "FACEBOOK",
      status: "PUBLISHED",
      remotePostId: "facebook-post-123",
      remoteUrl: "https://www.facebook.com/facebook-post-123",
    });
    expect(targets.find((target) => target.id === instagram!.id)).toEqual(instagram);
    expect(
      (await repository.listAuditEvents(item.id)).filter(
        (event) => event.type === "PUBLISH_CALLBACK_RECEIVED",
      ),
    ).toHaveLength(1);
  });

  it("keeps an error on its own target and rejects idempotency-key reuse across targets", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(validBrief);
    const [facebook, instagram] = await repository.listPublicationTargets(item.id);
    await repository.approvePublicationTarget(item.id, facebook!.id);
    await repository.approvePublicationTarget(item.id, instagram!.id);
    const idempotencyKey = "cced3e68-7206-4c2f-9848-6bf474882150";

    await repository.ingestPublishResult({
      contentItemId: item.id,
      publicationTargetId: facebook!.id,
      platform: "FACEBOOK",
      idempotencyKey,
      error: { code: "META_FACEBOOK_ERROR", message: "Meta rejected the post." },
    });

    await expect(
      repository.ingestPublishResult({
        contentItemId: item.id,
        publicationTargetId: instagram!.id,
        platform: "INSTAGRAM",
        idempotencyKey,
        remotePostId: "instagram-post-123",
        remoteUrl: "https://www.instagram.com/p/instagram-post-123",
        publishedAt: "2026-09-02T18:03:00.000Z",
      }),
    ).rejects.toBeInstanceOf(PublishTargetConflictError);

    const targets = await repository.listPublicationTargets(item.id);
    expect(targets.find((target) => target.id === facebook!.id)).toMatchObject({
      status: "ERROR",
      lastError: "Meta rejected the post.",
    });
    const instagramAfter = targets.find((target) => target.id === instagram!.id);
    expect(instagramAfter?.status).toBe("APPROVED");
    expect(instagramAfter?.remotePostId).toBeUndefined();
  });
});

describe("POST /api/integrations/n8n/publish-result", () => {
  let repository: ReturnType<typeof createDemoRepository>;
  let handler: ReturnType<typeof createPublishResultHandler>;

  beforeEach(() => {
    repository = createDemoRepository();
    handler = createPublishResultHandler({
      getRepository: async () => repository,
      getSecret: () => SECRET,
      nowMs: () => NOW_MS,
    });
  });

  it("rejects invalid signatures and malformed callbacks before persistence", async () => {
    const ingest = vi.spyOn(repository, "ingestPublishResult");
    const invalidSignature = await handler(
      signedRequest(validSuccessCallback(), "sha256=bad"),
    );
    const malformed = await handler(
      signedRequest({ ...validSuccessCallback(), unexpected: "field" }),
    );

    expect(invalidSignature.status).toBe(401);
    expect(malformed.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("returns 409 when the callback target is not approved", async () => {
    const item = await repository.createContentItem(validBrief);
    const [facebook] = await repository.listPublicationTargets(item.id);

    const response = await handler(
      signedRequest(validSuccessCallback(item.id, facebook!.id)),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "TARGET_NOT_APPROVED" });
  });

  it("accepts a signed callback once and keeps the other platform independent", async () => {
    const item = await repository.createContentItem(validBrief);
    const [facebook, instagram] = await repository.listPublicationTargets(item.id);
    await repository.approvePublicationTarget(item.id, facebook!.id);
    const callback = validSuccessCallback(item.id, facebook!.id);

    const first = await handler(signedRequest(callback));
    const retry = await handler(signedRequest(callback));

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ created: true });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ created: false });
    expect(
      (await repository.listPublicationTargets(item.id)).find(
        (target) => target.id === instagram!.id,
      ),
    ).toEqual(instagram);
  });

  it("redacts obvious credentials before persisting an error", async () => {
    const item = await repository.createContentItem(validBrief);
    const [facebook] = await repository.listPublicationTargets(item.id);
    await repository.approvePublicationTarget(item.id, facebook!.id);
    const callback = {
      contentItemId: item.id,
      publicationTargetId: facebook!.id,
      platform: "FACEBOOK" as const,
      idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
      error: {
        code: "META_FACEBOOK_ERROR",
        message: "Authorization Bearer secret-token access_token=other-secret failed",
      },
    };

    const response = await handler(signedRequest(callback));
    const target = (await repository.listPublicationTargets(item.id)).find(
      (candidate) => candidate.id === facebook!.id,
    );

    expect(response.status).toBe(202);
    expect(target?.lastError).not.toContain("secret-token");
    expect(target?.lastError).not.toContain("other-secret");
  });
});
