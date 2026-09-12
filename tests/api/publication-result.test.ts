import { describe, expect, it } from "vitest";

import { createPublicationResultHandler } from "@/app/api/content/[id]/targets/[targetId]/result/route";
import { createDemoRepository } from "@/lib/demo/repository";

const brief = {
  businessLine: "AUTOMATIZAR" as const,
  service: "bot_whatsapp" as const,
  niche: "clinicas" as const,
  contentType: "venta_directa" as const,
  objective: "agenda_demo" as const,
  format: "feed_4_5" as const,
  cta: "Escribe AGENDA por WhatsApp",
  humanDescription: "Mostrar un bot que agenda citas.",
  allowedFacts: ["El bot atiende preguntas y ayuda a agendar citas."],
};

async function publishedTarget() {
  const repository = createDemoRepository({ initialContentState: "REVIEW" });
  const item = await repository.createContentItem(brief);
  const [facebook, instagram] = await repository.listPublicationTargets(item.id);
  await repository.approvePublicationTarget(item.id, facebook!.id);
  await repository.approvePublicationTarget(item.id, instagram!.id);
  await repository.recordManualPublicationDelivery({
    contentItemId: item.id,
    publicationTargetId: facebook!.id,
    remoteUrl: "https://www.facebook.com/snapgad/posts/123",
    publishedAt: "2026-09-12T12:00:00.000Z",
    idempotencyKey: "eb6e5b0e-1a62-4a99-b3d5-3716a9b5c52d",
  });
  return { repository, item, facebook: facebook! };
}

const metrics = {
  observedAt: "2026-09-12T18:00:00.000Z",
  reach: 1_250,
  impressions: 1_940,
  conversations: 18,
  qualifiedLeads: 7,
  appointments: 3,
  spendMxn: 50,
  revenueMxn: 2_000,
  note: "Primer corte a las seis horas.",
  idempotencyKey: "6f7f62bb-bd83-44c5-b015-1816077336f7",
};

describe("publication result API", () => {
  it("records an observed result only after the destination is published", async () => {
    const { repository, item, facebook } = await publishedTarget();
    const handler = createPublicationResultHandler({ getRepository: async () => repository });
    const response = await handler(new Request("http://localhost/api/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metrics),
    }), { params: Promise.resolve({ id: item.id, targetId: facebook.id }) });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      result: { publicationTargetId: facebook.id, conversations: 18, spendMxn: 50 },
    });
    await expect(repository.getContentRecord(item.id)).resolves.toMatchObject({
      publicationResults: [expect.objectContaining({ appointments: 3, revenueMxn: 2_000 })],
      auditEvents: expect.arrayContaining([expect.objectContaining({ type: "PUBLICATION_RESULT_RECORDED" })]),
    });
  });

  it("keeps an uncertain retry idempotent and rejects invalid metrics", async () => {
    const { repository, item, facebook } = await publishedTarget();
    const handler = createPublicationResultHandler({ getRepository: async () => repository });
    const request = () => new Request("http://localhost/api/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metrics),
    });

    expect((await handler(request(), { params: Promise.resolve({ id: item.id, targetId: facebook.id }) })).status).toBe(201);
    expect((await handler(request(), { params: Promise.resolve({ id: item.id, targetId: facebook.id }) })).status).toBe(201);
    expect((await repository.getContentRecord(item.id))?.publicationResults).toHaveLength(1);

    const invalid = await handler(new Request("http://localhost/api/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...metrics, reach: -1, idempotencyKey: "711ebd0e-939b-49a1-91cf-f1c53d6dde78" }),
    }), { params: Promise.resolve({ id: item.id, targetId: facebook.id }) });
    expect(invalid.status).toBe(400);
  });
});
