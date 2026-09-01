/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";

import { persistDemoAsset, clearDemoAssets } from "@/lib/demo/browser-assets";
import {
  approveDemoTarget,
  clearDemoDrafts,
  persistDemoDraft,
  readDemoDrafts,
  submitDemoDraftForReview,
} from "@/lib/demo/draft-store";
import type { ContentItem } from "@/lib/content/repository";

const content: ContentItem = {
  id: "content-item-id",
  businessLine: "AUTOMATIZAR",
  service: "bot_whatsapp",
  niche: "clinicas",
  contentType: "prueba",
  objective: "conversaciones_whatsapp",
  format: "feed_4_5",
  cta: "Escribe AGENDA",
  humanDescription: "Atiende solicitudes y agenda citas.",
  allowedFacts: ["Responde solicitudes.", "Agenda citas."],
  state: "DRAFT",
  createdAt: "2026-08-31T00:00:00.000Z",
};

describe("demo draft store", () => {
  afterEach(() => {
    clearDemoDrafts();
    clearDemoAssets();
  });

  it("persists two local options and independent target approvals", async () => {
    await persistDemoAsset(content, new File(["png"], "demo.png", { type: "image/png" }));
    const record = persistDemoDraft(content);

    expect(record?.drafts).toHaveLength(2);
    expect(record?.visualAnalysis.source).toBe("local-demo");
    expect(record?.warnings.join(" ")).toContain("no se ejecutó IA");

    const inReview = submitDemoDraftForReview(content.id, record!.finalCopy, record!.selectedDraftId);
    const facebook = approveDemoTarget(content.id, inReview!.targets[0]!.id);

    expect(facebook?.targets.find((target) => target.platform === "FACEBOOK")?.status).toBe("APPROVED");
    expect(facebook?.targets.find((target) => target.platform === "INSTAGRAM")?.status).toBe("PENDING_REVIEW");
    expect(facebook?.content.state).toBe("REVIEW");
    expect(readDemoDrafts()[0]?.auditEvents.some((event) => event.type === "TARGET_APPROVED")).toBe(true);
  });
});
