import { describe, expect, it, vi } from "vitest";

import { createSupabaseRepository } from "@/lib/supabase/repository";

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
});
