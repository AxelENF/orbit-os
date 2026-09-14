import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0023_content_item_assets_atomic.sql", import.meta.url));
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

describe("0023 atomic content item assets", () => {
  it("recibe el arreglo JSONB completo y crea assets, item y vínculos en una sola RPC", async () => {
    const sql = await readMigration();
    const fn = sql.match(
      /create function public\.create_content_item_with_assets_in_organization[\s\S]*?\$\$;/i,
    )?.[0];

    expect(fn).toBeTruthy();
    expect(fn).toMatch(/p_assets jsonb/i);
    expect(fn).toMatch(/jsonb_array_length\(p_assets\)/i);
    expect(fn).toMatch(/jsonb_array_elements\(p_assets\)/i);
    expect(fn).toMatch(/insert into public\.assets/i);
    expect(fn).toMatch(/insert into public\.content_items/i);
    expect(fn).toMatch(/insert into public\.content_item_assets/i);
    expect(fn).toMatch(/assetId/i);
    expect(fn).toMatch(/position/i);
    expect(sql).toMatch(/grant execute on function public\.create_content_item_with_assets_in_organization[\s\S]*to service_role/i);
  });
});
