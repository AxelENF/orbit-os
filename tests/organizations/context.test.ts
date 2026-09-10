import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OrganizationAccessError,
  requireOrganizationContext,
} from "@/lib/organizations/context";
import {
  ORGANIZATION_ROLES,
  canApproveCampaign,
  canEditCampaign,
  canManageConnections,
} from "@/lib/organizations/permissions";

const organizationId = "bb24c876-df4e-4cbe-9b3b-97083b8c5f7e";
const ownerId = "1e62a32f-64c2-4da4-bad0-2837baad7812";

describe("organization context", () => {
  it("resolves the authenticated owner membership as organization context", async () => {
    const context = await requireOrganizationContext(organizationId, {
      getSession: async () => ({ userId: ownerId }),
      getMembership: async ({ organizationId: requestedOrganizationId, userId }) => ({
        organizationId: requestedOrganizationId,
        userId,
        role: "owner",
      }),
    });

    expect(context).toEqual({ organizationId, userId: ownerId, role: "owner" });
  });

  it("rejects an authenticated user who is not a member", async () => {
    await expect(
      requireOrganizationContext(organizationId, {
        getSession: async () => ({ userId: ownerId }),
        getMembership: async () => null,
      }),
    ).rejects.toBeInstanceOf(OrganizationAccessError);
  });

  it("rejects a request without an authenticated session", async () => {
    await expect(
      requireOrganizationContext(organizationId, {
        getSession: async () => null,
        getMembership: async () => ({ organizationId, userId: ownerId, role: "owner" }),
      }),
    ).rejects.toBeInstanceOf(OrganizationAccessError);
  });

  it("rejects a membership result for another authenticated user", async () => {
    await expect(
      requireOrganizationContext(organizationId, {
        getSession: async () => ({ userId: ownerId }),
        getMembership: async () => ({
          organizationId,
          userId: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
          role: "owner",
        }),
      }),
    ).rejects.toBeInstanceOf(OrganizationAccessError);
  });
});

describe("organization permissions", () => {
  it("uses exactly the four product roles", () => {
    expect(ORGANIZATION_ROLES).toEqual(["owner", "editor", "reviewer", "viewer"]);
  });

  it("allows editors to edit campaigns but reserves connections for owners", () => {
    expect(canEditCampaign("editor")).toBe(true);
    expect(canApproveCampaign("editor")).toBe(false);
    expect(canManageConnections("editor")).toBe(false);
    expect(canApproveCampaign("reviewer")).toBe(true);
    expect(canManageConnections("owner")).toBe(true);
  });
});

describe("tenancy foundation migration", () => {
  it("adds organization membership boundaries without moving legacy owner_id data", async () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../../supabase/migrations/0008_tenancy_foundation.sql",
        import.meta.url,
      ),
    );
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/create table if not exists public\.organizations/i);
    expect(sql).toMatch(/create table if not exists public\.organization_members/i);
    expect(sql).toMatch(/create table if not exists public\.organization_brand_profiles/i);
    expect(sql).toMatch(/create table if not exists public\.organization_integrations/i);
    expect(sql).toMatch(/credential_handle/i);
    expect(sql).not.toMatch(/access_token|refresh_token|token_ciphertext/i);
    expect(sql).toMatch(/insert into public\.organizations[\s\S]*select distinct owner_id/i);
    expect(sql).toMatch(/insert into public\.organization_members[\s\S]*'owner'/i);
    expect(sql).toMatch(/on conflict/i);
    expect(sql).not.toMatch(/drop column owner_id|rename column owner_id|add column organization_id/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/create policy/i);
  });

  it("serializes owner-removal checks and keeps legacy owner identity immutable", async () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../../supabase/migrations/0008_tenancy_foundation.sql",
        import.meta.url,
      ),
    );
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/create or replace function public\.prevent_last_organization_owner_removal/i);
    expect(sql).toMatch(/before delete or update of organization_id, user_id, role on public\.organization_members/i);
    expect(sql).toMatch(/from public\.organizations[\s\S]*for update/i);
    expect(sql).toMatch(/organization_id = protected_organization_id[\s\S]*role = 'owner'[\s\S]*user_id <> old\.user_id/i);
    expect(sql).toMatch(/ORGANIZATION_LAST_OWNER_REQUIRED/i);
    expect(sql).toMatch(/create or replace function public\.prevent_legacy_owner_id_mutation/i);
    expect(sql).toMatch(/before update of legacy_owner_id on public\.organizations/i);
    expect(sql).toMatch(/ORGANIZATION_LEGACY_OWNER_IMMUTABLE/i);
    expect(sql).toMatch(/set search_path = pg_catalog/i);
    expect(sql).toMatch(/INSERT.*does not remove an existing owner[\s\S]*UPDATE.*role[\s\S]*DELETE.*last owner/i);
  });

  it("handles DELETE with OLD-only data before any NEW reference", async () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../../supabase/migrations/0008_tenancy_foundation.sql",
        import.meta.url,
      ),
    );
    const sql = await readFile(migrationPath, "utf8");
    const triggerFunction = sql.match(
      /create or replace function public\.prevent_last_organization_owner_removal\(\)[\s\S]*?\n\$\$;/i,
    )?.[0];

    expect(triggerFunction).toBeDefined();
    const deleteBranch = triggerFunction!.indexOf("if tg_op = 'DELETE' then");
    const firstNewReference = triggerFunction!.toLowerCase().indexOf("new.");
    expect(deleteBranch).toBeGreaterThan(-1);
    expect(firstNewReference).toBeGreaterThan(-1);
    expect(deleteBranch).toBeLessThan(firstNewReference);
    expect(triggerFunction).toMatch(
      /if tg_op = 'DELETE' then\s*protected_organization_id := old\.organization_id;\s*removes_owner := old\.role = 'owner'::public\.organization_role;[\s\S]*?return old;/i,
    );
  });
});
