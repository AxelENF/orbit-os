/** @vitest-environment node */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(
    new URL("../../supabase/migrations/0030_actor_metadata_for_multi_asset_rpc.sql", import.meta.url),
  );
  return readFile(path, "utf8");
}

describe("multi-asset actor metadata migration", () => {
  it("drops the old 18-parameter create_content_item_with_assets_in_organization instead of coexisting as an overload", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /drop function if exists public\.create_content_item_with_assets_in_organization\(\s*uuid, uuid, jsonb, text, text, text, text, text, text, text, text, jsonb,\s*text, text, text, text, text, text\s*\)/i,
    );
    expect(sql).not.toMatch(/create or replace function public\.create_content_item_with_assets_in_organization/i);
    expect(sql).toMatch(/create function public\.create_content_item_with_assets_in_organization/i);
  });

  it("gives create_content_item_with_assets_in_organization a p_actor_metadata parameter merged into its audit event", async () => {
    const sql = await readMigration();
    const fn = sql.split("create function public.create_content_item_with_assets_in_organization")[1] ?? "";
    expect(fn).toMatch(/p_actor_metadata jsonb default '\{\}'::jsonb/i);
    expect(fn).toMatch(
      /jsonb_build_object\('assetId', asset_id, 'assetCount', asset_count, 'campaignCode', p_campaign_code\)\s*\|\|\s*p_actor_metadata/i,
    );
  });

  it("re-grants execute on the recreated function to service_role only, never to authenticated/public/anon", async () => {
    // Misma postura de seguridad que 0029_actor_metadata_for_api_keys.sql:
    // SupabaseRepository llama esta RPC con el cliente de service role
    // después de validar la sesión en TypeScript, nunca directo desde el
    // navegador — conceder EXECUTE a authenticated aquí saltearía esa
    // validación.
    const sql = await readMigration();
    expect(sql).toMatch(
      /revoke all on function public\.create_content_item_with_assets_in_organization\([^)]*\) from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.create_content_item_with_assets_in_organization\([^)]*\) to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function public\.create_content_item_with_assets_in_organization\([^)]*\) to authenticated/i,
    );
  });

  it("keeps the asset validation and atomic insert logic from 0023 unchanged", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/CONTENT_ASSETS_INVALID/);
    expect(sql).toMatch(/CONTENT_ASSETS_COUNT_INVALID/);
    expect(sql).toMatch(/CONTENT_ASSET_POSITION_INVALID/);
    expect(sql).toMatch(/insert into public\.content_item_assets/);
  });
});
