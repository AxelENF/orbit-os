import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(rootDirectory, "supabase", "migrations");
const expectedVersions = [
  "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009",
  "0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017", "20261005124203",
];
const expectedFilename = "20261005124203_orbit_os_mvp_consolidation.sql";
const requiredMarkers = [
  "Orbit OS MVP consolidation",
  "organization_meta_connections",
  "organization_ai_provider_credentials",
  "create_content_item_with_assets_in_organization",
  "configure_organization_openrouter_credential",
  "revoke all on function public.rls_auto_enable() from public, anon, authenticated",
];

const activeMigrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();
const versions = activeMigrationFiles.map((name) => name.split("_", 1)[0]);

if (JSON.stringify(versions) !== JSON.stringify(expectedVersions)) {
  throw new Error(`Unexpected active migration versions: ${versions.join(", ")}`);
}
if (activeMigrationFiles.at(-1) !== expectedFilename) {
  throw new Error(`Expected ${expectedFilename} to be the final active migration.`);
}

const canonicalSql = await readFile(path.join(migrationsDirectory, expectedFilename), "utf8");
for (const marker of requiredMarkers) {
  if (!canonicalSql.includes(marker)) throw new Error(`Canonical migration is missing marker: ${marker}`);
}

console.log(`Orbit migration inventory verified: ${versions.join(", ")}.`);
