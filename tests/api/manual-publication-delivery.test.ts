import { describe, expect, it } from "vitest";

import { createManualDeliveryHandler } from "@/app/api/content/[id]/targets/[targetId]/manual-delivery/route";
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

async function approvedRecord() {
  const repository = createDemoRepository({ initialContentState: "REVIEW" });
  const item = await repository.createContentItem(brief);
  const [facebook, instagram] = await repository.listPublicationTargets(item.id);
  await repository.approvePublicationTarget(item.id, facebook!.id);
  await repository.approvePublicationTarget(item.id, instagram!.id);
  return { repository, item, facebook: facebook!, instagram: instagram! };
}

describe("manual publication delivery API", () => {
  it("records one human-delivered destination without calling a provider", async () => {
    const { repository, item, facebook, instagram } = await approvedRecord();
    const handler = createManualDeliveryHandler({ getRepository: async () => repository });
    const response = await handler(new Request("http://localhost/api/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        remoteUrl: "https://www.facebook.com/snapgad/posts/123",
        publishedAt: "2026-09-12T12:00:00.000Z",
        note: "Pauta por activar después de la revisión.",
        idempotencyKey: "eb6e5b0e-1a62-4a99-b3d5-3716a9b5c52d",
      }),
    }), { params: Promise.resolve({ id: item.id, targetId: facebook.id }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      target: {
        id: facebook.id,
        platform: "FACEBOOK",
        status: "PUBLISHED",
        remoteUrl: "https://www.facebook.com/snapgad/posts/123",
      },
    });
    expect((await repository.getContentItem(item.id))?.state).toBe("APPROVED");
    expect((await repository.listPublicationTargets(item.id)).find((target) => target.id === instagram.id)?.status).toBe("APPROVED");
    await expect(repository.listAuditEvents(item.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "MANUAL_PUBLICATION_RECORDED" }),
    ]));
  });

  it("is idempotent on an uncertain response and publishes the aggregate only after all targets", async () => {
    const { repository, item, facebook, instagram } = await approvedRecord();
    const handler = createManualDeliveryHandler({ getRepository: async () => repository });
    const input = {
      remoteUrl: "https://www.facebook.com/snapgad/posts/123",
      publishedAt: "2026-09-12T12:00:00.000Z",
      idempotencyKey: "eb6e5b0e-1a62-4a99-b3d5-3716a9b5c52d",
    };

    const first = await handler(new Request("http://localhost/api/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), { params: Promise.resolve({ id: item.id, targetId: facebook.id }) });
    const retry = await handler(new Request("http://localhost/api/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), { params: Promise.resolve({ id: item.id, targetId: facebook.id }) });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);

    const second = await handler(new Request("http://localhost/api/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, remoteUrl: "https://www.instagram.com/p/example/", idempotencyKey: "6f7f62bb-bd83-44c5-b015-1816077336f7" }),
    }), { params: Promise.resolve({ id: item.id, targetId: instagram.id }) });
    expect(second.status).toBe(200);
    expect((await repository.getContentItem(item.id))?.state).toBe("PUBLISHED");
  });

  it("rejects malformed evidence and delivery before both approvals", async () => {
    const repository = createDemoRepository({ initialContentState: "REVIEW" });
    const item = await repository.createContentItem(brief);
    const [facebook] = await repository.listPublicationTargets(item.id);
    const handler = createManualDeliveryHandler({ getRepository: async () => repository });

    const malformed = await handler(new Request("http://localhost/api/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }), { params: Promise.resolve({ id: item.id, targetId: facebook!.id }) });
    const blocked = await handler(new Request("http://localhost/api/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteUrl: "https://example.com/post", publishedAt: "2026-09-12T12:00:00.000Z", idempotencyKey: "eb6e5b0e-1a62-4a99-b3d5-3716a9b5c52d" }),
    }), { params: Promise.resolve({ id: item.id, targetId: facebook!.id }) });

    expect(malformed.status).toBe(400);
    expect(blocked.status).toBe(409);
  });
});
