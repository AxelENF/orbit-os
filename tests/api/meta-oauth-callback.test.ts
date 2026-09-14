import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieGet = vi.hoisted(() => vi.fn());
const createSupabaseServerClient = vi.hoisted(() => vi.fn());
const createSupabaseServiceRoleClient = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const serverFrom = vi.hoisted(() => vi.fn());
const serviceFrom = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
}));

import { GET } from "@/app/api/integrations/meta/callback/route";
import { META_OAUTH_NONCE_COOKIE } from "@/app/api/integrations/meta/connect/route";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const appSecret = "meta-app-secret";
const nowSeconds = 1_789_296_000;

type Page = { id: string; name: string; access_token: string };

function signedState(nonce: string, exp = nowSeconds + 600): string {
  const payload = Buffer.from(
    JSON.stringify({ organization_id: organizationId, nonce, exp }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", appSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function configureMembership(role: "owner" | "editor" | "reviewer" | "viewer") {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { role }, error: null });
  const byUser = vi.fn().mockReturnValue({ maybeSingle });
  const byOrganization = vi.fn().mockReturnValue({ eq: byUser });
  const select = vi.fn().mockReturnValue({ eq: byOrganization });
  serverFrom.mockReturnValue({ select });
}

function configureAuthenticatedOwner() {
  getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  configureMembership("owner");
  createSupabaseServerClient.mockResolvedValue({ auth: { getUser }, from: serverFrom });
}

function configureGraph(pages: Page[], accountPages: Page[][] = [pages]) {
  let accountPageIndex = 0;
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path.endsWith("/oauth/access_token") && url.searchParams.has("code")) {
      return Response.json({ access_token: "short-lived-user-token" });
    }
    if (path.endsWith("/oauth/access_token") && url.searchParams.get("grant_type") === "fb_exchange_token") {
      return Response.json({ access_token: "long-lived-user-token" });
    }
    if (path.endsWith("/me/accounts")) {
      const data = accountPages[Math.min(accountPageIndex, accountPages.length - 1)] ?? [];
      accountPageIndex += 1;
      return Response.json({
        data,
        ...(accountPageIndex < accountPages.length
          ? { paging: { next: `https://graph.facebook.com/v21.0/me/accounts?after=cursor-${accountPageIndex}` } }
          : {}),
      });
    }

    const page = pages.find(({ id }) => path.endsWith(`/${id}`));
    if (page) {
      return Response.json({ instagram_business_account: { id: `instagram-account-${page.id}` } });
    }

    throw new Error(`Unexpected Graph API request: ${url}`);
  });
}

function configureSupabaseServiceRole() {
  serviceFrom.mockReturnValue({ insert });
  insert.mockResolvedValue({ error: null });
  createSupabaseServiceRoleClient.mockReturnValue({ rpc, from: serviceFrom });
  rpc.mockResolvedValue({ data: { connected: true }, error: null });
}

function callbackRequest(nonce = "11111111-1111-4111-8111-111111111111") {
  const state = signedState(nonce);
  return new Request(
    `https://orbit.example/api/integrations/meta/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
  );
}

describe("GET /api/integrations/meta/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSeconds * 1000));
    vi.stubEnv("META_APP_ID", "meta-app-id");
    vi.stubEnv("META_APP_SECRET", appSecret);
    vi.stubEnv("NODE_ENV", "production");
    configureAuthenticatedOwner();
    configureSupabaseServiceRole();
    vi.stubGlobal("fetch", fetchMock);
    cookieGet.mockReturnValue({ value: "11111111-1111-4111-8111-111111111111" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rechaza si el nonce del state no coincide con el de la cookie", async () => {
    configureGraph([{ id: "page-1", name: "Página Uno", access_token: "page-token-1" }]);

    const response = await GET(callbackRequest("22222222-2222-4222-8222-222222222222"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "OAUTH_NONCE_MISMATCH" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rechaza antes del nonce si la sesión no puede gestionar conexiones en la organización", async () => {
    configureMembership("editor");

    const response = await GET(callbackRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "ORGANIZATION_ACCESS_DENIED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it("con una sola página intercambia y extiende el token, descubre Instagram y persiste directo", async () => {
    configureGraph([{ id: "page-1", name: "Página Uno", access_token: "page-token-1" }]);

    const response = await GET(callbackRequest());

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/settings/organizations");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(rpc).toHaveBeenCalledWith("upsert_meta_connection", {
      p_organization_id: organizationId,
      p_connected_by: userId,
      p_facebook_page_id: "page-1",
      p_facebook_page_name: "Página Uno",
      p_instagram_business_account_id: "instagram-account-page-1",
      p_page_access_token: "page-token-1",
    });
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it("con varias páginas guarda una sesión temporal sin tokens de página y redirige al selector", async () => {
    const pages = [
      { id: "page-1", name: "Página Uno", access_token: "page-token-1" },
      { id: "page-2", name: "Página Dos", access_token: "page-token-2" },
    ];
    configureGraph(pages);

    const response = await GET(callbackRequest());

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/settings/organizations");
    expect(location.searchParams.get("metaOAuth")).toBe("select");
    expect(location.searchParams.get("nonce")).toBe("11111111-1111-4111-8111-111111111111");
    expect(rpc).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith({
      nonce: "11111111-1111-4111-8111-111111111111",
      organization_id: organizationId,
      discovered_pages: [
        { id: "page-1", name: "Página Uno", hasInstagram: true },
        { id: "page-2", name: "Página Dos", hasInstagram: true },
      ],
      user_long_lived_token: "long-lived-user-token",
      created_by: userId,
      expires_at: new Date((nowSeconds + 600) * 1000).toISOString(),
    });
    expect(JSON.stringify(insert.mock.calls[0]?.[0])).not.toContain("page-token");
  });

  it("sigue paging.next y guarda también las páginas que Meta devuelve después", async () => {
    const firstPage = { id: "page-1", name: "Página Uno", access_token: "page-token-1" };
    const secondPage = { id: "page-2", name: "Página Dos", access_token: "page-token-2" };
    configureGraph([firstPage, secondPage], [[firstPage], [secondPage]]);

    const response = await GET(callbackRequest());

    expect(response.status).toBe(302);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      discovered_pages: [
        { id: "page-1", name: "Página Uno", hasInstagram: true },
        { id: "page-2", name: "Página Dos", hasInstagram: true },
      ],
    }));
  });

  it("nunca incluye tokens de Meta en la respuesta al navegador", async () => {
    configureGraph([{ id: "page-1", name: "Página Uno", access_token: "page-token-1" }]);

    const response = await GET(callbackRequest());
    const responseText = await response.text();
    const headersText = [...response.headers.entries()].map(([key, value]) => `${key}:${value}`).join("\n");

    expect(`${responseText}\n${headersText}`).not.toContain("short-lived-user-token");
    expect(`${responseText}\n${headersText}`).not.toContain("long-lived-user-token");
    expect(`${responseText}\n${headersText}`).not.toContain("page-token-1");
    expect(response.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(META_OAUTH_NONCE_COOKIE).toBe("snapgad_meta_oauth_nonce");
  });
});
