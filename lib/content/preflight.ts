import { campaignBriefSchema } from "@/lib/content/campaign";
import type { FinalCopyInput } from "@/lib/content/final-copy";
import { validateFinalCopy } from "@/lib/content/final-copy";

export type PreflightCheck = {
  name: "asset" | "destination" | "finalCopy";
  ok: boolean;
  reasons: string[];
};

export type CampaignPreflight = {
  ok: boolean;
  checks: PreflightCheck[];
};

type PreflightAsset = {
  mimeType: string;
  width: number;
  height: number;
};

function validateAssetShape(asset: PreflightAsset): PreflightCheck {
  const allowedMime = ["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType);
  const correctRatio = asset.height > 0 && Math.abs(asset.width / asset.height - 4 / 5) <= 0.015;
  const correctSize = asset.width >= 540 && asset.height >= 675;
  const reasons: string[] = [];
  if (!allowedMime) reasons.push("El asset debe ser PNG, JPG o WEBP.");
  if (!correctSize || !correctRatio) {
    reasons.push("El asset debe medir al menos 540 × 675 px en formato vertical 4:5.");
  }
  return { name: "asset", ok: reasons.length === 0, reasons };
}

export function createCampaignPreflight(input: {
  campaign: unknown;
  asset: PreflightAsset;
  finalCopy: FinalCopyInput;
}): CampaignPreflight {
  const campaign = campaignBriefSchema.safeParse(input.campaign);
  const asset = validateAssetShape(input.asset);
  const destination: PreflightCheck = campaign.success
    ? { name: "destination", ok: true, reasons: [] }
    : {
        name: "destination",
        ok: false,
        reasons: ["La oferta, el funnel y la URL de destino deben estar completos y ser válidos."],
      };
  const finalCopyValidation = campaign.success
    ? validateFinalCopy(input.finalCopy, campaign.data)
    : { ok: false, reasons: ["No se puede validar el copy sin un brief de campaña válido."] };
  const finalCopy: PreflightCheck = {
    name: "finalCopy",
    ok: finalCopyValidation.ok,
    reasons: finalCopyValidation.reasons,
  };
  const checks = [asset, destination, finalCopy];
  return { ok: checks.every((check) => check.ok), checks };
}
