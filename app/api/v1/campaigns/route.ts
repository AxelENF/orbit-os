import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  resolveV1RequestContext,
  V1AuthenticationError,
  V1NotConfiguredError,
} from "@/lib/api/v1-context";
import { campaignBriefSchema } from "@/lib/content/campaign";
import { AssetValidationError, MAX_ASSET_BYTES, validateAsset } from "@/lib/content/asset-validation";
import { composeLogoServerSide, LogoTooLargeError } from "@/lib/logo-studio/compose-server";

const MAX_MULTIPART_BYTES = MAX_ASSET_BYTES + 64_000;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { repository } = await resolveV1RequestContext(request);
    const items = repository.listContentSummaries
      ? await repository.listContentSummaries()
      : await repository.listContentItems();
    return Response.json({ items });
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    return jsonError("CAMPAIGN_LIST_FAILED", 500);
  }
}

function isFilePart(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value !== "string" && typeof value.arrayBuffer === "function");
}

export async function POST(request: Request): Promise<Response> {
  // Corrección ronda 1 de revisión del plan: límite de multipart ANTES de
  // leer el body, igual que app/api/content/route.ts:75-78 — la versión
  // anterior de este plan lo omitía por completo.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
    return jsonError("ASSET_TOO_LARGE", 413);
  }

  try {
    const { repository } = await resolveV1RequestContext(request);

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("INVALID_MULTIPART_REQUEST", 400);
    }

    const rawBrief = formData.get("brief");
    const assetFile = formData.get("asset");
    if (typeof rawBrief !== "string" || !isFilePart(assetFile)) {
      return jsonError("BRIEF_AND_ASSET_REQUIRED", 400);
    }

    let briefPayload: unknown;
    try {
      briefPayload = JSON.parse(rawBrief);
    } catch {
      return jsonError("INVALID_BRIEF", 400);
    }

    campaignBriefSchema.parse(briefPayload);
    let validatedAsset = await validateAsset(assetFile);
    let finalBytes = validatedAsset.bytes;

    // Estampa el logo de la organización automáticamente si existe — sin
    // logo configurado (downloadOrganizationLogo devuelve null), sigue con
    // el creativo original, sin error (ver spec: "Composición de logo
    // server-side"). El resultado se revalida completo con validateAsset
    // otra vez — recalcula dimensiones/MIME, no confía en el compositor.
    const logoBytes = await repository.downloadOrganizationLogo();
    if (logoBytes) {
      const composedBytes = await composeLogoServerSide({
        creativeBytes: Buffer.from(validatedAsset.bytes),
        logoBytes,
        options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
        outputFormat: validatedAsset.mimeType === "image/png" ? "image/png" : "image/jpeg",
      });
      const composedFile = new File(
        [composedBytes as unknown as BlobPart],
        assetFile.name,
        { type: validatedAsset.mimeType === "image/png" ? "image/png" : "image/jpeg" },
      );
      validatedAsset = await validateAsset(composedFile);
      finalBytes = validatedAsset.bytes;
    }

    // Corrección ronda 1: checksum real sobre los bytes FINALES (compuestos
    // o no), igual que app/api/content/route.ts:103-105 — no un placeholder.
    const checksum = createHash("sha256").update(finalBytes).digest("hex");

    const content = await repository.createContentItemWithAsset({
      brief: briefPayload,
      asset: {
        id: randomUUID(),
        filename: assetFile.name,
        mimeType: validatedAsset.mimeType,
        width: validatedAsset.width,
        height: validatedAsset.height,
        checksum,
        bytes: finalBytes,
      },
    });

    // Corrección ronda 1 (hallazgo real): la versión anterior nunca llamaba
    // enqueueCopyJob y devolvía state: "GENERATING" de todas formas, aunque
    // la base quedaba en UPLOADED sin ningún job de generación encolado —
    // ahora replica exactamente app/api/content/route.ts:119-133.
    try {
      await repository.enqueueCopyJob({
        contentItemId: content.id,
        idempotencyKey: randomUUID(),
      });
    } catch {
      return Response.json({ content, warning: "COPY_QUEUE_PENDING" }, { status: 202 });
    }

    return Response.json({ content: { ...content, state: "GENERATING" } }, { status: 201 });
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    if (error instanceof z.ZodError || error instanceof AssetValidationError) {
      return jsonError("INVALID_CONTENT_ASSET", 400);
    }
    if (error instanceof LogoTooLargeError) return jsonError("LOGO_TOO_LARGE", 503);
    return jsonError("CAMPAIGN_CREATE_FAILED", 500);
  }
}
