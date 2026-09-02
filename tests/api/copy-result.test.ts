import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCopyResultHandler,
  copyResultSchema,
} from "@/app/api/integrations/n8n/copy-result/route";
import { createDemoRepository } from "@/lib/demo/repository";
import { signN8nPayload } from "@/lib/integrations/n8n-signature";

const SECRET = "a-test-secret-that-never-leaves-this-process";
const NOW_MS = Date.parse("2026-09-02T12:00:00.000Z");
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

function validCallback(contentItemId = "1e62a32f-64c2-4da4-bad0-2837baad7812") {
  return {
    contentItemId,
    idempotencyKey: "4a150496-852d-46d4-8f25-951f6512db73",
    visualAnalysis: {
      scene: "Mostrador de una clínica con una terminal de venta.",
      visibleText: ["Corte de caja"],
      proof: ["La pantalla muestra un resumen de ventas."],
      risks: [],
    },
    drafts: [
      {
        headline: "Tu corte de caja, claro",
        body: "Consulta las ventas registradas desde el POS.",
        cta: "Escribe POS por WhatsApp",
      },
      {
        headline: "Cierra el día con control",
        body: "Revisa el resumen de ventas antes de terminar el turno.",
        cta: "Escribe POS por WhatsApp",
      },
    ],
    warnings: [],
    provider: "openrouter",
    model: "test-model",
  };
}

function signedRequest(payload: unknown, signature?: string): Request {
  const body = JSON.stringify(payload);
  return new Request("http://localhost/api/integrations/n8n/copy-result", {
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
    body,
  });
}

describe("copy result schema", () => {
  it("requires exactly two complete draft alternatives", () => {
    expect(copyResultSchema.safeParse(validCallback()).success).toBe(true);
    expect(
      copyResultSchema.safeParse({
        ...validCallback(),
        drafts: validCallback().drafts.slice(0, 1),
      }).success,
    ).toBe(false);
    expect(
      copyResultSchema.safeParse({
        ...validCallback(),
        drafts: [...validCallback().drafts, validCallback().drafts[0]],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed IDs, visual analysis, and warnings", () => {
    expect(
      copyResultSchema.safeParse({
        ...validCallback("not-a-uuid"),
        visualAnalysis: { summary: "unsupported shape" },
        warnings: [42],
      }).success,
    ).toBe(false);
  });
});

describe("POST /api/integrations/n8n/copy-result", () => {
  let repository: ReturnType<typeof createDemoRepository>;
  let handler: ReturnType<typeof createCopyResultHandler>;

  beforeEach(() => {
    repository = createDemoRepository({ initialContentState: "UPLOADED" });
    handler = createCopyResultHandler({
      getRepository: async () => repository,
      getSecret: () => SECRET,
      nowMs: () => NOW_MS,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the shared secret name used by the n8n workflow", async () => {
    vi.stubEnv("SNAPGAD_N8N_SHARED_SECRET", SECRET);
    const item = await repository.createContentItem(validBrief);
    await repository.beginCopyGeneration(item.id);
    const environmentHandler = createCopyResultHandler({
      getRepository: async () => repository,
      nowMs: () => NOW_MS,
    });

    const response = await environmentHandler(
      signedRequest(validCallback(item.id)),
    );

    expect(response.status).toBe(202);
  });

  it("rejects missing or invalid signatures before persistence", async () => {
    const ingest = vi.spyOn(repository, "ingestCopyResult");

    const missing = await handler(signedRequest(validCallback(), "missing"));
    const invalid = await handler(signedRequest(validCallback(), "sha256=bad"));

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects a signed callback whose schema is malformed", async () => {
    const response = await handler(
      signedRequest({ ...validCallback(), drafts: [validCallback().drafts[0]] }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_CALLBACK" });
  });

  it("persists drafts and a sanitized audit event once, then transitions GENERATING to DRAFT", async () => {
    const item = await repository.createContentItem(validBrief);
    await repository.beginCopyGeneration(item.id);
    const callback = validCallback(item.id);

    const first = await handler(signedRequest(callback));
    const second = await handler(signedRequest(callback));

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ created: true });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ created: false });

    expect((await repository.getContentItem(item.id))?.state).toBe("DRAFT");
    expect(await repository.listCopyDrafts(item.id)).toHaveLength(2);
    const events = await repository.listAuditEvents(item.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "COPY_CALLBACK_RECEIVED",
      metadata: { draftCount: 2, warningCount: 0 },
    });
    expect(JSON.stringify(events[0])).not.toContain(callback.drafts[0].body);
  });

  it("does not persist a valid callback unless the item is GENERATING", async () => {
    const item = await repository.createContentItem(validBrief);
    const response = await handler(signedRequest(validCallback(item.id)));

    expect(response.status).toBe(409);
    expect(await repository.listCopyDrafts(item.id)).toEqual([]);
    expect(await repository.listAuditEvents(item.id)).toEqual([]);
  });
});
