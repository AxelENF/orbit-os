import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServerClient = vi.hoisted(() => vi.fn());
const createSupabaseServiceRoleClient = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const serverFrom = vi.hoisted(() => vi.fn());
const revokeRpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
}));

import { POST } from "@/app/api/integrations/meta/disconnect/route";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";

function configureMembership(role: "owner" | "editor" | "reviewer" | "viewer" = "owner") {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn().mockResolvedValue({ data: { role }, error: null }),
  };
  serverFrom.mockReturnValue(chain);
  return chain;
}

function request(body: unknown) {
  return new Request("https://orbit.example/api/integrations/meta/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/integrations/meta/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
    configureMembership();
    revokeRpc.mockResolvedValue({ data: { revoked: true }, error: null });
    createSupabaseServerClient.mockResolvedValue({ auth: { getUser }, from: serverFrom });
    createSupabaseServiceRoleClient.mockReturnValue({ rpc: revokeRpc });
  });

  it("revokes the requested organization without accepting a client-supplied actor", async () => {
    const response = await POST(request({ organizationId, actorId: "attacker-id" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    expect(revokeRpc).toHaveBeenCalledWith("revoke_meta_connection", {
      p_organization_id: organizationId,
    });
    expect(JSON.stringify(revokeRpc.mock.calls)).not.toContain("attacker-id");
  });

  it("rejects a member who cannot manage connections before calling revoke", async () => {
    configureMembership("editor");

    const response = await POST(request({ organizationId }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "ORGANIZATION_ACCESS_DENIED" });
    expect(revokeRpc).not.toHaveBeenCalled();
  });
});
