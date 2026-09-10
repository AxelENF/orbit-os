import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readDoc(filename: string) {
  return readFile(
    fileURLToPath(new URL(`../../docs/n8n/${filename}`, import.meta.url)),
    "utf8",
  );
}

describe("n8n worker documentation", () => {
  it("documents the portal-owned copy claim/complete contract without direct storage credentials", async () => {
    const copy = await readDoc("content-copy-workflow.md");

    expect(copy).toContain("SNAPGAD_PORTAL_BASE_URL");
    expect(copy).toContain("/api/integrations/n8n/copy/claim");
    expect(copy).toContain("/api/integrations/n8n/copy/complete");
    expect(copy).toMatch(/inactivo|inactive/i);
    expect(copy).not.toMatch(/SUPABASE|service.role|automation_runs/i);
  });

  it("states that publication is unavailable pending tenant Meta integration", async () => {
    const publish = await readDoc("content-publish-workflow.md");

    expect(publish).toMatch(/no disponible|unavailable/i);
    expect(publish).toMatch(/integraci[oó]n.*tenant.*Meta|Meta.*tenant/i);
    expect(publish).not.toMatch(/META_PAGE_ACCESS_TOKEN|media_publish|graph\.facebook/i);
  });
});
