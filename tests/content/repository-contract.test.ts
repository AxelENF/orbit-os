import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createDemoRepository } from "@/lib/demo/repository";
import {
  ContentConfigurationError,
  createContentRepository,
  getContentRepositoryMode,
  OrganizationSelectionRequiredError,
  resetDemoRepositoryForTests,
  selectOrganizationMembership,
  selectSingleOrganizationMembership,
} from "@/lib/content/repository-factory";
import { OrganizationAccessError } from "@/lib/organizations/context";
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

const validCampaign = {
  ...validBrief,
  campaignName: "Agenda clínica septiembre",
  offer: "Automatización de agenda por WhatsApp",
  funnelStage: "captacion",
  destination: "whatsapp",
  destinationValue: "https://wa.me/5215555555555?text=AGENDA",
};

describe("content repository contract", () => {
  it("rejects a user without an organization membership", () => {
    expect(() => selectSingleOrganizationMembership([])).toThrow(
      OrganizationAccessError,
    );
  });

  it("uses the only available organization membership", () => {
    expect(
      selectSingleOrganizationMembership([
        {
          organization_id: "organization-a",
          user_id: "user-a",
          role: "owner",
        },
      ]),
    ).toEqual({
      organizationId: "organization-a",
      userId: "user-a",
      role: "owner",
    });
  });

  it("requires an explicit active organization when a user belongs to multiple organizations", () => {
    expect(() =>
      selectSingleOrganizationMembership([
        {
          organization_id: "organization-a",
          user_id: "user-a",
          role: "owner",
        },
        {
          organization_id: "organization-b",
          user_id: "user-a",
          role: "editor",
        },
      ]),
    ).toThrow(OrganizationSelectionRequiredError);
  });

  it("resolves an explicitly selected organization only when it belongs to the session", () => {
    const memberships = [
      {
        organization_id: "organization-a",
        user_id: "user-a",
        role: "owner" as const,
      },
      {
        organization_id: "organization-b",
        user_id: "user-a",
        role: "editor" as const,
      },
    ];

    expect(selectOrganizationMembership(memberships, "organization-b")).toEqual({
      organizationId: "organization-b",
      userId: "user-a",
      role: "editor",
    });
    expect(() => selectOrganizationMembership(memberships, "organization-c")).toThrow(
      OrganizationAccessError,
    );
  });

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
    ).toBe("misconfigured");
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

  it("keeps demo content across separate factory resolutions", async () => {
    resetDemoRepositoryForTests();
    const firstRepository = await createContentRepository({ environment: {} });
    const item = await firstRepository.createContentItem(validBrief);
    const secondRepository = await createContentRepository({ environment: {} });

    await expect(secondRepository.listPublicationTargets(item.id)).resolves.toHaveLength(
      2,
    );
  });

  it("fails closed instead of falling back to demo when Supabase is partial", async () => {
    await expect(
      createContentRepository({
        environment: {
          NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        },
      }),
    ).rejects.toBeInstanceOf(ContentConfigurationError);
  });

  it("rejects a content item whose brief is not valid", async () => {
    const repository = createDemoRepository();

    await expect(
      repository.createContentItem({ ...validBrief, allowedFacts: [] }),
    ).rejects.toThrow();
  });

  it("keeps a selected final copy immutable and only enters review after validation", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(validCampaign);

    const finalCopy = await repository.submitFinalCopyForReview(item.id, {
      headline: "Tu WhatsApp también puede agendar",
      body: "El bot puede atender, calificar y agendar citas.",
      cta: "Escribe AGENDA por WhatsApp",
    });
    const record = await repository.getContentRecord(item.id);

    expect(finalCopy.version).toBe(1);
    expect(record?.content.state).toBe("REVIEW");
    expect(record?.finalCopy).toMatchObject({ id: finalCopy.id, version: 1 });
    await expect(
      repository.submitFinalCopyForReview(item.id, {
        headline: "Otro copy",
        body: "No debe sobrescribir el seleccionado.",
        cta: "Escribe AGENDA",
      }),
    ).rejects.toThrow();
  });
});

