import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0026_intake_interactive_ai_usage.sql", import.meta.url));
  return readFile(path, "utf8");
}

describe("record_interactive_ai_usage", () => {
  it("inserta en ai_usage_events con job_id null", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create function public\.record_interactive_ai_usage/i);
    expect(sql).toMatch(/insert into public\.ai_usage_events/i);
    expect(sql).toMatch(/p_organization_id, null, p_provider/i);
  });

  it("está revocada de public/anon/authenticated y otorgada solo a service_role", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/revoke all on function public\.record_interactive_ai_usage\([^)]*\) from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.record_interactive_ai_usage\([^)]*\) to service_role/i);
  });
});
