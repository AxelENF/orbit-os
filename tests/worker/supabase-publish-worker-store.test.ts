import { describe, expect, it, vi } from "vitest";

import { SupabasePublishWorkerStore } from "@/lib/automation/supabase-publish-worker-store";

const organizationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const contentItemId = "33333333-3333-4333-8333-333333333333";
const publicationTargetId = "66666666-6666-4666-8666-666666666666";
const assetId = "77777777-7777-4777-8777-777777777777";
const secondAssetId = "88888888-8888-4888-8888-888888888888";
const idempotencyKey = "44444444-4444-4444-8444-444444444444";
const leaseToken = "55555555-5555-4555-8555-555555555555";

const claim = {
  state: "CLAIMED",
  job: {
    id: jobId,
    organizationId,
    kind: "PUBLISH",
    provider: "meta",
    idempotencyKey,
    leaseToken,
    leaseExpiresAt: "2026-09-09T12:10:00.000Z",
    contentItemId,
    publicationTargetId,
    platform: "FACEBOOK",
    assets: [
      { assetId, position: 0, storagePath: "org/assets/first.png" },
      { assetId: secondAssetId, position: 1, storagePath: "org/assets/second.png" },
    ],
    copy: {
      headline: "Agenda más citas",
      body: "Responde rápido a tus pacientes.",
      cta: "Escribe AGENDA",
      hashtags: ["#SnapGad", "#Clinicas"],
    },
    meta: {
      facebookPageId: "page-123",
      pageAccessToken: "secret-page-token",
      instagramBusinessAccountId: "ig-123",
    },
    attempts: 1,
    maxAttempts: 3,
    runAt: "2026-09-09T12:00:00.000Z",
    nextAttemptAt: "2026-09-09T12:00:00.000Z",
    createdAt: "2026-09-09T11:59:00.000Z",
    updatedAt: "2026-09-09T12:00:00.000Z",
    startedAt: "2026-09-09T12:00:00.000Z",
  },
};

function clientWith(
  rpc: ReturnType<typeof vi.fn>,
  signedUrlResponses: Array<{
    data: { signedUrl: string } | null;
    error: { message: string } | null;
  }> = [
    { data: { signedUrl: "https://storage.example/first.png?token=short" }, error: null },
    { data: { signedUrl: "https://storage.example/second.png?token=short" }, error: null },
  ],
) {
  const createSignedUrl = vi.fn();
  for (const response of signedUrlResponses) createSignedUrl.mockResolvedValueOnce(response);
  return {
    rpc,
    storage: { from: vi.fn(() => ({ createSignedUrl })) },
    createSignedUrl,
  };
}

