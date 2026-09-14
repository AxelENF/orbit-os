import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0022_publish_manual_race_guard.sql", import.meta.url));
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

describe("0022 publish/manual race guard", () => {
  it("no pisa un target publicado y bloquea entregas manuales mientras el job está en curso", async () => {
    const sql = await readMigration();
    const completion = sql.match(
      /create or replace function public\.complete_publish_automation_job[\s\S]*?\$\$;/i,
    )?.[0];

    expect(completion).toBeTruthy();
    expect(completion).toMatch(
      /select \* into item[\s\S]*?from public\.content_items[\s\S]*?for update/i,
    );
    expect(completion).toMatch(
      /select \* into target[\s\S]*?from public\.publication_targets[\s\S]*?for update/i,
    );
    expect(completion!.search(/select \* into item/)).toBeLessThan(
      completion!.search(/select \* into target/),
    );
    expect(completion).toMatch(
      /if target\.status = 'PUBLISHED' then[\s\S]*?status = 'CANCELLED'[\s\S]*?'PUBLISH_JOB_TARGET_ALREADY_PUBLISHED'/i,
    );
    expect(completion).toMatch(/if target\.status <> 'APPROVED' then/i);
    expect(sql).toMatch(/create (?:or replace )?function public\.guard_manual_publication_delivery_race\(/i);
    expect(sql).toMatch(/MANUAL_DELIVERY_PUBLISH_IN_PROGRESS/i);
    expect(sql).toMatch(/create trigger .*manual_publication_delivery_race/i);
  });
});
