import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0024_publish_hardening.sql", import.meta.url));
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

describe("0024 publish hardening: enqueue idempotency lookup", () => {
  it("does not lock an existing automation job during the read-only idempotency check", async () => {
    const sql = await readMigration();
    const fn = sql.match(
      /create or replace function public\.enqueue_publish_automation_job[\s\S]*?\$\$;/i,
    )?.[0];

    expect(fn).toBeTruthy();
    expect(fn).toMatch(
      /select \* into existing_job[\s\S]*?where organization_id = p_organization_id[\s\S]*?and kind = 'PUBLISH'[\s\S]*?and idempotency_key = derived_key\s*;\s*if found/i,
    );
    expect(fn).not.toMatch(/idempotency_key = derived_key\s+for update/i);
    expect(fn).toMatch(/'PUBLISH', 'QUEUED', derived_key, 'meta'/i);
  });
});
