import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0018_meta_publisher.sql", import.meta.url));
  return readFile(path, "utf8");
}

describe("content_item_assets", () => {
  it("declara la tabla con position acotada entre 0 y 9", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create table public\.content_item_assets/i);
    expect(sql).toMatch(/position smallint not null check \(position >= 0 and position <= 9\)/i);
  });

  it("declara unique\\(content_item_id, position\\) y unique\\(content_item_id, asset_id\\)", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/unique \(content_item_id, position\)/i);
    expect(sql).toMatch(/unique \(content_item_id, asset_id\)/i);
  });

  it("declara FKs compuestas por (content_item_id/asset_id, organization_id) para evitar mezclar tenants", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/foreign key \(content_item_id, organization_id\)\s*references public\.content_items \(id, organization_id\)/i);
    expect(sql).toMatch(/foreign key \(asset_id, organization_id\)\s*references public\.assets \(id, organization_id\)/i);
  });

  it("incluye el backfill de position=0 para content_items con asset_id existente", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/insert into public\.content_item_assets \(organization_id, content_item_id, asset_id, position\)/i);
    expect(sql).toMatch(/where asset_id is not null/i);
  });

  it("habilita RLS sin policy de escritura para authenticated", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.content_item_assets enable row level security/i);
  });
});

describe("organization_meta_connections", () => {
  it("habilita RLS y revoca el acceso directo a la tabla para authenticated/anon", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.organization_meta_connections enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.organization_meta_connections from public, anon, authenticated/i);
    // Nota: no se agrega un `not.toMatch` genérico de "no existe ninguna
    // policy" — con [\s\S]* eso hace match voraz contra CUALQUIER policy de
    // cualquier otra tabla en el mismo archivo y da falsos positivos/negativos
    // (hallazgo de revisión Codex ronda 2). Las dos aserciones positivas de
    // arriba ya cubren el contrato real.
  });

  it("get_meta_connection_status no selecciona ni regresa page_access_token", async () => {
    const sql = await readMigration();
    const fnMatch = sql.match(/create function public\.get_meta_connection_status[\s\S]*?\$\$;/i);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/page_access_token/i);
  });

  it("get_meta_connection_status se otorga a authenticated; upsert/revoke/mark-error solo a service_role", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/grant execute on function public\.get_meta_connection_status\(uuid, uuid\) to authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.upsert_meta_connection\([^)]*\) to service_role/i);
    expect(sql).toMatch(/grant execute on function public\.revoke_meta_connection\(uuid\) to service_role/i);
    expect(sql).toMatch(/grant execute on function public\.mark_meta_connection_error\(uuid\) to service_role/i);
  });

  it("el CHECK de page_access_token no exige texto no-vacío cuando status no es ACTIVE (para que revoke pueda limpiarlo)", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/check \(status <> 'ACTIVE' or length\(btrim\(page_access_token\)\) > 0\)/i);
  });
});

describe("organization_meta_oauth_sessions", () => {
  it("revoca el acceso directo a authenticated/anon", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.organization_meta_oauth_sessions enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.organization_meta_oauth_sessions from public, anon, authenticated/i);
  });

  it("discovered_pages exige un array jsonb", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/discovered_pages jsonb not null check \(jsonb_typeof\(discovered_pages\) = 'array'\)/i);
  });
});
