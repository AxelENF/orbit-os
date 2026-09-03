import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("publish result callback migration", () => {
  it("defines a service-only atomic and target-specific callback RPC", async () => {
    const path = fileURLToPath(
      new URL(
        "../../supabase/migrations/0003_ingest_publish_result_callback.sql",
        import.meta.url,
      ),
    );
    const sql = await readFile(path, "utf8");

    expect(sql).toMatch(/create function public\.ingest_publish_result_callback/i);
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(/status\s*<>\s*'APPROVED'/i);
    expect(sql).toMatch(/publication_target_id/i);
    expect(sql).toMatch(/remote_post_id/i);
    expect(sql).toMatch(/remote_url/i);
    expect(sql).toMatch(/published_at/i);
    expect(sql).toMatch(/last_error/i);
    expect(sql).toMatch(/on conflict \(kind, idempotency_key\) do nothing/i);
    expect(sql).toMatch(
      /revoke all on function public\.ingest_publish_result_callback[\s\S]*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.ingest_publish_result_callback[\s\S]*to service_role/i,
    );
  });
});
