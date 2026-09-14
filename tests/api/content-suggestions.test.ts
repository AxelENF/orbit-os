import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import { createActiveOrganizationCookieValue } from "@/lib/organizations/active-organization-cookie";

const routeMocks = vi.hoisted(() => ({
  getContentRepositoryMode: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(),
  hasBudget: vi.fn(),
  recordUsage: vi.fn(),
  fetchSuggestions: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("@/lib/content/repository-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/content/repository-factory")>();
  return { ...actual, getContentRepositoryMode: routeMocks.getContentRepositoryMode };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: routeMocks.createSupabaseServerClient,
  createSupabaseServiceRoleClient: routeMocks.createSupabaseServiceRoleClient,
}));

vi.mock("@/lib/content/intake-suggestion-budget", () => ({
  hasIntakeSuggestionBudget: routeMocks.hasBudget,
  recordIntakeSuggestionUsage: routeMocks.recordUsage,
}));

vi.mock("@/lib/content/intake-suggestions", () => ({
  fetchIntakeSuggestions: routeMocks.fetchSuggestions,
}));

vi.mock("next/headers", () => ({ cookies: routeMocks.cookies }));

import { POST, createSuggestionsHandler } from "@/app/api/content/suggestions/route";

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
  const previousCookieSecret = process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET;
    routeMocks.hasBudget.mockResolvedValue(true);
    routeMocks.recordUsage.mockResolvedValue(undefined);
    routeMocks.fetchSuggestions.mockResolvedValue({
      suggestions: { niche: "clinicas", contentType: null, objective: null, humanDescription: null, offer: null, cta: null },
      usage: { provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 },
    });
    routeMocks.createSupabaseServiceRoleClient.mockReturnValue({});
  });

  afterEach(() => {
    if (previousCookieSecret === undefined) {
      delete process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET;
    } else {
      process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET = previousCookieSecret;
    }
  });

  function sessionClient(
    user: { id: string } | null,
    memberships: Array<{ organization_id: string; user_id: string; role: "owner" | "admin" | "editor" | "viewer" }>,
  ) {
    return {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: memberships, error: null }),
        })),
      })),
    };
  }

  it("usa el POST exportado y responde 503 sin configuración de Supabase", async () => {
    routeMocks.getContentRepositoryMode.mockReturnValue("demo");

    const response = await POST(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "INTEGRATION_NOT_CONFIGURED" });
    expect(routeMocks.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("usa el POST exportado y responde 401 sin sesión autenticada", async () => {
    routeMocks.getContentRepositoryMode.mockReturnValue("supabase");
    routeMocks.createSupabaseServerClient.mockResolvedValue(sessionClient(null, []));

    const response = await POST(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "AUTHENTICATION_REQUIRED" });
  });

  it("usa la única organización autenticada al procesar el POST exportado", async () => {
    routeMocks.getContentRepositoryMode.mockReturnValue("supabase");
    routeMocks.createSupabaseServerClient.mockResolvedValue(sessionClient({ id: "user-a" }, [
      { organization_id: "organization-a", user_id: "user-a", role: "owner" },
    ]));

    const response = await POST(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));

    expect(response.status).toBe(200);
    expect(routeMocks.recordUsage).toHaveBeenCalledWith(expect.anything(), "organization-a", expect.objectContaining({ model: "m" }));
  });

  it("usa la organización activa de la cookie al procesar varias organizaciones con el POST exportado", async () => {
    const secret = "test-secret";
    process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET = secret;
    routeMocks.getContentRepositoryMode.mockReturnValue("supabase");
    routeMocks.createSupabaseServerClient.mockResolvedValue(sessionClient({ id: "user-a" }, [
      { organization_id: "organization-a", user_id: "user-a", role: "owner" },
      { organization_id: "organization-b", user_id: "user-a", role: "editor" },
    ]));
    routeMocks.cookies.mockResolvedValue({
      get: vi.fn(() => ({
        value: createActiveOrganizationCookieValue(
          { organizationId: "organization-b", userId: "user-a" },
          secret,
        ),
      })),
    });

    const response = await POST(multipartRequest(new File([blobPart(validPngBytes)], "a.png", { type: "image/png" })));

    expect(response.status).toBe(200);
    expect(routeMocks.recordUsage).toHaveBeenCalledWith(expect.anything(), "organization-b", expect.objectContaining({ model: "m" }));
  });

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
