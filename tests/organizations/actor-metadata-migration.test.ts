/** @vitest-environment node */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(
    new URL("../../supabase/migrations/0020_actor_metadata_for_api_keys.sql", import.meta.url),
  );
  return readFile(path, "utf8");
}

describe("actor metadata migration", () => {
  it("drops the old 24-parameter create_content_item_with_asset_in_organization instead of coexisting as an overload", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /drop function if exists public\.create_content_item_with_asset_in_organization\(\s*uuid, uuid, uuid, text,\s*text, text, integer, integer,\s*text, text, text, text,\s*text, text, text, text,\s*text, jsonb, text,\s*text, text, text,\s*text, text\s*\)/i,
    );
    expect(sql).not.toMatch(/create or replace function public\.create_content_item_with_asset_in_organization/i);
    expect(sql).toMatch(/create function public\.create_content_item_with_asset_in_organization/i);
  });

  it("gives create_content_item_with_asset_in_organization a p_actor_metadata parameter merged into its audit event", async () => {
    const sql = await readMigration();
    const fn = sql.split("create function public.create_content_item_with_asset_in_organization")[1] ?? "";
    expect(fn).toMatch(/p_actor_metadata jsonb default '\{\}'::jsonb/i);
    expect(fn).toMatch(
      /jsonb_build_object\('assetId', p_asset_id, 'campaignCode', p_campaign_code\) \|\| p_actor_metadata/i,
    );
  });

  it("drops the old 4-parameter enqueue_copy_automation_job instead of coexisting as an overload", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /drop function if exists public\.enqueue_copy_automation_job\(\s*uuid, uuid, uuid, uuid\s*\)/i,
    );
    expect(sql).not.toMatch(/create or replace function public\.enqueue_copy_automation_job/i);
  });

  it("gives enqueue_copy_automation_job a p_actor_metadata parameter merged into its audit event", async () => {
    const sql = await readMigration();
    const fn = sql.split("create function public.enqueue_copy_automation_job")[1] ?? "";
    expect(fn).toMatch(/p_actor_metadata jsonb default '\{\}'::jsonb/i);
    expect(fn).toMatch(
      /jsonb_build_object\('jobId', created_job\.id, 'idempotencyKey', p_idempotency_key\) \|\| p_actor_metadata/i,
    );
  });

  it("re-grants execute on both recreated functions to service_role only, never to authenticated/public/anon", async () => {
    // Corrección ronda 1 de revisión del plan (hallazgo real de seguridad):
    // ambas funciones ya están revocadas de public/anon/authenticated y
    // concedidas solo a service_role hoy (0009:321-329, 0010:151-156) —
    // createContentRepository las llama con el cliente de service role
    // después de validar la sesión en TypeScript (repository-factory.ts:193),
    // nunca directo desde una sesión de navegador. Conceder EXECUTE a
    // authenticated aquí abriría estas RPCs privilegiadas a cualquier
    // usuario autenticado, saltándose esa validación.
    const sql = await readMigration();
    expect(sql).toMatch(
      /revoke all on function public\.create_content_item_with_asset_in_organization\([^)]*\) from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.create_content_item_with_asset_in_organization\([^)]*\) to service_role/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.enqueue_copy_automation_job\([^)]*\) from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.enqueue_copy_automation_job\([^)]*\) to service_role/i,
    );
    expect(sql).not.toMatch(/grant execute on function public\.create_content_item_with_asset_in_organization\([^)]*\) to authenticated/i);
    expect(sql).not.toMatch(/grant execute on function public\.enqueue_copy_automation_job\([^)]*\) to authenticated/i);
  });
});
