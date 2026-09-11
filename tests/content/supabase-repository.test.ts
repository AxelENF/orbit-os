import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseCallbackRepository,
  createSupabaseRepository,
} from "@/lib/supabase/repository";
import {
  CopyResultConflictError,
  PublishTargetConflictError,
} from "@/lib/content/repository";
import type { OrganizationContext } from "@/lib/organizations/context";

const organizationA: OrganizationContext = {
  organizationId: "1e62a32f-64c2-4da4-bad0-2837baad7812",
  userId: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
  role: "owner",
};
const organizationB: OrganizationContext = {
  organizationId: "0b93d53f-1d18-4d83-b7c8-cb8cf9fc4e1d",
  userId: "e3a14d68-6f52-4ad4-9d3e-77ee64c0fcb2",
  role: "owner",
};

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

const createdRow = {
  id: "b411ce10-50a9-4d8b-8ff3-a7fb522b53d2",
  business_line: "CONTROLAR",
  service: "pos",
  niche: "clinicas",
  content_type: "educativo",
  objective: "conversaciones_whatsapp",
  format: "feed_4_5",
  cta: "Escribe POS por WhatsApp",
  human_description: "Mostrar el corte de caja de una clínica.",
  allowed_facts: ["El POS registra ventas y cortes de caja."],
  campaign_name: "Agenda clínica septiembre",
  offer: "Automatización de agenda",
  funnel_stage: "captacion",
  destination: "whatsapp",
  destination_value: "https://wa.me/5215555555555?text=AGENDA",
  campaign_code: "SG-AGENDA-20260908-12345678",
  state: "DRAFT",
  created_at: "2026-08-31T00:00:00.000Z",
};

const validCopyResult = {
  contentItemId: createdRow.id,
  idempotencyKey: "4a150496-852d-46d4-8f25-951f6512db73",
  visualAnalysis: {
    scene: "Mostrador con terminal de venta.",
    visibleText: ["Corte de caja"],
    proof: ["Se ve el resumen de ventas."],
    risks: [],
  },
  drafts: [
    {
      headline: "Control al cierre",
      body: "Consulta las ventas registradas.",
      cta: "Escribe POS",
    },
    {
      headline: "Un corte claro",
      body: "Revisa el resumen antes de cerrar.",
      cta: "Escribe POS",
    },
  ],
  warnings: ["Confirmar que el texto visible sea legible."],
  provider: "openrouter",
  model: "test-model",
};

