import {
  canManageConnections,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import {
  META_OAUTH_NONCE_COOKIE,
  META_OAUTH_STATE_MAX_AGE_SECONDS,
  verifySignedMetaOAuthState,
} from "@/lib/integrations/meta-oauth-state";
import { GRAPH_API_BASE } from "@/lib/integrations/meta-graph-client";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { cookies } from "next/headers";

type GraphRecord = Record<string, unknown>;

type MetaPage = {
  id: string;
  name: string;
  access_token: string;
};

type DiscoveredPage = {
  id: string;
  name: string;
  hasInstagram: boolean;
  instagramBusinessAccountId: string | null;
};

type CallbackDependencies = {
  fetchFn?: typeof fetch;
  nowSeconds?: () => number;
};

class MetaOAuthCallbackError extends Error {}

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Cookie",
      },
    },
  );
}

function redirectToSettings(request: Request, params: Record<string, string>): Response {
  const location = new URL("/settings/organizations", request.url);
  for (const [key, value] of Object.entries(params)) location.searchParams.set(key, value);
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: location.toString(),
      Vary: "Cookie",
    },
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordValue(value: unknown): GraphRecord | null {
  return typeof value === "object" && value !== null ? (value as GraphRecord) : null;
}

function requiredToken(response: GraphRecord): string {
  const token = stringValue(response.access_token);
  if (!token) throw new MetaOAuthCallbackError("META_TOKEN_RESPONSE_INVALID");
  return token;
}

async function graphGet(
  fetchFn: typeof fetch,
  path: string,
  params: Record<string, string>,
): Promise<GraphRecord> {
  const url = new URL(`${GRAPH_API_BASE}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new MetaOAuthCallbackError("META_GRAPH_REQUEST_FAILED");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MetaOAuthCallbackError("META_GRAPH_RESPONSE_INVALID");
  }

  const record = recordValue(payload);
  if (!response.ok || record?.error !== undefined || !record) {
    throw new MetaOAuthCallbackError("META_GRAPH_REQUEST_FAILED");
  }
  return record;
}

async function discoverPages(
  fetchFn: typeof fetch,
  userToken: string,
): Promise<Array<MetaPage & DiscoveredPage>> {
  const accounts = await graphGet(fetchFn, "me/accounts", {
    fields: "id,name,access_token",
    access_token: userToken,
  });
  if (!Array.isArray(accounts.data) || accounts.data.length === 0) {
    throw new MetaOAuthCallbackError("META_NO_PAGES");
  }

  const pages: Array<MetaPage & DiscoveredPage> = [];
  for (const item of accounts.data) {
    const page = recordValue(item);
    const id = stringValue(page?.id);
    const name = stringValue(page?.name);
    const accessToken = stringValue(page?.access_token);
    if (!id || !name || !accessToken) throw new MetaOAuthCallbackError("META_PAGE_RESPONSE_INVALID");

    const details = await graphGet(fetchFn, id, {
      fields: "instagram_business_account",
      access_token: accessToken,
    });
    const instagram = recordValue(details.instagram_business_account);
    pages.push({
      id,
      name,
      access_token: accessToken,
      hasInstagram: stringValue(instagram?.id) !== null,
      instagramBusinessAccountId: stringValue(instagram?.id),
    });
  }
  return pages;
}

export function createMetaOAuthCallbackHandler(
  dependencies: CallbackDependencies = {},
): (request: Request) => Promise<Response> {
  const nowSeconds = dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return async function handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rawState = url.searchParams.get("state");
    const appSecret = process.env.META_APP_SECRET?.trim();
    if (!appSecret) return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);

    const state = rawState
      ? verifySignedMetaOAuthState(rawState, appSecret, nowSeconds())
      : null;
    if (!state) return jsonError("INVALID_OAUTH_STATE", 400);

    let supabase;
    try {
      supabase = await createSupabaseServerClient();
    } catch {
      return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);
    }

    const {
      data: { user },
      error: sessionError,
    } = await supabase.auth.getUser();
    if (sessionError || !user) return jsonError("AUTHENTICATION_REQUIRED", 401);

    const { data: membership, error: membershipError } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", state.organization_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
    if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);
    if (!canManageConnections(membership.role as OrganizationRole)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    const cookieStore = await cookies();
    if (cookieStore.get(META_OAUTH_NONCE_COOKIE)?.value !== state.nonce) {
      return jsonError("OAUTH_NONCE_MISMATCH", 400);
    }

    const code = url.searchParams.get("code")?.trim();
    if (!code) return jsonError("OAUTH_CODE_MISSING", 400);

    const appId = process.env.META_APP_ID?.trim();
    if (!appId) return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);

    try {
      const fetchFn = dependencies.fetchFn ?? fetch;
      const redirectUri = new URL("/api/integrations/meta/callback", request.url).toString();
      const shortLivedToken = requiredToken(
        await graphGet(fetchFn, "oauth/access_token", {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUri,
          code,
        }),
      );
      const longLivedToken = requiredToken(
        await graphGet(fetchFn, "oauth/access_token", {
          grant_type: "fb_exchange_token",
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: shortLivedToken,
        }),
      );
      const pages = await discoverPages(fetchFn, longLivedToken);
      const serviceRole = createSupabaseServiceRoleClient();

      if (pages.length === 1) {
        const page = pages[0]!;
        const { error } = await serviceRole.rpc("upsert_meta_connection", {
          p_organization_id: state.organization_id,
          p_connected_by: user.id,
          p_facebook_page_id: page.id,
          p_facebook_page_name: page.name,
          p_instagram_business_account_id: page.instagramBusinessAccountId,
          p_page_access_token: page.access_token,
        });
        if (error) throw new MetaOAuthCallbackError("META_CONNECTION_PERSIST_FAILED");
        return redirectToSettings(request, { metaOAuth: "connected" });
      }

      const { error } = await serviceRole
        .from("organization_meta_oauth_sessions")
        .insert({
          nonce: state.nonce,
          organization_id: state.organization_id,
        discovered_pages: pages.map(({ id, name, hasInstagram }) => ({ id, name, hasInstagram })),
          user_long_lived_token: longLivedToken,
          created_by: user.id,
          expires_at: new Date(state.exp * 1000).toISOString(),
        });
      if (error) throw new MetaOAuthCallbackError("META_OAUTH_SESSION_PERSIST_FAILED");
      return redirectToSettings(request, {
        metaOAuth: "select",
        nonce: state.nonce,
      });
    } catch {
      return jsonError("META_OAUTH_CALLBACK_FAILED", 502);
    }
  };
}

export const GET = createMetaOAuthCallbackHandler();

export { META_OAUTH_NONCE_COOKIE, META_OAUTH_STATE_MAX_AGE_SECONDS };
