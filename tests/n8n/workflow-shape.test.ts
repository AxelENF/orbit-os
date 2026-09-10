import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type N8nNode = {
  name: string;
  type: string;
  parameters?: {
    path?: string;
    url?: string;
    sendHeaders?: boolean;
    headerParameters?: { parameters?: Array<{ name?: string; value?: string }> };
  };
};

async function loadWorkflow() {
  const path = fileURLToPath(
    new URL("../../n8n/SnapGad-Content-Engine-V1.json", import.meta.url),
  );
  const raw = await readFile(path, "utf8");
  return {
    raw,
    workflow: JSON.parse(raw) as { active?: boolean; nodes?: N8nNode[] },
  };
}

describe("SnapGad Content Engine n8n export", () => {
  it("is an inactive copy-only worker with no publish webhook", async () => {
    const { workflow } = await loadWorkflow();

    expect(workflow.active).toBe(false);
    const webhooks = (workflow.nodes ?? [])
      .filter((node) => node.type === "n8n-nodes-base.webhook")
      .map((node) => node.parameters?.path);
    expect(webhooks).toEqual(["snapgad/content/copy"]);
    expect((workflow.nodes ?? []).map((node) => node.name).join(" ")).not.toMatch(/publish|facebook|instagram|meta/i);
  });

  it("uses signed portal claim and complete endpoints instead of direct storage access", async () => {
    const { workflow } = await loadWorkflow();
    const byName = new Map((workflow.nodes ?? []).map((node) => [node.name, node]));

    for (const name of ["Copy — Reclamar Trabajo del Portal", "Copy — Completar Trabajo en Portal"]) {
      const node = byName.get(name);
      expect(node?.type).toBe("n8n-nodes-base.httpRequest");
      expect(node?.parameters?.url).toContain("SNAPGAD_PORTAL_BASE_URL");
      expect(node?.parameters?.sendHeaders).toBe(true);
      expect(node?.parameters?.headerParameters?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "X-SnapGad-Timestamp" }),
          expect.objectContaining({ name: "X-SnapGad-Signature" }),
        ]),
      );
    }
    expect(byName.get("Copy — Reclamar Trabajo del Portal")?.parameters?.url).toContain("/api/integrations/n8n/copy/claim");
    expect(byName.get("Copy — Completar Trabajo en Portal")?.parameters?.url).toContain("/api/integrations/n8n/copy/complete");
  });

  it("accepts only the durable job reference from the portal webhook", async () => {
    const { raw } = await loadWorkflow();
    expect(raw).toMatch(/jobId e idempotencyKey son requeridos/i);
    expect(raw).not.toMatch(/contentItemId e idempotencyKey son requeridos/i);
    expect(raw).toMatch(/jobId: String\(body\.jobId\)/i);
    expect(raw).not.toMatch(/assetUrl: String\(body\.assetUrl\)|brief: body\.brief/i);
  });

  it("gives the vision provider the portal-derived temporary asset URL", async () => {
    const { raw } = await loadWorkflow();
    expect(raw).toMatch(/type:\s*'image_url'/i);
    expect(raw).toMatch(/url:\s*job\.assetUrl/i);
  });

  it("contains neither Supabase service access nor Meta Graph publication capability", async () => {
    const { raw } = await loadWorkflow();

    expect(raw).not.toMatch(/SUPABASE|service_role|automation_runs/i);
    expect(raw).not.toMatch(/graph\.facebook|meta[_ -]?(page|ig|access)|publish-result/i);
    expect(raw).not.toMatch(/SNAPGAD_PORTAL_URL/);
    expect(raw).toContain("SNAPGAD_PORTAL_BASE_URL");
    expect(raw).toContain("SNAPGAD_N8N_SHARED_SECRET");
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
  });
});