describe("SupabaseContentRepository", () => {
  it("scopes list, get, and create operations to the trusted organization context", async () => {
    const rowsByOrganization: Record<string, unknown[]> = {
      [organizationA.organizationId]: [createdRow],
      [organizationB.organizationId]: [],
    };
    const from = vi.fn(() => {
      const filters: Array<[string, string]> = [];
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn((field: string, value: string) => {
          filters.push([field, value]);
          return chain;
        }),
        order: vi.fn(() => Promise.resolve({
          data: rowsByOrganization[filters.find(([field]) => field === "organization_id")?.[1] ?? ""] ?? [],
          error: null,
        })),
        maybeSingle: vi.fn(() => Promise.resolve({
          data: (rowsByOrganization[filters.find(([field]) => field === "organization_id")?.[1] ?? ""] ?? [])[0] ?? null,
          error: null,
        })),
      };
      return chain;
    });
    const rpc = vi.fn().mockResolvedValue({ data: createdRow, error: null });
    const repositoryA = createSupabaseRepository({ from, rpc } as never, organizationA);
    const repositoryB = createSupabaseRepository({ from, rpc } as never, organizationB);

    await expect(repositoryA.listContentSummaries()).resolves.toEqual([
      expect.objectContaining({
        id: createdRow.id,
        campaign: expect.objectContaining({
          campaignName: "Agenda clínica septiembre",
          offer: "Automatización de agenda",
          campaignCode: "SG-AGENDA-20260908-12345678",
        }),
      }),
    ]);
    await expect(repositoryB.listContentSummaries()).resolves.toEqual([]);
    await expect(repositoryB.getContentRecord(createdRow.id)).resolves.toBeNull();
    await repositoryA.createContentItem(validBrief);
    await repositoryB.createContentItem(validBrief);

    expect(rpc.mock.calls).toEqual(expect.arrayContaining([
      ["create_content_item_with_targets", expect.objectContaining({
        p_organization_id: organizationA.organizationId,
        p_owner_id: organizationA.userId,
      })],
      ["create_content_item_with_targets", expect.objectContaining({
        p_organization_id: organizationB.organizationId,
        p_owner_id: organizationB.userId,
      })],
    ]));
    expect(from.mock.results.map((result) => result.value.eq.mock.calls)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([["organization_id", organizationA.organizationId]]),
        expect.arrayContaining([["organization_id", organizationB.organizationId]]),
      ]),
    );
  });

  it("creates the item, both targets, and audit event through one RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: createdRow, error: null });
    const from = vi.fn();
    const repository = createSupabaseRepository({ rpc, from } as never, organizationA);

    await expect(repository.createContentItem(validBrief)).resolves.toMatchObject({
      id: createdRow.id,
      state: "DRAFT",
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("create_content_item_with_targets", {
      p_owner_id: organizationA.userId,
      p_organization_id: organizationA.organizationId,
      p_business_line: validBrief.businessLine,
      p_service: validBrief.service,
      p_niche: validBrief.niche,
      p_content_type: validBrief.contentType,
      p_objective: validBrief.objective,
      p_format: validBrief.format,
      p_cta: validBrief.cta,
      p_human_description: validBrief.humanDescription,
      p_allowed_facts: validBrief.allowedFacts,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("propagates an RPC failure without attempting partial repository writes", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "database rejected request" },
    });
    const from = vi.fn();
    const repository = createSupabaseRepository({ rpc, from } as never, organizationA);

    await expect(repository.createContentItem(validBrief)).rejects.toThrow(
      "Unable to create the content item.",
    );
    expect(rpc).toHaveBeenCalledOnce();
    expect(from).not.toHaveBeenCalled();
  });

  it("ingests a copy callback through one atomic RPC without a caller owner ID", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { created: true }, error: null });
    const repository = createSupabaseRepository({ rpc } as never, organizationA);

    await expect(repository.ingestCopyResult(validCopyResult)).resolves.toEqual({
      created: true,
    });
    expect(rpc).toHaveBeenCalledWith("ingest_copy_result_callback", {
      p_content_item_id: validCopyResult.contentItemId,
      p_idempotency_key: validCopyResult.idempotencyKey,
      p_visual_analysis: validCopyResult.visualAnalysis,
      p_drafts: validCopyResult.drafts,
      p_warnings: validCopyResult.warnings,
      p_provider: validCopyResult.provider,
      p_model: validCopyResult.model,
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_owner_id");
  });

  it("returns the idempotent RPC result and maps state conflicts", async () => {
    const duplicateRpc = vi.fn().mockResolvedValue({
      data: { created: false },
      error: null,
    });
    const duplicateRepository = createSupabaseRepository(
      { rpc: duplicateRpc } as never,
      organizationA,
    );
    await expect(
      duplicateRepository.ingestCopyResult(validCopyResult),
    ).resolves.toEqual({ created: false });

    const conflictRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "COPY_RESULT_INVALID_STATE" },
    });
    const conflictRepository = createSupabaseRepository(
      { rpc: conflictRpc } as never,
      organizationA,
    );
    await expect(
      conflictRepository.ingestCopyResult(validCopyResult),
    ).rejects.toBeInstanceOf(CopyResultConflictError);
  });

  it("ingests a target-specific publish callback through one atomic RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { created: true }, error: null });
    const repository = createSupabaseRepository({ rpc } as never, organizationA);
    const callback = {
      contentItemId: createdRow.id,
      publicationTargetId: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
      platform: "FACEBOOK" as const,
      idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
      remotePostId: "facebook-post-123",
      remoteUrl: "https://www.facebook.com/facebook-post-123",
      publishedAt: "2026-09-02T18:02:00.000Z",
    };

    await expect(repository.ingestPublishResult(callback)).resolves.toEqual({
      created: true,
    });
    expect(rpc).toHaveBeenCalledWith("ingest_publish_result_callback", {
      p_content_item_id: callback.contentItemId,
      p_publication_target_id: callback.publicationTargetId,
      p_platform: callback.platform,
      p_idempotency_key: callback.idempotencyKey,
      p_remote_post_id: callback.remotePostId,
      p_remote_url: callback.remoteUrl,
      p_published_at: callback.publishedAt,
      p_error_code: null,
      p_error_message: null,
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_owner_id");
  });

  it("maps publish approval and target conflicts to a 409 boundary error", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "PUBLISH_TARGET_NOT_APPROVED" },
    });
    const repository = createSupabaseRepository({ rpc } as never, organizationA);

    await expect(
      repository.ingestPublishResult({
        contentItemId: createdRow.id,
        publicationTargetId: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
        platform: "INSTAGRAM",
        idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
        error: { code: "META_INSTAGRAM_ERROR", message: "Meta rejected it." },
      }),
    ).rejects.toBeInstanceOf(PublishTargetConflictError);
  });

  it("reads an owner-scoped content record without exposing a service owner parameter", async () => {
    const targetRow = {
      id: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
      content_item_id: createdRow.id,
      platform: "FACEBOOK",
      status: "APPROVED",
      remote_post_id: null,
      remote_url: null,
      published_at: null,
      last_error: null,
      updated_at: "2026-09-02T18:02:00.000Z",
    };
    const draftRow = {
      id: "0b93d53f-1d18-4d83-b7c8-cb8cf9fc4e1d",
      content_item_id: createdRow.id,
      visual_analysis: { scene: "Mostrador" },
      headline: "Control al cierre",
      body: "Consulta las ventas registradas.",
      cta: "Escribe POS",
      hashtags: ["#Agenda", "#POS"],
      provider: "openrouter",
      model: "test-model",
      created_at: "2026-09-02T18:02:00.000Z",
    };
    const auditRow = {
      id: "e3a14d68-6f52-4ad4-9d3e-77ee64c0fcb2",
      content_item_id: createdRow.id,
      event_type: "TARGET_APPROVED",
      metadata: { platform: "FACEBOOK" },
      created_at: "2026-09-02T18:02:00.000Z",
    };
    const rows: Record<string, unknown> = {
      content_items: [createdRow],
      publication_targets: [targetRow],
      copy_drafts: [draftRow],
      audit_events: [auditRow],
    };
    const from = vi.fn((table: string) => {
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn().mockResolvedValue({ data: rows[table], error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: createdRow, error: null }),
      };
      return chain;
    });
    const repository = createSupabaseRepository({ from } as never, organizationA);

    await expect(repository.listContentItems()).resolves.toEqual([
      expect.objectContaining({ id: createdRow.id, state: "DRAFT" }),
    ]);
    await expect(repository.getContentRecord(createdRow.id)).resolves.toMatchObject({
      content: { id: createdRow.id },
      targets: [{ id: targetRow.id, status: "APPROVED" }],
      drafts: [{ id: draftRow.id, headline: draftRow.headline, hashtags: ["#Agenda", "#POS"] }],
      auditEvents: [{ type: "TARGET_APPROVED", status: "success" }],
    });
    expect(from).toHaveBeenCalledWith("content_items");
  });

  it("approves a target through the owner-scoped RPC and maps conflicts", async () => {
    const targetRow = {
      id: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
      content_item_id: createdRow.id,
      platform: "FACEBOOK",
      status: "APPROVED",
      remote_post_id: null,
      remote_url: null,
      published_at: null,
      last_error: null,
      updated_at: "2026-09-02T18:02:00.000Z",
    };
    const rpc = vi.fn().mockResolvedValue({ data: targetRow, error: null });
    const repository = createSupabaseRepository({ rpc } as never, organizationA);

    await expect(
      repository.approvePublicationTarget(createdRow.id, targetRow.id),
    ).resolves.toMatchObject({ id: targetRow.id, status: "APPROVED" });
    expect(rpc).toHaveBeenCalledWith("approve_publication_target", {
      p_owner_id: organizationA.userId,
      p_organization_id: organizationA.organizationId,
      p_content_item_id: createdRow.id,
      p_publication_target_id: targetRow.id,
    });
  });

  it("enqueues a copy job atomically in the trusted organization", async () => {
    const jobId = "d32c92ce-9e2b-4aa2-9c39-5c5d97746156";
    const idempotencyKey = "4a150496-852d-46d4-8f25-951f6512db73";
    const rpc = vi.fn().mockResolvedValue({
      data: { created: true, jobId, idempotencyKey },
      error: null,
    });
    const repository = createSupabaseRepository({ rpc } as never, organizationA);

    await expect(repository.enqueueCopyJob({
      contentItemId: createdRow.id,
      idempotencyKey,
    })).resolves.toEqual({ created: true, jobId, idempotencyKey });
    expect(rpc).toHaveBeenCalledWith("enqueue_copy_automation_job", {
      p_organization_id: organizationA.organizationId,
      p_actor_id: organizationA.userId,
      p_content_item_id: createdRow.id,
      p_idempotency_key: idempotencyKey,
    });
  });

  it("claims derived asset data and completes a job only through service RPCs", async () => {
    const jobId = "d32c92ce-9e2b-4aa2-9c39-5c5d97746156";
    const idempotencyKey = "4a150496-852d-46d4-8f25-951f6512db73";
    const leaseToken = "e3a14d68-6f52-4ad4-9d3e-77ee64c0fcb2";
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          state: "CLAIMED",
          job: {
            id: jobId,
            idempotencyKey,
            leaseToken,
            leaseExpiresAt: "2026-09-08T12:10:00.000Z",
            contentItemId: createdRow.id,
            storagePath: "org/asset/agenda.png",
            brief: validBrief,
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { created: true }, error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.example/agenda.png?token=temporary" },
      error: null,
    });
    const repository = createSupabaseCallbackRepository({
      rpc,
      storage: { from: vi.fn(() => ({ createSignedUrl })) },
    } as never);

    const claim = await repository.claimCopyJob({ jobId, idempotencyKey });
    expect(claim).toMatchObject({
      state: "CLAIMED",
      job: {
        id: jobId,
        leaseToken,
        assetUrl: "https://storage.example/agenda.png?token=temporary",
        brief: validBrief,
      },
    });
    await expect(repository.completeCopyJob({
      jobId,
      idempotencyKey,
      leaseToken,
      result: {
        visualAnalysis: { scene: "Agenda", visibleText: [], proof: [], risks: [] },
        drafts: [
          { headline: "A", body: "Atiende y agenda.", cta: "Escribe AGENDA" },
          { headline: "B", body: "Responde clientes.", cta: "Escribe AGENDA" },
        ],
        warnings: [],
      },
    })).resolves.toEqual({ created: true });
    expect(rpc).toHaveBeenCalledWith("claim_copy_automation_job", {
      p_job_id: jobId,
      p_idempotency_key: idempotencyKey,
    });
    expect(rpc).toHaveBeenCalledWith("complete_copy_automation_job", expect.objectContaining({
      p_job_id: jobId,
      p_idempotency_key: idempotencyKey,
      p_lease_token: leaseToken,
    }));
  });
});
