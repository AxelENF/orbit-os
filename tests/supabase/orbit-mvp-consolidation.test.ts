import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
const canonicalMigration = fileURLToPath(
  new URL("../../supabase/migrations/20261005124203_orbit_os_mvp_consolidation.sql", import.meta.url),
);

describe("Orbit OS MVP canonical migration", () => {
  it("keeps the applied baseline and exactly one canonical remote migration", async () => {
    const activeMigrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();

    expect(activeMigrationFiles.map((name) => name.split("_", 1)[0])).toEqual([
      "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009",
      "0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017", "20261005124203",
    ]);
    expect(activeMigrationFiles.at(-1)).toBe("20261005124203_orbit_os_mvp_consolidation.sql");
  });

  it("contains the final MVP contracts and closes the publicly callable trigger helpers", async () => {
    const sql = await readFile(canonicalMigration, "utf8");

    expect(sql).toContain("Orbit OS MVP consolidation");
    expect(sql).toContain("organization_meta_connections");
    expect(sql).toContain("organization_ai_provider_credentials");
    expect(sql).toContain("create_content_item_with_assets_in_organization");
    expect(sql).toContain("configure_organization_openrouter_credential");
    expect(sql).toContain("revoke all on function public.rls_auto_enable() from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated");
  });
});
