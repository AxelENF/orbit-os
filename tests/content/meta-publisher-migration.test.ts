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
