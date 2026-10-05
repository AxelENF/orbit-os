import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServerClient = vi.hoisted(() => vi.fn());
const createSupabaseServiceRoleClient = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const serverFrom = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const cookieGet = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
}));

import { GET, POST } from "@/app/api/integrations/meta/connect/select/route";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000001";
const nonce = "11111111-1111-4111-8111-111111111111";
const nowSeconds = 1_789_296_000;

const pages = [
  { id: "page-1", name: "Página Uno", hasInstagram: true },
  { id: "page-2", name: "Página Dos", hasInstagram: false },
];

function configureMembership(
  role: "owner" | "editor" | "reviewer" | "viewer" = "owner",
  rows = [{ organization_id: organizationId, role }],
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { role }, error: null });
  const byUser = vi.fn().mockResolvedValue({ data: rows, error: null });
  const byOrganization = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) });
  const select = vi.fn().mockImplementation((columns: string) => {
    if (columns === "organization_id, role") return { eq: byUser };
    return { eq: byOrganization };
  });
  serverFrom.mockReturnValue({ select });
}

function configureAuthenticatedUser() {
  getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  createSupabaseServerClient.mockResolvedValue({ auth: { getUser }, from: serverFrom });
}

function oauthSession(overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    discoveredPages: pages,
    userLongLivedToken: "long-lived-user-token",
    createdBy: userId,
    expiresAt: new Date((nowSeconds + 600) * 1000).toISOString(),
    ...overrides,
  };
}

function configureServiceRole(
  session = oauthSession(),
  options: { returnForAnyOrganization?: boolean } = {},
) {
  rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
    if (name === "resolve_meta_oauth_session") {
      return {
        data: (options.returnForAnyOrganization || params.p_organization_id === session.organizationId)
          && params.p_nonce === nonce
          ? session
          : null,
        error: null,
      };
    }
    if (name === "complete_meta_oauth_selection") return { data: { connected: true }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  createSupabaseServiceRoleClient.mockReturnValue({ rpc });
}

function configureGraph() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/me/accounts")) {
      expect(url.searchParams.get("access_token")).toBe("long-lived-user-token");
      return Response.json({
        data: [
          { id: "page-1", name: "Página Uno", access_token: "page-token-1" },
          { id: "page-2", name: "Página Dos", access_token: "page-token-2" },
        ],
      });
    }
    if (url.pathname.endsWith("/page-1")) {
      expect(url.searchParams.get("access_token")).toBe("page-token-1");
      return Response.json({ instagram_business_account: { id: "instagram-account-page-1" } });
    }
    throw new Error(`Unexpected Graph API request: ${url}`);
  });
}

function selectRequest(selectedPageId = "page-1", selectedOrganizationId = organizationId) {
  return new Request("https://orbit.example/api/integrations/meta/connect/select", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: selectedOrganizationId, nonce, pageId: selectedPageId }),
  });
}

function pagesRequest(candidateNonce = nonce) {
  return new Request(
    `https://orbit.example/api/integrations/meta/connect/select?nonce=${encodeURIComponent(candidateNonce)}`,
  );
}

describe("POST /api/integrations/meta/connect/select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSeconds * 1000));
    vi.stubGlobal("fetch", fetchMock);
    configureAuthenticatedUser();
    configureMembership();
    configureServiceRole();
    cookieGet.mockReturnValue({ value: nonce });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the resolver and atomic completion RPCs without reading the OAuth session table", async () => {
    configureGraph();

    const response = await POST(selectRequest());

    expect(response.status).toBe(302);
    expect(rpc).toHaveBeenNthCalledWith(1, "resolve_meta_oauth_session", {
      p_organization_id: organizationId,
      p_nonce: nonce,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "complete_meta_oauth_selection", {
      p_organization_id: organizationId,
      p_nonce: nonce,
      p_connected_by: userId,
      p_facebook_page_id: "page-1",
      p_facebook_page_name: "Página Uno",
      p_instagram_business_account_id: "instagram-account-page-1",
      p_page_access_token: "page-token-1",
    });
    expect(JSON.stringify(await response.text())).not.toContain("page-token-1");
  });

  it("rejects an OAuth nonce that does not match the httpOnly cookie before resolving", async () => {
    cookieGet.mockReturnValue({ value: "22222222-2222-4222-8222-222222222222" });

    const response = await POST(selectRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "OAUTH_NONCE_MISMATCH" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a collaborator who did not create the temporary OAuth session", async () => {
    configureServiceRole(oauthSession({ createdBy: "20000000-0000-4000-8000-000000000002" }));

    const response = await POST(selectRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "META_OAUTH_SESSION_ACTOR_MISMATCH" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the resolver returns a session from another organization", async () => {
    configureServiceRole(
      oauthSession({ organizationId: otherOrganizationId }),
      { returnForAnyOrganization: true },
    );

    const response = await POST(selectRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "META_OAUTH_SESSION_EXPIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an expired resolved OAuth session before calling Meta", async () => {
    configureServiceRole(oauthSession({ expiresAt: new Date((nowSeconds - 1) * 1000).toISOString() }));

    const response = await POST(selectRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "META_OAUTH_SESSION_EXPIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/integrations/meta/connect/select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSeconds * 1000));
    configureAuthenticatedUser();
    configureMembership();
    configureServiceRole();
    cookieGet.mockReturnValue({ value: nonce });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only through authorized organization RPCs and never returns an OAuth token", async () => {
    const response = await GET(pagesRequest());

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ organizationId, pages });
    expect(JSON.stringify(payload)).not.toContain("long-lived-user-token");
    expect(rpc).toHaveBeenCalledWith("resolve_meta_oauth_session", {
      p_organization_id: organizationId,
      p_nonce: nonce,
    });
  });

  it("denies a page preview whose nonce is not the browser nonce", async () => {
    cookieGet.mockReturnValue({ value: "22222222-2222-4222-8222-222222222222" });

    const response = await GET(pagesRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "OAUTH_NONCE_MISMATCH" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies preview to an actor other than the OAuth session creator", async () => {
    configureServiceRole(oauthSession({ createdBy: "20000000-0000-4000-8000-000000000002" }));

    const response = await GET(pagesRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "META_OAUTH_SESSION_ACTOR_MISMATCH" });
  });

  it("fails closed if an authorized lookup returns another tenant's session", async () => {
    configureServiceRole(
      oauthSession({ organizationId: otherOrganizationId }),
      { returnForAnyOrganization: true },
    );

    const response = await GET(pagesRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "META_OAUTH_SESSION_EXPIRED" });
  });
});
