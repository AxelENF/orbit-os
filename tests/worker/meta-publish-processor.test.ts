import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableJob } from "@/lib/automation/durable-job-contract";
import type {
  SupabasePublishJobPayload,
} from "@/lib/automation/supabase-publish-worker-store";
import { MetaPublishError } from "@/lib/integrations/meta-publish-error";
import type { MetaPublishResult } from "@/lib/integrations/meta-graph-client";
import {
  buildCaption,
  createMetaPublishProcessor,
} from "@/worker/providers/meta-publish-processor";

const publishToFacebookMock = vi.hoisted(() => vi.fn());
const publishToInstagramMock = vi.hoisted(() => vi.fn());
const checkTokenHealthMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/meta-graph-client", () => ({
  checkTokenHealth: checkTokenHealthMock,
  publishToFacebook: publishToFacebookMock,
  publishToInstagram: publishToInstagramMock,
}));

const organizationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const result: MetaPublishResult = {
  remotePostId: "post-1",
  remoteUrl: "https://facebook.com/post-1",
  publishedAt: "2026-09-13T12:00:00.000Z",
};

function baseJob(
  overrides: Partial<SupabasePublishJobPayload> = {},
): DurableJob<SupabasePublishJobPayload, MetaPublishResult> {
  return {
    id: jobId,
    organizationId,
    kind: "PUBLISH",
    provider: "local",
    payload: {
      contentItemId: "33333333-3333-4333-8333-333333333333",
      publicationTargetId: "44444444-4444-4444-8444-444444444444",
      platform: "FACEBOOK",
      assets: [
        {
          assetId: "55555555-5555-4555-8555-555555555555",
          position: 0,
          storagePath: "org/content-1/asset.png",
          assetUrl: "https://signed.example.com/asset.png",
        },
      ],
      copy: {
        headline: "Agenda más citas",
        body: "Atiende preguntas y ayuda a agendar por WhatsApp.",
        cta: "Escribe AGENDA",
        hashtags: ["#WhatsApp", "#Citas"],
      },
      meta: {
        facebookPageId: "page-123",
        pageAccessToken: "page-token",
        instagramBusinessAccountId: "ig-456",
      },
      ...overrides,
    },
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    runAt: "2026-09-13T12:00:00.000Z",
    nextAttemptAt: "2026-09-13T12:00:00.000Z",
    leaseToken: "77777777-7777-4777-8777-777777777777",
    leaseExpiresAt: "2026-09-13T12:10:00.000Z",
    lastError: null,
    createdAt: "2026-09-13T11:59:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
    startedAt: "2026-09-13T12:00:00.000Z",
    completedAt: null,
  };
}

describe("buildCaption", () => {
  it("combina headline, body, CTA y hashtags con doble salto de línea", () => {
    expect(
      buildCaption({
        headline: "Agenda más citas",
        body: "Atiende preguntas.",
        cta: "Escribe AGENDA",
        hashtags: ["#WhatsApp", "#Citas"],
      }),
    ).toBe("Agenda más citas\n\nAtiende preguntas.\n\nEscribe AGENDA\n\n#WhatsApp #Citas");
  });
});

