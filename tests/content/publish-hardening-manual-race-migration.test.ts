import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0024_publish_hardening.sql", import.meta.url));
  return readFile(path, "utf8");
}

describe("0024 publish hardening: legacy n8n publication race", () => {
  it("blocks manual delivery for an unmatched PUBLISH_REQUEST, but not after its callback", async () => {
    const sql = await readMigration();
    const fn = sql.match(
      /create or replace function public\.guard_manual_publication_delivery_race[\s\S]*?\$\$;/i,
    )?.[0];

    expect(fn).toBeTruthy();
    expect(fn).toMatch(
      /from public\.automation_runs as publish_request[\s\S]*?where publish_request\.organization_id = old\.organization_id[\s\S]*?and publish_request\.publication_target_id = old\.id[\s\S]*?and publish_request\.kind = 'PUBLISH_REQUEST'/i,
    );
    expect(fn).toMatch(
      /and not exists \([\s\S]*?from public\.automation_runs as publish_callback[\s\S]*?where publish_callback\.organization_id = publish_request\.organization_id[\s\S]*?and publish_callback\.publication_target_id = publish_request\.publication_target_id[\s\S]*?and publish_callback\.kind = 'PUBLISH_CALLBACK'[\s\S]*?and publish_callback\.idempotency_key = publish_request\.idempotency_key/i,
    );
    expect(fn).toMatch(/MANUAL_DELIVERY_PUBLISH_IN_PROGRESS/i);
  });
});
