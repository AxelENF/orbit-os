/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/v1-context", () => ({
  resolveV1RequestContext: vi.fn(),
  V1AuthenticationError: class V1AuthenticationError extends Error {},
  V1NotConfiguredError: class V1NotConfiguredError extends Error {},
}));
vi.mock("@/lib/logo-studio/compose-server", () => ({
  composeLogoServerSide: vi.fn(),
  LogoTooLargeError: class LogoTooLargeError extends Error {},
}));

import { GET as listCampaigns, POST as createCampaign } from "@/app/api/v1/campaigns/route";
import { GET as getCampaign } from "@/app/api/v1/campaigns/[id]/route";
import { resolveV1RequestContext, V1AuthenticationError } from "@/lib/api/v1-context";
import { composeLogoServerSide } from "@/lib/logo-studio/compose-server";

// Corrección ronda 3 de revisión del plan (hallazgo real): este proyecto
// no tiene clearMocks/restoreMocks configurado globalmente
// (vitest.config.ts) — sin este afterEach, el historial de llamadas de
// composeLogoServerSide (y de los demás mocks a nivel de módulo) se
// acumula entre tests del mismo archivo. El test "sin logo configurado"
// exige composeLogoServerSide NOT toHaveBeenCalled(), lo cual solo es
// significativo si el conteo de llamadas se resetea antes de cada test.
afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/campaigns", () => {
  it("responds 401 when authentication fails, without leaking whether the key format was merely wrong", async () => {
    vi.mocked(resolveV1RequestContext).mockRejectedValue(new V1AuthenticationError());
    const response = await listCampaigns(new Request("http://localhost/api/v1/campaigns"));
    expect(response.status).toBe(401);
  });

  it("lists campaigns for the organization resolved from the key", async () => {
    const listContentSummaries = vi.fn().mockResolvedValue([{ id: "content-1" }]);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { listContentSummaries } as never,
    });
    const response = await listCampaigns(new Request("http://localhost/api/v1/campaigns"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [{ id: "content-1" }] });
  });
});

describe("GET /api/v1/campaigns/:id", () => {
  it("responds 404 for a campaign that doesn't belong to this organization (repository already scopes by organization_id)", async () => {
    const getContentRecord = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { getContentRecord } as never,
    });
    const response = await getCampaign(
      new Request("http://localhost"),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    expect(response.status).toBe(404);
  });
});

// Corrección ronda 2 de revisión del plan (hallazgo real): este helper no
// existía en ningún lado del repositorio — la ronda 1 lo referenciaba como
// si ya existiera. `validateAsset` (lib/content/asset-validation.ts) solo
// lee la firma PNG (8 bytes) y el ancho/alto del chunk IHDR (offsets 16 y
// 20, big-endian) para sus checks de dimensión/aspecto — NO decodifica
// píxeles reales, así que un IHDR mínimo y correcto basta, sin necesidad
// de datos de imagen comprimidos válidos ni de una librería de imágenes real.
function makeValidPng(width = 1080, height = 1350): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // firma PNG
  bytes.set([0, 0, 0, 13], 8); // longitud del chunk IHDR (13, big-endian)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24); // bit depth, color type, compression, filter, interlace
  bytes.set([0, 0, 0, 0], 29); // CRC (no validado por inspectImageDimensions)
  return bytes;
}