describe("SupabasePublishWorkerStore", () => {
  it("claims an organization-scoped job, signs every asset in order, renews, and completes it", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: claim, error: null })
      .mockResolvedValueOnce({
        data: { state: "RENEWED", leaseExpiresAt: "2026-09-09T12:12:00.000Z" },
        error: null,
      })
      .mockResolvedValueOnce({ data: { created: true }, error: null });
    const client = clientWith(rpc);
    const store = new SupabasePublishWorkerStore(client as never, { signedUrlSeconds: 300, provider: "meta" });

    const claimed = await store.claimNext({ organizationId });
    expect(claimed).toMatchObject({
      id: jobId,
      organizationId,
      status: "PROCESSING",
      payload: {
        contentItemId,
        publicationTargetId,
        platform: "FACEBOOK",
        assets: [
          { assetId, position: 0, storagePath: "org/assets/first.png", assetUrl: "https://storage.example/first.png?token=short" },
          { assetId: secondAssetId, position: 1, storagePath: "org/assets/second.png", assetUrl: "https://storage.example/second.png?token=short" },
        ],
        copy: claim.job.copy,
        meta: claim.job.meta,
      },
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "claim_next_publish_automation_job", {
      p_provider: "meta",
      p_organization_id: organizationId,
    });
    expect(client.createSignedUrl).toHaveBeenNthCalledWith(1, "org/assets/first.png", 300);
    expect(client.createSignedUrl).toHaveBeenNthCalledWith(2, "org/assets/second.png", 300);

    const renewed = await store.renewLease({
      jobId,
      organizationId,
      leaseToken,
      leaseDurationMs: 120_000,
    });
    expect(renewed?.leaseExpiresAt).toBe("2026-09-09T12:12:00.000Z");
    expect(rpc).toHaveBeenNthCalledWith(2, "renew_publish_automation_job", {
      p_job_id: jobId,
      p_idempotency_key: idempotencyKey,
      p_lease_token: leaseToken,
      p_lease_seconds: 120,
    });

    const completed = await store.complete({
      jobId,
      organizationId,
      leaseToken,
      result: { postId: "post-123" },
    });
    expect(completed).toMatchObject({ id: jobId, status: "COMPLETED", result: { postId: "post-123" } });
    expect(rpc).toHaveBeenNthCalledWith(3, "complete_publish_automation_job", {
      p_job_id: jobId,
      p_idempotency_key: idempotencyKey,
      p_lease_token: leaseToken,
      p_result: { postId: "post-123" },
    });
    expect(await store.renewLease({ jobId, organizationId, leaseToken })).toBeNull();
  });

  it("returns null for a non-claimable job", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { state: "NOT_CLAIMABLE" }, error: null });
    const client = clientWith(rpc);
    const store = new SupabasePublishWorkerStore(client as never);

    await expect(store.claimNext({ organizationId })).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("claim_next_publish_automation_job", {
      p_provider: "local",
      p_organization_id: organizationId,
    });
  });

  it("keeps lease mutations tenant-scoped and maps retry/dead-letter, cancel, recovery, and health responses", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: claim, error: null })
      .mockResolvedValueOnce({
        data: {
          state: "RETRY_WAIT",
          jobId,
          attempts: 1,
          nextAttemptAt: "2026-09-09T12:00:02.000Z",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { recovered: 2 }, error: null })
      .mockResolvedValueOnce({
        data: {
          queuedCount: 1,
          retryCount: 2,
          activeLeaseCount: 0,
          failedCount: 0,
          deadLetterCount: 1,
          queueLagMs: 2500,
          lastSuccessfulRun: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { state: "NOT_CANCELLABLE", status: "RETRY_WAIT" },
        error: null,
      });
    const store = new SupabasePublishWorkerStore(clientWith(rpc) as never);

    await store.claimNext({ organizationId });
    expect(await store.renewLease({ jobId, organizationId: "66666666-6666-4666-8666-666666666666", leaseToken })).toBeNull();
    const failed = await store.fail({ jobId, organizationId, leaseToken, error: "provider unavailable" });
    expect(failed).toMatchObject({ status: "RETRY_WAIT", lastError: "provider unavailable" });
    expect(await store.recoverExpired()).toBe(2);
    await expect(store.health()).resolves.toMatchObject({ retryCount: 2, deadLetterCount: 1 });
    expect(await store.cancel({ jobId, organizationId, idempotencyKey })).toBeNull();
  });

  it("records a retry when a claimed asset cannot be delivered", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: claim, error: null })
      .mockResolvedValueOnce({ data: { state: "RETRY_WAIT", jobId, attempts: 1, nextAttemptAt: "2026-09-09T12:00:01.000Z" }, error: null });
    const client = clientWith(rpc, [{ data: null, error: { message: "asset unavailable" } }]);
    const store = new SupabasePublishWorkerStore(client as never);

    await expect(store.claimNext({ organizationId })).rejects.toThrow(/signed publish-job asset URL/);
    expect(rpc).toHaveBeenNthCalledWith(2, "fail_publish_automation_job", {
      p_job_id: jobId,
      p_idempotency_key: idempotencyKey,
      p_lease_token: leaseToken,
      p_error: "PUBLISH_JOB_ASSET_URL_FAILED",
      p_retryable: true,
    });
    expect(client.createSignedUrl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid worker configuration before making an RPC call", async () => {
    expect(() => new SupabasePublishWorkerStore({} as never, { signedUrlSeconds: 30 })).toThrow();
    const rpc = vi.fn();
    const store = new SupabasePublishWorkerStore(clientWith(rpc) as never);
    await expect(store.claimNext({ organizationId: "not-a-uuid" })).rejects.toThrow(/organizationId/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects unsafe lease and cancellation inputs before reaching Supabase", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: claim, error: null });
    const store = new SupabasePublishWorkerStore(clientWith(rpc) as never);
    await store.claimNext({ organizationId });

    await expect(
      store.renewLease({ jobId, organizationId, leaseToken, leaseDurationMs: 29_999 }),
    ).rejects.toThrow(/leaseDurationMs/);
    await expect(
      store.cancel({ jobId: "not-a-uuid", organizationId, idempotencyKey }),
    ).rejects.toThrow(/jobId/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
