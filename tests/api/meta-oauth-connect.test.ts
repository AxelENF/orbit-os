import { createHmac } from "node:crypto";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const cookieSet = vi.hoisted(() => vi.fn());
const createSupabaseServerClient = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: cookieSet })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient,
}));

import { GET, META_OAUTH_NONCE_COOKIE } from "@/app/api/integrations/meta/connect/route";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";

function configureMembership(role: "owner" | "editor" | "reviewer" | "viewer") {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { role }, error: null });
  const byUser = vi.fn().mockReturnValue({ maybeSingle });
  const byOrganization = vi.fn().mockReturnValue({ eq: byUser });
  const select = vi.fn().mockReturnValue({ eq: byOrganization });
  from.mockReturnValue({ select });
}

function configureAuthenticatedOwner() {
  getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  configureMembership("owner");
  createSupabaseServerClient.mockResolvedValue({ auth: { getUser }, from });
}

function decodeState(state: string) {
  const [payload, signature] = state.split(".");
  expect(payload).toBeTruthy();
  expect(signature).toBeTruthy();
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
    organization_id: string;
    nonce: string;
    exp: number;
  };
}

function stateSignature(state: string): string {
  const [payload, signature] = state.split(".");
  expect(payload).toBeTruthy();
  expect(signature).toBeTruthy();
  expect(signature).toBe(
    createHmac("sha256", "meta-app-secret").update(payload!).digest("base64url"),
  );
  return signature!;
}

describe("GET /api/integrations/meta/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    vi.stubEnv("META_APP_ID", "meta-app-id");
    vi.stubEnv("META_APP_SECRET", "meta-app-secret");
    vi.stubEnv("NODE_ENV", "production");
    configureAuthenticatedOwner();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("genera un nonce, lo pone en una cookie httpOnly de 10 minutos, y redirige al diálogo OAuth de Facebook", async () => {
    const response = await GET(
      new Request(`https://orbit.example/api/integrations/meta/connect?organizationId=${organizationId}`),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://www.facebook.com");
    expect(location.pathname).toBe("/v21.0/dialog/oauth");
    expect(location.searchParams.get("client_id")).toBe("meta-app-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://orbit.example/api/integrations/meta/callback",
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")?.split(",")).toEqual([
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
      "instagram_basic",
      "instagram_content_publish",
      "business_management",
    ]);

    expect(cookieSet).toHaveBeenCalledWith(
      META_OAUTH_NONCE_COOKIE,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 600,
        path: "/",
      }),
    );
  });

  it("rechaza a quien no puede gestionar conexiones en la organización", async () => {
    configureMembership("editor");

    const response = await GET(
      new Request(`https://orbit.example/api/integrations/meta/connect?organizationId=${organizationId}`),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "ORGANIZATION_ACCESS_DENIED" });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("firma un state con organization_id, el mismo nonce de la cookie y expiración de 10 minutos", async () => {
    const response = await GET(
      new Request(`https://orbit.example/api/integrations/meta/connect?organizationId=${organizationId}`),
    );

    const location = new URL(response.headers.get("location")!);
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();

    stateSignature(state!);
    const payload = decodeState(state!);
    expect(payload.organization_id).toBe(organizationId);
    expect(payload.exp).toBe(Math.floor(Date.now() / 1000) + 600);
    expect(payload.nonce).toBe(cookieSet.mock.calls[0]?.[1]);
  });
});
