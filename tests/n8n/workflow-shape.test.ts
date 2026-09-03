import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type N8nNode = {
  name: string;
  type: string;
  parameters?: {
    url?: string;
    path?: string;
    sendBody?: boolean;
    specifyBody?: string;
    jsonBody?: string;
    sendHeaders?: boolean;
    headerParameters?: { parameters?: unknown[] };
  };
};

describe("SnapGad Content Engine n8n export", () => {
  it("is inactive, has both signed webhooks, and does not embed credentials", async () => {
    const path = fileURLToPath(
      new URL("../../n8n/SnapGad-Content-Engine-V1.json", import.meta.url),
    );
    const raw = await readFile(path, "utf8");
    const workflow = JSON.parse(raw) as {
      active?: boolean;
      nodes?: N8nNode[];
    };

    expect(workflow.active).toBe(false);
    const webhooks = (workflow.nodes ?? [])
      .filter((node) => node.type === "n8n-nodes-base.webhook")
      .map((node) => node.parameters?.path);
    expect(webhooks).toEqual(
      expect.arrayContaining([
        "snapgad/content/copy",
        "snapgad/content/publish",
      ]),
    );

    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
    expect(raw).not.toMatch(/EA[A-Za-z0-9]{20,}/);
  });

  it("gives every outbound HTTP request an explicit body/header contract", async () => {
    const path = fileURLToPath(
      new URL("../../n8n/SnapGad-Content-Engine-V1.json", import.meta.url),
    );
    const workflow = JSON.parse(await readFile(path, "utf8")) as {
      nodes?: N8nNode[];
    };
    const requests = (workflow.nodes ?? []).filter(
      (node) => node.type === "n8n-nodes-base.httpRequest",
    );

    expect(requests.length).toBeGreaterThan(0);
    for (const node of requests) {
      const parameters = node.parameters;
      expect(parameters?.sendHeaders, node.name).toBe(true);
      expect(parameters?.headerParameters?.parameters?.length, node.name).toBeGreaterThan(0);
      if (parameters?.sendBody) {
        expect(parameters.specifyBody, node.name).toBe("json");
        expect(parameters.jsonBody, node.name).toEqual(expect.any(String));
      }
    }
  });

  it("keeps idempotency keys after callback HTTP nodes replace the current item", async () => {
    const path = fileURLToPath(
      new URL("../../n8n/SnapGad-Content-Engine-V1.json", import.meta.url),
    );
    const workflow = JSON.parse(await readFile(path, "utf8")) as {
      nodes?: N8nNode[];
    };
    const byName = new Map((workflow.nodes ?? []).map((node) => [node.name, node]));

    expect(byName.get("Copy — Registrar Callback")?.parameters?.url).toEqual(
      expect.stringContaining("Copy — Firmar Callback al Portal"),
    );
    expect(byName.get("Facebook — Registrar Resultado")?.parameters?.url).toEqual(
      expect.stringContaining("Facebook — Firmar Callback"),
    );
    expect(byName.get("Instagram — Registrar Resultado")?.parameters?.url).toEqual(
      expect.stringContaining("Instagram — Firmar Callback"),
    );
  });

  it("signs the JSON actually sent on success and error callbacks", async () => {
    const path = fileURLToPath(
      new URL("../../n8n/SnapGad-Content-Engine-V1.json", import.meta.url),
    );
    const raw = await readFile(path, "utf8");
    const signerScripts = raw
      .split(/\r?\n/)
      .filter((line) => line.includes("callbackError") && line.includes("const stable"));

    expect(signerScripts).toHaveLength(2);
    for (const script of signerScripts) {
      expect(script).toContain("filter((key) => value[key] !== undefined)");
      expect(script).toContain("join(',') + '}'");
    }
  });
});
