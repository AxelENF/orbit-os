import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("manual publication delivery migration", () => {
  it("adds an organization-scoped, idempotent, service-only evidence RPC", async () => {
    const path = fileURLToPath(new URL(
      "../../supabase/migrations/0016_manual_publication_delivery.sql",
      import.meta.url,
    ));
    const sql = await readFile(path, "utf8");

    expect(sql).toMatch(/create table public\.manual_publication_deliveries/i);
    expect(sql).toMatch(/unique \(organization_id, idempotency_key\)/i);
    expect(sql).toMatch(/publication_target_id uuid not null unique/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/create function public\.record_manual_publication_delivery/i);
    expect(sql).toMatch(/assert_organization_actor/i);
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(/MANUAL_DELIVERY_CONTENT_NOT_APPROVED/i);
    expect(sql).toMatch(/MANUAL_PUBLICATION_RECORDED/i);
    expect(sql).toMatch(/set state\s*=\s*'PUBLISHED'/i);
    expect(sql).toMatch(/revoke all on function public\.record_manual_publication_delivery[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.record_manual_publication_delivery[\s\S]*to service_role/i);
  });
});
