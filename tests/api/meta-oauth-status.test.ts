import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServerClient = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient,
}));

import { GET } from "@/app/api/integrations/meta/status/route";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";

function configureMembership(role: "owner" | "editor" | "reviewer" | "viewer" = "owner") {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn().mockResolvedValue({ data: { role }, error: null }),
  };
  from.mockReturnValue(chain);
  return chain;
}

describe("GET /api/integrations/meta/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
    configureMembership();
    rpc.mockResolvedValue({
      data: {
        status: "ACTIVE",
        facebookPageName: "Página Norte",
        hasInstagram: true,
      },
      error: null,
    });
    createSupabaseServerClient.mockResolvedValue({ auth: { getUser }, from, rpc });
  });

  it("returns the Meta status using the authenticated user as the RPC actor", async () => {
    const response = await GET(
      new Request(`https://orbit.example/api/integrations/meta/status?organizationId=${organizationId}`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ACTIVE",
      facebookPageName: "Página Norte",
      hasInstagram: true,
    });
    expect(rpc).toHaveBeenCalledWith("get_meta_connection_status", {
      p_organization_id: organizationId,
      p_actor_id: userId,
    });
  });

  it("does not call Supabase when the organization id is malformed", async () => {
    const response = await GET(
      new Request("https://orbit.example/api/integrations/meta/status?organizationId=not-an-id"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_ORGANIZATION_ID" });
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
