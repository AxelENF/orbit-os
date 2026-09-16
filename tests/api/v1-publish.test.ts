/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/v1-context", () => ({
  resolveV1RequestContext: vi.fn(),
  V1AuthenticationError: class V1AuthenticationError extends Error {},
  V1NotConfiguredError: class V1NotConfiguredError extends Error {},
}));
vi.mock("@/lib/integrations/n8n-client", () => ({
  requestN8nPublish: vi.fn(),
  N8nPublishConfigurationError: class N8nPublishConfigurationError extends Error {},
  N8nPublishDeliveryError: class N8nPublishDeliveryError extends Error {},
}));

import { POST as publishCampaign } from "@/app/api/v1/campaigns/[id]/publish/route";
import { resolveV1RequestContext } from "@/lib/api/v1-context";
import { requestN8nPublish } from "@/lib/integrations/n8n-client";

const contentItemId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

function context() {
  return { params: Promise.resolve({ id: contentItemId }) };
}

function requestWithBody(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

function mockRepository(overrides: {
  checkPublicationTargetOwnership: { target: { id: string; status: string } | null; failed: boolean };
  getContentRecord?: unknown;
}) {
  vi.mocked(resolveV1RequestContext).mockResolvedValue({
    organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
    repository: {
      checkPublicationTargetOwnership: vi.fn().mockResolvedValue(overrides.checkPublicationTargetOwnership),
      getContentRecord: vi.fn().mockResolvedValue(overrides.getContentRecord ?? null),
    } as never,
  });
}

describe("POST /api/v1/campaigns/:id/publish", () => {
  it("responds 404 when the target doesn't exist for this organization — never distinguishing from a cross-tenant target", async () => {
    mockRepository({ checkPublicationTargetOwnership: { target: null, failed: false } });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(404);
  });

  it("responds 503, not a false 409, when the ownership lookup itself fails", async () => {
    mockRepository({ checkPublicationTargetOwnership: { target: null, failed: true } });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
  });

  it("responds 409 when the target exists for this organization but isn't APPROVED", async () => {
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "PENDING_REVIEW" }, failed: false },
    });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(409);
    expect(requestN8nPublish).not.toHaveBeenCalled();
  });

  it("responds 503 (internal inconsistency, not a caller error) when the approved target has no signed asset URL", async () => {
    // Corrección ronda 1 de revisión del plan (hallazgo real):
    // ContentRecord.asset.signedUrl es opcional (lib/content/repository.ts:90)
    // — sin este guard, un undefined llegaría hasta requestN8nPublish y su
    // propia validación zod lo convertiría en un 400 que culpa al caller,
    // cuando en realidad es un estado interno inconsistente (target
    // aprobado pero sin asset servible).
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "APPROVED" }, failed: false },
      getContentRecord: { asset: {}, finalCopy: { headline: "H", body: "B", cta: "C" } },
    });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
    expect(requestN8nPublish).not.toHaveBeenCalled();
  });

  it("derives assetUrl/copy from the stored record server-side — the caller cannot supply their own", async () => {
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "APPROVED" }, failed: false },
      getContentRecord: {
        asset: { signedUrl: "https://storage.example/real-asset.png" },
        finalCopy: { headline: "Real headline", body: "Real body", cta: "Real CTA" },
      },
    });
    vi.mocked(requestN8nPublish).mockResolvedValue({
      created: true, status: "QUEUED", idempotencyKey: "idem-1", publicationTargetId: targetId, platform: "FACEBOOK",
    });

    // El caller intenta declarar su propio assetUrl/copy — debe ser ignorado.
    await publishCampaign(
      requestWithBody({ publicationTargetId: targetId, assetUrl: "https://evil.example/fake.png", copy: { body: "fake" } }),
      context(),
    );

    expect(requestN8nPublish).toHaveBeenCalledWith(
      expect.objectContaining({ assetUrl: "https://storage.example/real-asset.png", copy: expect.objectContaining({ body: "Real body" }) }),
      expect.anything(),
    );
  });

  it("reclassifies a PublishTargetConflictError from the second, redundant preparePublishRequest call as 503, not 409", async () => {
    // El pre-chequeo propio ya confirmó APPROVED; si requestN8nPublish
    // (que internamente vuelve a llamar preparePublishRequest) igual lanza
    // PublishTargetConflictError, es una condición de carrera transitoria,
    // no un 409 real — el 409 real ya se habría dado en el paso anterior.
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "APPROVED" }, failed: false },
      getContentRecord: {
        asset: { signedUrl: "https://storage.example/real-asset.png" },
        finalCopy: { headline: "H", body: "B", cta: "C" },
      },
    });
    const { PublishTargetConflictError } = await import("@/lib/content/repository");
    vi.mocked(requestN8nPublish).mockRejectedValue(new PublishTargetConflictError());

    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
  });
});