describe("POST /api/v1/campaigns", () => {
  // Corrección ronda 3 de revisión del plan (hallazgo real): la ronda
  // anterior inventaba valores de enum ("IMAGE", "SINGLE_IMAGE", "TOFU",
  // "WHATSAPP") que no existen en los schemas reales — campaignBriefSchema.parse
  // los habría rechazado con 400 antes de llegar a componer/encolar nada.
  // Estos valores son los mismos que ya usa el fixture `validBrief` de
  // tests/content/supabase-repository.test.ts:24-34 (contentType/objective/
  // format vienen de CONTENT_TYPES/CONTENT_OBJECTIVES/CONTENT_FORMATS,
  // lib/content/constants.ts) más los campos que campaignBriefSchema agrega
  // (funnelStage ∈ lib/content/campaign.ts:7-12, destination ∈ :14).
  function formDataRequest(png: Uint8Array) {
    const formData = new FormData();
    formData.set("brief", JSON.stringify({
      businessLine: "CONTROLAR", service: "pos", niche: "clinicas",
      contentType: "educativo", objective: "conversaciones_whatsapp", format: "feed_4_5",
      cta: "Escribe POS por WhatsApp", humanDescription: "Mostrar el corte de caja de una clínica.",
      allowedFacts: ["El POS registra ventas y cortes de caja."],
      campaignName: "Agenda clínica septiembre", offer: "Automatización de agenda",
      funnelStage: "captacion", destination: "whatsapp",
      destinationValue: "https://wa.me/5215555555555?text=AGENDA",
    }));
    formData.set("asset", new File([png as unknown as BlobPart], "creative.png", { type: "image/png" }));
    return new Request("http://localhost", { method: "POST", body: formData });
  }

  it("stamps the organization's logo onto the creative automatically when one is configured", async () => {
    const validCreativePng = makeValidPng();
    // Corrección ronda 2 de revisión del plan (hallazgo real): la versión
    // anterior mockeaba composeLogoServerSide devolviendo
    // Buffer.from("composed-bytes") — bytes que no son un PNG válido. El
    // handler revalida el resultado con el validateAsset REAL después de
    // componer (fix de la ronda 1), así que ese mock habría hecho fallar
    // la request con 400 en vez de 201. El mock debe devolver un PNG
    // realmente válido para que la revalidación posterior lo acepte.
    const composedBuffer = Buffer.from(makeValidPng());
    vi.mocked(composeLogoServerSide).mockResolvedValue(composedBuffer);
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockResolvedValue({ created: true });
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(Buffer.from("logo-bytes"));
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(response.status).toBe(201);
    expect(downloadOrganizationLogo).toHaveBeenCalled();
    expect(composeLogoServerSide).toHaveBeenCalled();
    // El asset persistido debe ser el resultado COMPUESTO, no el creativo
    // original — confirma que los bytes que llegan a
    // createContentItemWithAsset vienen de composedBuffer, no del PNG crudo
    // subido en la request.
    const persistedAsset = createContentItemWithAsset.mock.calls[0][0].asset;
    expect(Buffer.from(persistedAsset.bytes)).toEqual(composedBuffer);
  });

  it("creates the campaign without a logo, without error, when the organization has none configured yet", async () => {
    const validCreativePng = makeValidPng();
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockResolvedValue({ created: true });
    // downloadOrganizationLogo resuelve null cuando no hay logo — el
    // manejo de StorageApiError/NoSuchKey vive DENTRO de la implementación
    // real del repositorio (Step 3), nunca se filtra hasta esta ruta.
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(response.status).toBe(201);
    expect(composeLogoServerSide).not.toHaveBeenCalled();
    const persistedAsset = createContentItemWithAsset.mock.calls[0][0].asset;
    expect(Buffer.from(persistedAsset.bytes)).toEqual(Buffer.from(validCreativePng));
  });

  it("enqueues the copy generation job after creating the item, matching POST /api/content's behavior exactly", async () => {
    const validCreativePng = makeValidPng();
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockResolvedValue({ created: true });
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(enqueueCopyJob).toHaveBeenCalledWith(
      expect.objectContaining({ contentItemId: "content-1" }),
    );
    const body = await response.json();
    expect(body.content.state).toBe("GENERATING");
  });

  it("responds 202 with COPY_QUEUE_PENDING, not a false GENERATING state, when the queue is temporarily unavailable", async () => {
    // Mismo comportamiento que app/api/content/route.ts:119-132 — el asset
    // ya se persistió de forma durable, así que esto no es un error, es un
    // 202 con advertencia para que el caller pueda reintentar el encolado.
    const validCreativePng = makeValidPng();
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.warning).toBe("COPY_QUEUE_PENDING");
  });

  it("rejects a request over the multipart size limit with 413 before even reading the body", async () => {
    const request = formDataRequest(makeValidPng());
    Object.defineProperty(request, "headers", {
      value: new Headers({ "content-length": String(25 * 1024 * 1024) }),
    });
    const response = await createCampaign(request);
    expect(response.status).toBe(413);
  });
});
