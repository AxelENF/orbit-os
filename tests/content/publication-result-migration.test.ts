import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("publication result snapshots migration", () => {
  it("defines append-only, tenant-scoped manual results behind a service-only RPC", async () => {
    const path = fileURLToPath(new URL(
      "../../supabase/migrations/0017_publication_result_snapshots.sql",
      import.meta.url,
    ));
    const sql = await readFile(path, "utf8");

    expect(sql).toMatch(/create table public\.publication_result_snapshots/i);
    expect(sql).toMatch(/unique \(organization_id, idempotency_key\)/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/create function public\.record_publication_result/i);
    expect(sql).toMatch(/assert_organization_actor/i);
    expect(sql).toMatch(/target\.status\s*<>\s*'PUBLISHED'/i);
    expect(sql).toMatch(/PUBLICATION_RESULT_RECORDED/i);
    expect(sql).toMatch(/revoke all on function public\.record_publication_result[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.record_publication_result[\s\S]*to service_role/i);
  });
});
