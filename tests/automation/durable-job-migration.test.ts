import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("durable automation job lifecycle migration", () => {
  it("is additive, retry-aware, and keeps the provider as a server-side key", async () => {
    const path = fileURLToPath(
      new URL("../../supabase/migrations/0013_automation_job_lifecycle.sql", import.meta.url),
    );
    const sql = await readFile(path, "utf8");

    expect(sql).toMatch(/has NOT been applied to a live Supabase project/i);
    expect(sql).toMatch(/alter type public\.automation_job_status add value if not exists 'RETRY_WAIT'/i);
    expect(sql).toMatch(/add value if not exists 'CANCELLED'/i);
    expect(sql).toMatch(/add value if not exists 'DEAD_LETTER'/i);
    expect(sql).toMatch(/add column if not exists provider text/i);
    expect(sql).toMatch(/add column if not exists run_at timestamptz/i);
    expect(sql).toMatch(/add column if not exists next_attempt_at timestamptz/i);
    expect(sql).toMatch(/add column if not exists max_attempts integer/i);
    expect(sql).toMatch(/set max_attempts = greatest\(max_attempts, attempt_count\)/i);
    expect(sql).toMatch(/automation_jobs_next_attempt_after_run_check/i);
    expect(sql).toMatch(/organization_id, status, next_attempt_at, created_at/i);
    expect(sql).toMatch(/revoke all on function public\.claim_next_copy_automation_job/i);
    expect(sql).toMatch(/grant execute on function public\.recover_expired_copy_automation_jobs[\s\S]*to service_role/i);
  });
});
