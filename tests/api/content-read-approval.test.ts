import { describe, expect, it } from "vitest";

import { createContentListHandler } from "@/app/api/content/route";
import { createContentDetailHandler } from "@/app/api/content/[id]/route";
import { createApproveTargetHandler } from "@/app/api/content/[id]/targets/[targetId]/approve/route";
import { createDemoRepository } from "@/lib/demo/repository";
import { ContentAuthenticationError } from "@/lib/content/repository-factory";

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

describe("content read and approval API", () => {
  it("lists and returns an owner-scoped content record", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(brief);
    const list = await createContentListHandler({
      getRepository: async () => repository,
    })();
    const detail = await createContentDetailHandler({
      getRepository: async () => repository,
    })(new Request("http://localhost/api/content/" + item.id), {
      params: Promise.resolve({ id: item.id }),
    });

    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: item.id, service: "bot_whatsapp" })],
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      content: { id: item.id },
      targets: [
        { platform: "FACEBOOK", status: "PENDING_REVIEW" },
        { platform: "INSTAGRAM", status: "PENDING_REVIEW" },
      ],
      drafts: [],
      auditEvents: [],
    });
  });

  it("uses the lightweight campaign projection when the repository provides it", async () => {
    const summary = {
      id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
      state: "REVIEW" as const,
      createdAt: "2026-09-08T00:00:00.000Z",
      service: "bot_whatsapp" as const,
      niche: "clinicas" as const,
      contentType: "venta_directa" as const,
      objective: "agenda_demo" as const,
      hasActionableTarget: true,
    };
    const repository = {
      listContentItems: async () => {
        throw new Error("detail records must not be loaded for the list");
      },
      listContentSummaries: async () => [summary],
    };

    const response = await createContentListHandler({
      getRepository: async () => repository,
    })();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [summary] });
  });

  it("returns safe errors for malformed and missing records", async () => {
    const repository = createDemoRepository();
    const handler = createContentDetailHandler({
      getRepository: async () => repository,
    });

    const malformed = await handler(new Request("http://localhost/api/content/not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    const missing = await handler(new Request("http://localhost/api/content/missing"), {
      params: Promise.resolve({ id: "e7e7d4d8-4bc0-4e61-8d3e-9b7cbb1cf9b0" }),
    });

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "INVALID_CONTENT_ID" });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "CONTENT_NOT_FOUND" });
  });

  it("does not expose production records without an authenticated session", async () => {
    const response = await createContentListHandler({
      getRepository: async () => {
        throw new ContentAuthenticationError();
      },
    })();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "AUTHENTICATION_REQUIRED" });
  });

  it("approves exactly one target, is idempotent, and promotes content only after both targets", async () => {
    const repository = createDemoRepository({ initialContentState: "REVIEW" });
    const item = await repository.createContentItem(brief);
    const [facebook, instagram] = await repository.listPublicationTargets(item.id);
    const handler = createApproveTargetHandler({
      getRepository: async () => repository,
    });

    const first = await handler(new Request("http://localhost/api/approve"), {
      params: Promise.resolve({ id: item.id, targetId: facebook!.id }),
    });
    const retry = await handler(new Request("http://localhost/api/approve"), {
      params: Promise.resolve({ id: item.id, targetId: facebook!.id }),
    });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      target: { id: facebook!.id, platform: "FACEBOOK", status: "APPROVED" },
    });
    expect(retry.status).toBe(200);
    expect((await repository.getContentItem(item.id))?.state).toBe("REVIEW");
    expect((await repository.listPublicationTargets(item.id))[1]).toEqual(instagram);

    await handler(new Request("http://localhost/api/approve"), {
      params: Promise.resolve({ id: item.id, targetId: instagram!.id }),
    });
    expect((await repository.getContentItem(item.id))?.state).toBe("APPROVED");
    expect(await repository.listAuditEvents(item.id)).toHaveLength(2);
  });

  it("rejects approval when content is not in human review", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(brief);
    const [facebook] = await repository.listPublicationTargets(item.id);
    const handler = createApproveTargetHandler({
      getRepository: async () => repository,
    });

    const response = await handler(new Request("http://localhost/api/approve"), {
      params: Promise.resolve({ id: item.id, targetId: facebook!.id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "TARGET_NOT_REVIEWABLE" });
  });
});
