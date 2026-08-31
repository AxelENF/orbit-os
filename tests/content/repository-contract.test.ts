import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createDemoRepository } from "@/lib/demo/repository";
import { getContentRepositoryMode } from "@/lib/content/repository-factory";
import { AUTOMATION_RUN_KINDS } from "@/lib/content/repository";

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
  it("keeps idempotency distinct for a request and its callback", () => {
    expect(AUTOMATION_RUN_KINDS).toEqual([
      "COPY_REQUEST",
      "COPY_CALLBACK",
      "PUBLISH_REQUEST",
      "PUBLISH_CALLBACK",
    ]);
  });

  it("selects demo unless public and server-only Supabase settings are configured", () => {
    expect(getContentRepositoryMode({})).toBe("demo");
    expect(
      getContentRepositoryMode({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      }),
    ).toBe("demo");
    expect(
      getContentRepositoryMode({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      }),
    ).toBe("supabase");
  });

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

    expect(sql).toMatch(
      /insert into storage\.buckets[\s\S]*'content-assets'[\s\S]*false/i,
    );
    expect(sql).toMatch(
      /unique\s*\(\s*kind\s*,\s*idempotency_key\s*\)/i,
    );
    expect(sql).not.toMatch(/unique\s*\(\s*idempotency_key\s*\)/i);
    expect(sql).toMatch(/unique\s*\(\s*content_item_id\s*,\s*platform\s*\)/i);
    expect(sql).toMatch(
      /owner_id\s*=\s*\(select auth\.uid\(\)::text\)/i,
    );
    expect(sql).toMatch(/on storage\.objects[\s\S]*for select to authenticated/i);
    expect(sql).toMatch(/on storage\.objects[\s\S]*for insert to authenticated/i);
    expect(sql).not.toMatch(/create policy[\s\S]*for all/i);
    expect(sql).toMatch(
      /state\s*=\s*'UPLOADED'[\s\S]*auth\.uid\(\)\s*=\s*owner_id/i,
    );
    expect(sql).toMatch(/role public\.profile_role not null default 'reviewer'/i);
    expect(sql).toMatch(/create trigger on_auth_user_created/i);
    expect(sql).toMatch(/create function public\.set_updated_at\(\)/i);
    expect(sql).toMatch(/create trigger content_items_set_updated_at/i);
    expect(sql).toMatch(/create trigger publication_targets_set_updated_at/i);
    expect(sql).toMatch(/create trigger assert_content_item_asset_owner/i);
    expect(sql).toMatch(/create trigger assert_copy_draft_content_owner/i);
    expect(sql).toMatch(/create trigger assert_publication_target_content_owner/i);
    expect(sql).toMatch(/create trigger assert_automation_run_content_owner/i);

    for (const protectedTable of [
      "copy_drafts",
      "publication_targets",
      "automation_runs",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(
          `create policy[^;]*on public\\.${protectedTable}\\s+for (?:insert|update|delete)`,
          "i",
        ),
      );
    }
    expect(sql).not.toMatch(
      /create policy[^;]*on public\.audit_events\s+for (?:update|delete)/i,
    );
  });
});
