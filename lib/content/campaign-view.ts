import type { ContentState } from "@/lib/content/state-machine";
import type { ContentSummary } from "@/lib/content/repository";

export const CAMPAIGN_STATUS_LABELS: Record<ContentState, string> = {
  UPLOADED: "Listo para analizar",
  GENERATING: "Analizando",
  DRAFT: "Requiere revisión",
  REVIEW: "Tu aprobación",
  APPROVED: "Aprobada",
  SCHEDULED: "Programada",
  PUBLISHED: "Publicada",
  REJECTED: "Requiere cambios",
  ERROR: "Necesita atención",
};

export function campaignNextAction(item: ContentSummary): string {
  switch (item.state) {
    case "UPLOADED": return "Solicitar análisis";
    case "GENERATING": return "Esperar análisis";
    case "DRAFT": return "Elegir copy";
    case "REVIEW": return "Revisar publicación";
    case "APPROVED": return "Programar campaña";
    case "SCHEDULED": return "Ver programación";
    case "PUBLISHED": return "Ver resultados";
    case "REJECTED":
    case "ERROR": return "Corregir campaña";
  }
}

export function campaignTitle(item: ContentSummary): string {
  return item.campaign?.campaignName || `${item.service.replaceAll("_", " ")} · ${item.niche.replaceAll("_", " ")}`;
}