describe("createMetaPublishProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("job de 1 asset con platform=FACEBOOK llama publishToFacebook y regresa el resultado", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    publishToFacebookMock.mockResolvedValueOnce(result);
    const processor = createMetaPublishProcessor({
      fetchFn,
      appToken: "meta-app-id|meta-app-secret",
      markConnectionError: vi.fn(),
    });

    await expect(processor(baseJob())).resolves.toEqual(result);
    expect(publishToFacebookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "page-123",
        pageAccessToken: "page-token",
        caption: "Agenda más citas\n\nAtiende preguntas y ayuda a agendar por WhatsApp.\n\nEscribe AGENDA\n\n#WhatsApp #Citas",
        assets: [{ signedUrl: "https://signed.example.com/asset.png", position: 0 }],
      }),
      fetchFn,
    );
    expect(publishToInstagramMock).not.toHaveBeenCalled();
  });

  it("job de 1 asset con platform=INSTAGRAM llama publishToInstagram", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    publishToInstagramMock.mockResolvedValueOnce(result);
    const processor = createMetaPublishProcessor({
      fetchFn,
      appToken: "meta-app-id|meta-app-secret",
      markConnectionError: vi.fn(),
    });

    await expect(
      processor(baseJob({ platform: "INSTAGRAM" })),
    ).resolves.toEqual(result);
    expect(publishToInstagramMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "page-123",
        igUserId: "ig-456",
        assets: [{ signedUrl: "https://signed.example.com/asset.png", position: 0 }],
      }),
      fetchFn,
    );
    expect(publishToFacebookMock).not.toHaveBeenCalled();
  });

  it("job de 3 assets llama la variante carrusel correspondiente", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    publishToFacebookMock.mockResolvedValueOnce(result);
    const processor = createMetaPublishProcessor({
      fetchFn,
      appToken: "meta-app-id|meta-app-secret",
      markConnectionError: vi.fn(),
    });

    const assets = [0, 1, 2].map((position) => ({
      assetId: `${position + 8}${position + 8}${position + 8}${position + 8}${position + 8}${position + 8}${position + 8}${position + 8}-8888-4888-8888-888888888888`,
      position,
      storagePath: `org/content-1/asset-${position}.png`,
      assetUrl: `https://signed.example.com/asset-${position}.png`,
    }));

    await expect(processor(baseJob({ assets }))).resolves.toEqual(result);
    expect(publishToFacebookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assets: assets.map(({ assetUrl, position }) => ({ signedUrl: assetUrl, position })),
      }),
      fetchFn,
    );
  });

  it("MetaPublishError con requiresReconnect=true llama markConnectionError ANTES de relanzar el error", async () => {
    const events: string[] = [];
    const error = new MetaPublishError("Token inválido", false, true);
    publishToFacebookMock.mockImplementationOnce(async () => {
      events.push("publish");
      throw error;
    });
    const markConnectionError = vi.fn(async () => {
      events.push("mark");
    });
    const processor = createMetaPublishProcessor({
      appToken: "meta-app-id|meta-app-secret",
      markConnectionError,
    });

    await expect(processor(baseJob())).rejects.toBe(error);
    expect(events).toEqual(["publish", "mark"]);
    expect(markConnectionError).toHaveBeenCalledWith(organizationId);
  });

  it("MetaPublishError con requiresReconnect=false no llama markConnectionError", async () => {
    const error = new MetaPublishError("Contenido rechazado", false, false);
    publishToFacebookMock.mockRejectedValueOnce(error);
    const markConnectionError = vi.fn();
    const processor = createMetaPublishProcessor({
      appToken: "meta-app-id|meta-app-secret",
      markConnectionError,
    });

    await expect(processor(baseJob())).rejects.toBe(error);
    expect(markConnectionError).not.toHaveBeenCalled();
  });

  it("token inválido en debug_token no publica, marca la conexión y no se reintenta", async () => {
    const error = new MetaPublishError("Token inválido", false, true);
    const fetchFn = vi.fn<typeof fetch>();
    checkTokenHealthMock.mockRejectedValueOnce(error);
    const markConnectionError = vi.fn().mockResolvedValue(undefined);
    const processor = createMetaPublishProcessor({
      fetchFn,
      appToken: "meta-app-id|meta-app-secret",
      markConnectionError,
    });

    await expect(processor(baseJob())).rejects.toBe(error);

    expect(checkTokenHealthMock).toHaveBeenCalledWith(
      "page-token",
      "meta-app-id|meta-app-secret",
      fetchFn,
    );
    expect(publishToFacebookMock).not.toHaveBeenCalled();
    expect(markConnectionError).toHaveBeenCalledWith(organizationId);
  });
});
