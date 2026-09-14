import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServerClient = vi.hoisted(() => vi.fn());
const createSupabaseServiceRoleClient = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const serverFrom = vi.hoisted(() => vi.fn());
const serviceFrom = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const deleteSession = vi.hoisted(() => vi.fn());
const cookieGet = vi.hoisted(() => vi.fn());
const serviceSelectColumns = vi.hoisted(() => [] as string[]);
const testEvents = vi.hoisted(() => [] as string[]);

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
}));

import { GET, POST } from "@/app/api/integrations/meta/connect/select/route";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const nonce = "11111111-1111-4111-8111-111111111111";
const nowSeconds = 1_789_296_000;

const pages = [
  { id: "page-1", name: "Página Uno", hasInstagram: true },
  { id: "page-2", name: "Página Dos", hasInstagram: false },
];

function configureMembership(role: "owner" | "editor" | "reviewer" | "viewer") {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { role }, error: null });
  const byUser = vi.fn().mockReturnValue({ maybeSingle });
  const byOrganization = vi.fn().mockReturnValue({ eq: byUser });
  const select = vi.fn().mockImplementation(() => {
    testEvents.push("membership");
    return { eq: byOrganization };
  });
  serverFrom.mockReturnValue({ select });
}

function configureAuthenticatedOwner() {
  getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  configureMembership("owner");
  createSupabaseServerClient.mockResolvedValue({ auth: { getUser }, from: serverFrom });
}

function configureSession(overrides: Record<string, unknown> = {}) {
  const session = {
    nonce,
    organization_id: organizationId,
    discovered_pages: pages,
    user_long_lived_token: "long-lived-user-token",
    created_by: userId,
    expires_at: new Date((nowSeconds + 600) * 1000).toISOString(),
    ...overrides,
  };
  const maybeSingle = vi.fn().mockResolvedValue({ data: session, error: null });
  const select = vi.fn().mockImplementation((columns: string) => {
    serviceSelectColumns.push(columns);
    testEvents.push(`session:${columns}`);
    const query = {
      eq: vi.fn(),
      gt: vi.fn(),
      maybeSingle,
    };
    query.eq.mockReturnValue(query);
    query.gt.mockReturnValue(query);
    return query;
  });
  const deleteQuery = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: deleteSession }) });

  serviceFrom.mockImplementation((table: string) => {
    if (table !== "organization_meta_oauth_sessions") throw new Error(`Unexpected table: ${table}`);
    return { select, delete: deleteQuery };
  });
  createSupabaseServiceRoleClient.mockReturnValue({ from: serviceFrom, rpc });
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

function selectRequest(selectedPageId = "page-1") {
  return new Request("https://orbit.example/api/integrations/meta/connect/select", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId, nonce, pageId: selectedPageId }),
  });
}

function pagesRequest() {
  return new Request(
    `https://orbit.example/api/integrations/meta/connect/select?nonce=${encodeURIComponent(nonce)}`,
  );
}

describe("POST /api/integrations/meta/connect/select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceSelectColumns.length = 0;
    testEvents.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSeconds * 1000));
    vi.stubGlobal("fetch", fetchMock);
    configureAuthenticatedOwner();
    configureSession();
    rpc.mockResolvedValue({ data: { connected: true }, error: null });
    deleteSession.mockResolvedValue({ error: null });
    cookieGet.mockReturnValue({ value: nonce });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rechaza si canManageConnections(role) es false", async () => {
    configureMembership("editor");

    const response = await POST(selectRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "ORGANIZATION_ACCESS_DENIED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("con nonce y pageId válidos vuelve a llamar /me/accounts con el token guardado y persiste solo la página elegida", async () => {
    configureGraph();

    const response = await POST(selectRequest());

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("metaOAuth")).toBe("connected");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("complete_meta_oauth_selection", {
      p_organization_id: organizationId,
      p_nonce: nonce,
      p_connected_by: userId,
      p_facebook_page_id: "page-1",
      p_facebook_page_name: "Página Uno",
      p_instagram_business_account_id: "instagram-account-page-1",
      p_page_access_token: "page-token-1",
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("page-token-2");
  });

  it("rechaza si el nonce del POST no coincide con la cookie httpOnly", async () => {
    cookieGet.mockReturnValue({ value: "22222222-2222-4222-8222-222222222222" });

    const response = await POST(selectRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "OAUTH_NONCE_MISMATCH" });
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("comprueba membresía antes de leer cualquier campo de la sesión temporal", async () => {
    configureGraph();

    const response = await POST(selectRequest());

    expect(response.status).toBe(302);
    expect(testEvents.indexOf("membership")).toBeGreaterThanOrEqual(0);
    expect(testEvents.indexOf("session:created_by, expires_at")).toBeGreaterThan(
      testEvents.indexOf("membership"),
    );
    expect(testEvents.indexOf("session:organization_id, discovered_pages, user_long_lived_token, expires_at")).toBeGreaterThan(
      testEvents.indexOf("membership"),
    );
  });

  it("rechaza una sesión temporal creada por otro usuario antes de leer su token", async () => {
    configureSession({ created_by: "20000000-0000-4000-8000-000000000002" });

    const response = await POST(selectRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "META_OAUTH_SESSION_ACTOR_MISMATCH" });
    expect(serviceSelectColumns).toEqual(["created_by, expires_at"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rechaza si la sesión temporal expiró", async () => {
    configureSession({ expires_at: new Date((nowSeconds - 1) * 1000).toISOString() });

    const response = await POST(selectRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "META_OAUTH_SESSION_EXPIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("rechaza si el pageId no está en discovered_pages de esa sesión", async () => {
    configureGraph();

    const response = await POST(selectRequest("page-3"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "META_PAGE_NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("borra la fila de organization_meta_oauth_sessions tras persistir", async () => {
    configureGraph();

    const response = await POST(selectRequest());

    expect(response.status).toBe(302);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("complete_meta_oauth_selection", expect.any(Object));
  });
});

describe("GET /api/integrations/meta/connect/select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSeconds * 1000));
    configureAuthenticatedOwner();
    configureSession();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns only the discovered page fields and organization id, never OAuth tokens", async () => {
    const response = await GET(pagesRequest());

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ organizationId, pages });
    expect(JSON.stringify(payload)).not.toContain("long-lived-user-token");
  });

  it("returns the same clear expiration code when the temporary session is expired", async () => {
    configureSession({ expires_at: new Date((nowSeconds - 1) * 1000).toISOString() });

    const response = await GET(pagesRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "META_OAUTH_SESSION_EXPIRED",
      organizationId,
    });
  });
});
