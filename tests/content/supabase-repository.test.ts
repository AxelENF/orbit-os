import { describe, expect, it, vi } from "vitest";

import { createSupabaseRepository } from "@/lib/supabase/repository";
import { CopyResultConflictError } from "@/lib/content/repository";

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
  it("creates the item, both targets, and audit event through one RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: createdRow, error: null });
    const from = vi.fn();
    const repository = createSupabaseRepository({ rpc, from } as never, "owner-id");

    await expect(repository.createContentItem(validBrief)).resolves.toMatchObject({
      id: createdRow.id,
      state: "DRAFT",
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("create_content_item_with_targets", {
      p_owner_id: "owner-id",
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
    const repository = createSupabaseRepository({ rpc, from } as never, "owner-id");

    await expect(repository.createContentItem(validBrief)).rejects.toThrow(
      "Unable to create the content item.",
    );
    expect(rpc).toHaveBeenCalledOnce();
    expect(from).not.toHaveBeenCalled();
  });

  it("ingests a copy callback through one atomic RPC without a caller owner ID", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { created: true }, error: null });
    const repository = createSupabaseRepository({ rpc } as never, "browser-owner-id");

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
      "owner-id",
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
      "owner-id",
    );
    await expect(
      conflictRepository.ingestCopyResult(validCopyResult),
    ).rejects.toBeInstanceOf(CopyResultConflictError);
  });
});
