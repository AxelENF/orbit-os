/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import {
  createApiKeyCreateHandler,
  createApiKeyListHandler,
  createApiKeyRevokeHandler,
} from "@/app/api/organizations/[id]/api-keys/route-handlers";

const organizationId = "1e62a32f-64c2-4da4-bad0-2837baad7812";
const ownerSession = { getSession: async () => ({ userId: "user-1" }), getMembership: async () => ({ role: "owner" }) };

function context(extra: Record<string, string> = {}) {
  return { params: Promise.resolve({ id: organizationId, ...extra }) };
}

describe("POST /api/organizations/[id]/api-keys", () => {
  it("unwraps the single row the RPC returns as an array into a flat object", async () => {
    // Corrección ronda 3 del spec: create_organization_api_key usa
    // `returns table`, que PostgREST expone como un arreglo aunque haya una
    // sola fila — la ruta debe desenvolverlo explícitamente.
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "key-1", key_prefix: "sk_live_a1b2", secret: "sk_live_a1b2c3..." }],
      error: null,
    });
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "key-1", keyPrefix: "sk_live_a1b2", secret: "sk_live_a1b2c3...",
    });
  });

  it("responds 500 if the RPC unexpectedly returns zero or multiple rows, instead of silently picking one", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(500);
  });

  it("responds 403 when the RPC rejects a non-owner", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "NOT_ORGANIZATION_OWNER" } });
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(403);
  });

  it("rejects an empty label with 400 before calling the RPC", async () => {
    const rpc = vi.fn();
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/organizations/[id]/api-keys", () => {
  it("lists key metadata, never the secret or hash", async () => {
    const select = vi.fn().mockReturnThis();
    const eq = vi.fn().mockResolvedValue({
      data: [{ id: "key-1", label: "n8n", key_prefix: "sk_live_a1b2", created_at: "2026-09-15T00:00:00Z", last_used_at: null, revoked_at: null }],
      error: null,
    });
    const from = vi.fn().mockReturnValue({ select, eq });
    const handler = createApiKeyListHandler({ ...ownerSession, getClient: async () => ({ from } as never) });
    const response = await handler(new Request("http://localhost"), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keys[0]).not.toHaveProperty("secret");
    expect(body.keys[0]).not.toHaveProperty("keyHash");
  });

  it("filters by the organization_id in the URL, not just by the caller's owner role", async () => {
    // Corrección ronda 2 de revisión del plan (hallazgo real): la policy de
    // RLS deja leer claves de CUALQUIER organización donde el caller sea
    // owner — sin un filtro explícito por organization_id, un owner de
    // varias organizaciones vería claves de la organización equivocada al
    // pedir GET para una específica.
    const eq = vi.fn().mockResolvedValue({ data: [], error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const handler = createApiKeyListHandler({ ...ownerSession, getClient: async () => ({ from } as never) });
    await handler(new Request("http://localhost"), context());
    expect(eq).toHaveBeenCalledWith("organization_id", organizationId);
  });
});

describe("DELETE /api/organizations/[id]/api-keys/[keyId]", () => {
  it("revokes the key via the RPC when it belongs to the organization in the URL", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "key-1" }, error: null });
    const eq2 = vi.fn().mockReturnValue({ maybeSingle });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ select });
    const handler = createApiKeyRevokeHandler({ ...ownerSession, getClient: async () => ({ from, rpc } as never) });
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context({ keyId: "key-1" }),
    );
    expect(response.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("revoke_organization_api_key", { p_key_id: "key-1" });
  });

  it("responds 404, without calling the RPC, when the key belongs to a DIFFERENT organization than the URL", async () => {
    // Corrección ronda 3 de revisión del plan (hallazgo real de seguridad):
    // revoke_organization_api_key solo recibe p_key_id y valida el owner de
    // la organización REAL de esa clave — no la organización de la URL. Un
    // owner de la organización A Y B podría llamar
    // DELETE /api/organizations/A/api-keys/<clave-de-B> y revocarla, aunque
    // la URL diga A. La ruta debe confirmar que la clave pertenece a la
    // organización de la URL ANTES de invocar la RPC.
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null }); // no existe PARA ESTA organización
    const eq2 = vi.fn().mockReturnValue({ maybeSingle });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const rpc = vi.fn();
    const from = vi.fn().mockReturnValue({ select });
    const handler = createApiKeyRevokeHandler({ ...ownerSession, getClient: async () => ({ from, rpc } as never) });
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context({ keyId: "key-from-another-org" }),
    );
    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// Corrección ronda 1 de revisión del plan (hallazgo real): los tests de
// arriba solo prueban que un error DEVUELTO POR LA RPC se traduce en 403 —
// una implementación que se saltara el gate de la ruta y llamara la RPC
// directamente para CUALQUIER rol pasaría igual, porque el mock de la RPC
// nunca refleja el rol real. Estos tres tests fuerzan el gate a nivel de
// ruta: mockean la resolución de membership (no la RPC) devolviendo un rol
// no-owner, y confirman que la RPC ni se llama.
describe("owner-only gate enforced by the route itself, not just the RPC", () => {
  const nonOwnerSession = { getSession: async () => ({ userId: "user-1" }), getMembership: async () => ({ role: "editor" }) };

  it("POST rejects a non-owner without calling create_organization_api_key", async () => {
    const rpc = vi.fn();
    const handler = createApiKeyCreateHandler({ ...nonOwnerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("GET rejects a non-owner without querying organization_api_keys", async () => {
    const from = vi.fn();
    const handler = createApiKeyListHandler({ ...nonOwnerSession, getClient: async () => ({ from } as never) });
    const response = await handler(new Request("http://localhost"), context());
    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("DELETE rejects a non-owner without calling revoke_organization_api_key", async () => {
    const rpc = vi.fn();
    const handler = createApiKeyRevokeHandler({ ...nonOwnerSession, getClient: async () => ({ rpc } as never) });
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context({ keyId: "key-1" }),
    );
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