describe("content storage migration", () => {
  it("tenantizes domain tables with organization membership RLS and private organization storage paths", async () => {
    const migrationPath = fileURLToPath(
      new URL("../../supabase/migrations/0009_tenantize_content_and_jobs.sql", import.meta.url),
    );
    const sql = await readFile(migrationPath, "utf8");

    for (const table of [
      "assets",
      "content_items",
      "copy_drafts",
      "final_copy_versions",
      "publication_targets",
      "automation_runs",
      "audit_events",
    ]) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} add column if not exists organization_id`, "i"));
      expect(sql).toMatch(new RegExp(`create index if not exists ${table}_organization`, "i"));
    }
    expect(sql).toMatch(/organization_id = organization\.id[\s\S]*owner_id = organization\.legacy_owner_id/i);
    expect(sql).toMatch(/create policy[\s\S]*public\.is_organization_member/i);
    expect(sql).toMatch(/drop policy if exists "Users upload their assets" on public\.assets/i);
    expect(sql).toMatch(/drop policy if exists "Users create uploaded content" on public\.content_items/i);
    expect(sql).toMatch(/storage\.foldername\(name\)\)\[1\][\s\S]*organization_id/i);
    expect(sql).toMatch(/asset\.id\s*=\s*\(storage\.foldername\(name\)\)\[2\]/i);
    expect(sql).not.toMatch(/security definer\s+set search_path = public/i);
    const securityDefinerBodies = [
      ...sql.matchAll(/security definer\s+set search_path = pg_catalog\s+as \$\$([\s\S]*?)\$\$/gi),
    ];
    expect(securityDefinerBodies).not.toHaveLength(0);
    for (const [, body] of securityDefinerBodies) {
      expect(body).not.toMatch(/\bfrom\s+(?!public\.|auth\.|storage\.)[a-z_]/i);
    }
  });
  it("stores campaign attribution and append-only selected final copy before review", async () => {
    const migrationPath = fileURLToPath(
      new URL("../../supabase/migrations/0007_campaign_and_final_copy.sql", import.meta.url),
    );
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/add column if not exists campaign_name/i);
    expect(sql).toMatch(/add column if not exists campaign_code/i);
    expect(sql).toMatch(/create table public\.final_copy_versions/i);
    expect(sql).toMatch(/selected_final_copy_id uuid/i);
    expect(sql).toMatch(/create function public\.submit_final_copy_for_review/i);
    expect(sql).toMatch(/final_copy_submission_invalid_state/i);
    expect(sql).toMatch(/create function public\.reject_final_copy_mutation/i);
    expect(sql).toMatch(/before update or delete on public\.final_copy_versions/i);
    expect(sql).toMatch(/grant execute on function public\.submit_final_copy_for_review[\s\S]*to service_role/i);
  });

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
    expect(sql).toMatch(/create trigger assert_audit_event_reference_owner/i);
    expect(sql).toMatch(/create function public\.reject_audit_event_mutation/i);
    expect(sql).toMatch(/create trigger prevent_audit_event_mutation/i);
    expect(sql).toMatch(/create function public\.create_content_item_with_targets/i);
    expect(sql).toMatch(/insert into public\.publication_targets[\s\S]*'FACEBOOK'[\s\S]*'INSTAGRAM'/i);
    expect(sql).toMatch(/insert into public\.audit_events[\s\S]*'CONTENT_CREATED'/i);
    expect(sql).toMatch(
      /insert into public\.profiles \(id, role\)[\s\S]*select id, 'reviewer'[\s\S]*on conflict \(id\) do nothing/i,
    );
    expect(sql).toMatch(/create function public\.is_owner_profile/i);
    expect(sql).toMatch(/role = 'owner'/i);
    expect(sql).toMatch(
      /revoke all on function public\.create_content_item_with_targets/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.create_content_item_with_targets[\s\S]*to service_role/i,
    );
    expect(sql).toMatch(
      /publication_target\.content_item_id\s*=\s*new\.content_item_id/i,
    );

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
      /create policy[^;]*on public\.audit_events\s+for (?:insert|update|delete)/i,
    );

    const auditEventsTable = sql.match(
      /create table public\.audit_events\s*\(([\s\S]*?)\n\);/i,
    )?.[1];
    expect(auditEventsTable).toBeDefined();
    expect(auditEventsTable).not.toMatch(/on delete cascade/i);
    expect(auditEventsTable).toMatch(/on delete restrict/i);
  });

  it("defines an owner-scoped, review-gated target approval RPC", async () => {
    const migrationPath = fileURLToPath(
      new URL("../../supabase/migrations/0005_approve_publication_target.sql", import.meta.url),
    );
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/create function public\.approve_publication_target/i);
    expect(sql).toMatch(/p_owner_id uuid/i);
    expect(sql).toMatch(/owner_id\s*=\s*p_owner_id/i);
    expect(sql).toMatch(/item_state\s*<>\s*'REVIEW'/i);
    expect(sql).toMatch(/target\.status\s+not\s+in\s*\('PENDING_REVIEW',\s*'APPROVED'\)/i);
    expect(sql).toMatch(/set status\s*=\s*'APPROVED'/i);
    expect(sql).toMatch(/event_type[\s\S]*'TARGET_APPROVED'/i);
    expect(sql).toMatch(/set state\s*=\s*'APPROVED'/i);
    expect(sql).toMatch(/revoke all on function public\.approve_publication_target/i);
    expect(sql).toMatch(/grant execute on function public\.approve_publication_target[\s\S]*to service_role/i);
  });

  it("defines an atomic content-plus-asset RPC with private storage metadata", async () => {
    const migrationPath = fileURLToPath(
      new URL("../../supabase/migrations/0006_create_content_item_with_asset.sql", import.meta.url),
    );
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/create function public\.create_content_item_with_asset/i);
    expect(sql).toMatch(/insert into public\.assets/i);
    expect(sql).toMatch(/bucket_id[\s\S]*'content-assets'/i);
    expect(sql).toMatch(/asset_id[\s\S]*p_asset_id/i);
    expect(sql).toMatch(/state[\s\S]*'UPLOADED'/i);
    expect(sql).toMatch(/insert into public\.publication_targets[\s\S]*'FACEBOOK'[\s\S]*'INSTAGRAM'/i);
    expect(sql).toMatch(/revoke all on function public\.create_content_item_with_asset/i);
    expect(sql).toMatch(/grant execute on function public\.create_content_item_with_asset[\s\S]*to service_role/i);
  });
});

describe("n8n configuration contract", () => {
  it("uses one shared-secret environment variable across portal documentation", async () => {
    const envPath = fileURLToPath(new URL("../../.env.example", import.meta.url));
    const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
    const [environmentExample, readme] = await Promise.all([
      readFile(envPath, "utf8"),
      readFile(readmePath, "utf8"),
    ]);

    expect(environmentExample).toContain("SNAPGAD_N8N_SHARED_SECRET=");
    expect(environmentExample).not.toMatch(/^N8N_SHARED_SECRET=/m);
    expect(readme).toContain("SNAPGAD_N8N_SHARED_SECRET");
  });
});
