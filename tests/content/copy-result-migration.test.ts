import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("copy result callback migration", () => {
  it("defines a service-only atomic and idempotent callback RPC", async () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../../supabase/migrations/0002_ingest_copy_result_callback.sql",
        import.meta.url,
      ),
    );
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/create function public\.ingest_copy_result_callback/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/select owner_id, state[\s\S]*for update/i);
    expect(sql).toMatch(/kind[\s\S]*'COPY_CALLBACK'/i);
    expect(sql).toMatch(/kind\s*=\s*'COPY_REQUEST'/i);
    expect(sql).toMatch(/COPY_REQUEST_NOT_FOUND/i);
    expect(sql).toMatch(/on conflict \(kind, idempotency_key\) do nothing/i);
    expect(sql).toMatch(/jsonb_array_length\(p_drafts\)\s*<>\s*2/i);
    expect(sql).toMatch(/jsonb_typeof\(p_visual_analysis\)\s+is distinct from\s+'object'/i);
    expect(sql).toMatch(/jsonb_typeof\(p_warnings\)\s+is distinct from\s+'array'/i);
    expect(sql).toMatch(/insert into public\.copy_drafts/i);
    expect(sql).toMatch(/insert into public\.audit_events/i);
    expect(sql).toMatch(/update public\.content_items[\s\S]*state = 'DRAFT'[\s\S]*state = 'GENERATING'/i);
    expect(sql).toMatch(/jsonb_build_object\([\s\S]*'draftCount'[\s\S]*'warningCount'/i);
    expect(sql).toMatch(/revoke all on function public\.ingest_copy_result_callback[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.ingest_copy_result_callback[\s\S]*to service_role/i);
    expect(sql).not.toMatch(/p_owner_id/i);
  });
});
