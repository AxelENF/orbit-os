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
    expect(sql).toMatch(/kind\s*=\s*'PUBLISH_REQUEST'/i);
    expect(sql).toMatch(/PUBLISH_REQUEST_NOT_FOUND/i);
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

describe("copy request migration", () => {
  it("records the outbound request before moving content to GENERATING", async () => {
    const path = fileURLToPath(
      new URL(
        "../../supabase/migrations/0004_prepare_copy_request.sql",
        import.meta.url,
      ),
    );
    const sql = await readFile(path, "utf8");

    expect(sql).toMatch(/create function public\.prepare_copy_request/i);
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(/kind[\s\S]*'COPY_REQUEST'/i);
    expect(sql).toMatch(/idempotency_key/i);
    expect(sql).toMatch(/state\s*=\s*'GENERATING'/i);
    expect(sql).toMatch(/COPY_REQUEST_IDEMPOTENCY_KEY_REUSED/i);
    expect(sql).toMatch(/grant execute on function public\.prepare_copy_request[\s\S]*to service_role/i);
  });
});
