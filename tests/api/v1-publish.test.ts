/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/v1-context", () => ({
  resolveV1RequestContext: vi.fn(),
  V1AuthenticationError: class V1AuthenticationError extends Error {},
  V1NotConfiguredError: class V1NotConfiguredError extends Error {},
}));

import { POST as publishCampaign } from "@/app/api/v1/campaigns/[id]/publish/route";
import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";

const contentItemId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

function context() {
  return { params: Promise.resolve({ id: contentItemId }) };
}

function requestWithBody(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

function mockRepository(checkPublicationTargetOwnership: {
  target: { id: string; status: string; platform: string } | null;
  failed: boolean;
}) {
  vi.mocked(resolveV1RequestContext).mockResolvedValue({
    organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
    repository: {
      checkPublicationTargetOwnership: vi.fn().mockResolvedValue(checkPublicationTargetOwnership),
    } as never,
  });
}

describe("POST /api/v1/campaigns/:id/publish", () => {
  it("responds 404 when the target doesn't exist for this organization — never distinguishing from a cross-tenant target", async () => {
    mockRepository({ target: null, failed: false });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "TARGET_NOT_FOUND" });
  });

  it("responds 503, not a false 409, when the ownership lookup itself fails", async () => {
    mockRepository({ target: null, failed: true });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "TARGET_LOOKUP_FAILED" });
  });

  it("responds 409 when the target exists for this organization but isn't APPROVED", async () => {
    mockRepository({ target: { id: targetId, status: "PENDING_REVIEW", platform: "FACEBOOK" }, failed: false });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "TARGET_NOT_APPROVED" });
  });

  it("confirms an approved target is queued, without deriving or accepting any asset/copy from the caller", async () => {
    // Un target solo llega a status APPROVED a través de
    // approve_publication_target (migración 0018_meta_publisher.sql), que
    // SIEMPRE encola el job real (enqueue_publish_automation_job) en la
    // misma transacción — tanto en la primera aprobación como en cualquier
    // re-entrada idempotente. El chequeo de ownership ya es, por
    // construcción, la prueba de que el job existe: no hay nada más que
    // este endpoint necesite derivar, encolar o aceptar del caller.
    mockRepository({ target: { id: targetId, status: "APPROVED", platform: "INSTAGRAM" }, failed: false });

    const response = await publishCampaign(
      requestWithBody({ publicationTargetId: targetId, assetUrl: "https://evil.example/fake.png", copy: { body: "fake" } }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: true, publicationTargetId: targetId, platform: "INSTAGRAM" });
  });

  it("responds 400 for a malformed publicationTargetId", async () => {
    mockRepository({ target: null, failed: false });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: "not-a-uuid" }), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
  });

  it("responds 401 when the API key context fails to resolve", async () => {
    vi.mocked(resolveV1RequestContext).mockRejectedValue(new V1AuthenticationError());
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(401);
  });

  it("responds 503 when v1 is not configured for this environment", async () => {
    vi.mocked(resolveV1RequestContext).mockRejectedValue(new V1NotConfiguredError());
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
  });
});
