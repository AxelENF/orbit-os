/** @vitest-environment node */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(
    new URL("../../supabase/migrations/0028_organization_api_keys.sql", import.meta.url),
  );
  return readFile(path, "utf8");
}

describe("organization_api_keys migration", () => {
  it("creates the table with RLS enabled and no general-purpose write policy", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create table if not exists public\.organization_api_keys/i);
    expect(sql).toMatch(/key_hash text not null unique/i);
    expect(sql).toMatch(/alter table public\.organization_api_keys enable row level security/i);
    // Solo debe existir una policy (SELECT) — la escritura pasa por las RPCs.
    const policyMatches = sql.match(/create policy .* on public\.organization_api_keys[\s\S]*?;/gi) ?? [];
    expect(policyMatches).toHaveLength(1);
    expect(policyMatches[0]).toMatch(/for select/i);
  });

  it("protects key_hash from the authenticated role at the column-privilege level, not just RLS", async () => {
    const sql = await readMigration();
    // Corrección ronda 2 del spec: un REVOKE de columna sola no alcanza si
    // el rol ya tiene SELECT de tabla completa — debe revocarse la tabla y
    // conceder solo las columnas seguras.
    expect(sql).toMatch(/revoke select on public\.organization_api_keys from authenticated/i);
    expect(sql).toMatch(
      /grant select \(id, organization_id, label, key_prefix, created_by, created_at, last_used_at, revoked_at\)\s*\n?\s*on public\.organization_api_keys to authenticated/i,
    );
    expect(sql).not.toMatch(/revoke select \(key_hash\)/i);
  });

  it("guards create_organization_api_key against the NULL-bypass bug (non-member must be rejected, not silently allowed)", async () => {
    const sql = await readMigration();
    // has_organization_role devuelve NULL, no false, para quien no tiene
    // ninguna membresía — `if not <NULL>` no ejecuta el bloque en plpgsql.
    // Debe envolverse en coalesce(..., false).
    const createFn = sql.split("create function public.create_organization_api_key")[1] ?? "";
    expect(createFn).toMatch(/if not coalesce\(public\.has_organization_role\([^)]*\), false\) then/i);
    expect(createFn).toMatch(/raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER'/i);
  });

  it("guards revoke_organization_api_key against the same NULL-bypass bug", async () => {
    const sql = await readMigration();
    const revokeFn = sql.split("create function public.revoke_organization_api_key")[1] ?? "";
    expect(revokeFn).toMatch(/or not coalesce\(public\.has_organization_role\([^)]*\), false\) then/i);
  });

  it("never lets the caller choose organization_id or created_by directly", async () => {
    const sql = await readMigration();
    // El secreto y el hash se generan dentro de la función; created_by viene
    // de auth.uid(), nunca de un parámetro.
    expect(sql).toMatch(/values \(p_organization_id, p_label, v_hash, v_prefix, auth\.uid\(\)\)/i);
  });

  it("restricts both RPCs to authenticated only, never public/anon", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/revoke all on function public\.create_organization_api_key\(uuid, text\) from public, anon/i);
    expect(sql).toMatch(/revoke all on function public\.revoke_organization_api_key\(uuid\) from public, anon/i);
    expect(sql).toMatch(/grant execute on function public\.create_organization_api_key\(uuid, text\) to authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.revoke_organization_api_key\(uuid\) to authenticated/i);
  });
});
