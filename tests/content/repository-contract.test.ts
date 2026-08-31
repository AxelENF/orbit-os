import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createDemoRepository } from "@/lib/demo/repository";

const validBrief = {
  businessLine: "CONTROLAR",
  service: "pos",
  niche: "clinicas",
  contentType: "educativo",
  objective: "conversaciones_whatsapp",
  format: "feed_4_5",
  cta: "Escribe POS por WhatsApp",
  humanDescription: "Mostrar el corte de caja de una clínica.",
  allowedFacts: ["El POS registra ventas y cortes de caja."],
};

describe("content repository contract", () => {
  it("creates a content item with independent Facebook and Instagram targets", async () => {
    const repository = createDemoRepository();

    const item = await repository.createContentItem(validBrief);
    const targets = await repository.listPublicationTargets(item.id);

    expect(targets.map((target) => target.platform)).toEqual([
      "FACEBOOK",
      "INSTAGRAM",
    ]);
    expect(targets.every((target) => target.status === "PENDING_REVIEW")).toBe(
      true,
    );
    expect(new Set(targets.map((target) => target.id)).size).toBe(2);
  });

  it("rejects a content item whose brief is not valid", async () => {
    const repository = createDemoRepository();

    await expect(
      repository.createContentItem({ ...validBrief, allowedFacts: [] }),
    ).rejects.toThrow();
  });
});

describe("content storage migration", () => {
  it("defines owner-scoped tables, private storage, and idempotency constraints", async () => {
    const migrationPath = fileURLToPath(
      new URL("../../supabase/migrations/0001_content_os.sql", import.meta.url),
    );
    const sql = await readFile(migrationPath, "utf8");

    for (const table of [
      "profiles",
      "assets",
      "content_items",
      "copy_drafts",
      "publication_targets",
      "automation_runs",
      "audit_events",
    ]) {
      expect(sql).toMatch(new RegExp(`create table public\\.${table}`, "i"));
      expect(sql).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      );
    }

    expect(sql).toMatch(/insert into storage\.buckets[\s\S]*'content-assets'[\s\S]*false/i);
    expect(sql).toMatch(/unique\s*\(\s*idempotency_key\s*\)/i);
    expect(sql).toMatch(/unique\s*\(\s*content_item_id\s*,\s*platform\s*\)/i);
    expect(sql).toMatch(/auth\.uid\(\)\s*=\s*owner_id/i);
  });
});
