import { describe, expect, it, vi } from "vitest";
import { createSuggestionsHandler } from "@/app/api/content/suggestions/route";

function multipartRequest(file: File): Request {
  const formData = new FormData();
  formData.append("asset", file);
  return new Request("https://orbit.example/api/content/suggestions", { method: "POST", body: formData });
}

// Mismo fixture mínimo de cabecera PNG que usa tests/content/asset-validation.test.ts:5-11
// (pngBytes no está exportado desde ese archivo — se duplica localmente,
// es un fixture de 6 líneas, no amerita un módulo compartido nuevo).
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

const validPngBytes = pngBytes(540, 675); // dimensiones mínimas válidas, ver MIN_ASSET_WIDTH/HEIGHT en asset-validation.ts

describe("POST /api/content/suggestions", () => {
  it("401 sin organización resuelta (sin sesión)", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockRejectedValue(new (class extends Error {})()),
    } as never);
    const response = await handler(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));
    expect(response.status).toBe(401);
  });

  it("400 si el archivo no pasa validateAsset", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
    } as never);
    const response = await handler(multipartRequest(new File([blobPart(new Uint8Array([1, 2, 3]))], "bad.txt")));
    expect(response.status).toBe(400);
  });

  it("200 con sugerencias cuando todo sale bien", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(true),
      fetchSuggestions: vi.fn().mockResolvedValue({
        suggestions: { niche: "clinicas", contentType: null, objective: null, humanDescription: null, offer: null, cta: null },
        usage: { provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 },
      }),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    } as never);
    const response = await handler(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));
    expect(response.status).toBe(200);
    const body = await response.json() as { suggestions: unknown };
    expect(body.suggestions).toMatchObject({ niche: "clinicas" });
  });

  it("200 con suggestions:null cuando no hay presupuesto (no llama OpenRouter)", async () => {
    const fetchSuggestions = vi.fn();
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(false),
      fetchSuggestions,
    } as never);
    const response = await handler(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));
    expect(response.status).toBe(200);
    expect((await response.json() as { suggestions: unknown }).suggestions).toBeNull();
    expect(fetchSuggestions).not.toHaveBeenCalled();
  });

  it("503 cuando falta configuración del proveedor", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(true),
      fetchSuggestions: vi.fn().mockRejectedValue(new Error("SNAPGAD_INTAKE_SUGGEST_OPENROUTER_MODEL is required for intake suggestions.")),
    } as never);
    const response = await handler(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));
    expect(response.status).toBe(503);
  });

  it("registra el uso cuando hubo respuesta real de OpenRouter, incluso si suggestions terminó null", async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(true),
      fetchSuggestions: vi.fn().mockResolvedValue({
        suggestions: null,
        usage: { provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 },
      }),
      recordUsage,
    } as never);
    await handler(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));
    expect(recordUsage).toHaveBeenCalledWith("org-1", expect.objectContaining({ model: "m" }));
  });
});
