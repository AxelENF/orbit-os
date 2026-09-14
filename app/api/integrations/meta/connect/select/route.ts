import { z } from "zod";

import { cookies } from "next/headers";

import {
  canManageConnections,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import { META_OAUTH_NONCE_COOKIE } from "@/lib/integrations/meta-oauth-state";
import { GRAPH_API_BASE } from "@/lib/integrations/meta-graph-client";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

const inputSchema = z.object({
  organizationId: z.string().uuid(),
  nonce: z.string().uuid(),
  pageId: z.string().trim().min(1).max(512),
});
const nonceSchema = z.string().uuid();

type GraphRecord = Record<string, unknown>;

type OAuthSession = {
  organizationId: string;
  discoveredPages: Array<{ id: string; name: string; hasInstagram: boolean }>;
  userLongLivedToken: string;
  expiresAt: string;
};

type OAuthSessionPreview = Pick<OAuthSession, "organizationId" | "discoveredPages" | "expiresAt">;

type OAuthSessionBinding = Pick<OAuthSession, "expiresAt"> & { createdBy: string };

type SelectDependencies = {
  fetchFn?: typeof fetch;
  now?: () => Date;
};

class MetaOAuthSelectError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function jsonError(error: string, status: number, details: Record<string, string> = {}): Response {
  return Response.json(
    { error, ...details },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Cookie",
      },
    },
  );
}

function redirectToSettings(request: Request): Response {
  const location = new URL("/settings/organizations", request.url);
  location.searchParams.set("metaOAuth", "connected");
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: location.toString(),
      Vary: "Cookie",
    },
  });
}

function isRecord(value: unknown): value is GraphRecord {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseDiscoveredPages(value: unknown): OAuthSession["discoveredPages"] | null {
  if (!Array.isArray(value)) return null;

  return value.flatMap((page): OAuthSession["discoveredPages"] => {
    if (!isRecord(page)) return [];
    const id = stringValue(page.id);
    const name = stringValue(page.name);
    if (!id || !name || typeof page.hasInstagram !== "boolean") return [];
    return [{ id, name, hasInstagram: page.hasInstagram }];
  });
}

function parseOAuthSessionPreview(value: unknown): OAuthSessionPreview | null {
  if (!isRecord(value)) return null;
  const organizationId = stringValue(value.organization_id);
  const expiresAt = stringValue(value.expires_at);
  const discoveredPages = parseDiscoveredPages(value.discovered_pages);
  if (!organizationId || !expiresAt || !discoveredPages) {
    return null;
  }

  return { organizationId, discoveredPages, expiresAt };
}

function parseOAuthSession(value: unknown): OAuthSession | null {
  const preview = parseOAuthSessionPreview(value);
  if (!preview || !isRecord(value)) return null;
  const userLongLivedToken = stringValue(value.user_long_lived_token);
  if (!userLongLivedToken) return null;

  return { ...preview, userLongLivedToken };
}

function parseOAuthSessionBinding(value: unknown): OAuthSessionBinding | null {
  if (!isRecord(value)) return null;
  const createdBy = stringValue(value.created_by);
  const expiresAt = stringValue(value.expires_at);
  if (!createdBy || !expiresAt) return null;
  return { createdBy, expiresAt };
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
    throw new MetaOAuthSelectError("META_GRAPH_REQUEST_FAILED");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MetaOAuthSelectError("META_GRAPH_RESPONSE_INVALID");
  }

  if (!response.ok || !isRecord(payload) || payload.error !== undefined) {
    throw new MetaOAuthSelectError("META_GRAPH_REQUEST_FAILED");
  }
  return payload;
}

function selectedPageFromAccounts(
  accounts: GraphRecord,
  pageId: string,
): { id: string; name: string; accessToken: string } {
  if (!Array.isArray(accounts.data)) {
    throw new MetaOAuthSelectError("META_PAGE_RESPONSE_INVALID");
  }
  const account = accounts.data.find(
    (item) => isRecord(item) && stringValue(item.id) === pageId,
  );
  if (!isRecord(account)) throw new MetaOAuthSelectError("META_PAGE_NOT_FOUND");

  const id = stringValue(account.id);
  const name = stringValue(account.name);
  const accessToken = stringValue(account.access_token);
  if (!id || !name || !accessToken) {
    throw new MetaOAuthSelectError("META_PAGE_RESPONSE_INVALID");
  }
  return { id, name, accessToken };
}

function instagramBusinessAccountId(details: GraphRecord): string | null {
  const instagram = isRecord(details.instagram_business_account)
    ? details.instagram_business_account
    : null;
  return stringValue(instagram?.id);
}

export function createMetaOAuthSelectHandler(
  dependencies: SelectDependencies = {},
): (request: Request) => Promise<Response> {
  const now = dependencies.now ?? (() => new Date());

  return async function handleSelect(request: Request): Promise<Response> {
    const payload = inputSchema.safeParse(await request.json().catch(() => null));
    if (!payload.success) return jsonError("INVALID_REQUEST", 400);

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

    const cookieStore = await cookies();
    if (cookieStore.get(META_OAUTH_NONCE_COOKIE)?.value !== payload.data.nonce) {
      return jsonError("OAUTH_NONCE_MISMATCH", 400);
    }

    const { data: membership, error: membershipError } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", payload.data.organizationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
    if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);
    if (!canManageConnections(membership.role as OrganizationRole)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    let serviceRole;
    try {
      serviceRole = createSupabaseServiceRoleClient();
    } catch {
      return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);
    }

    const currentTime = now();
    let rawSession: unknown;
    let sessionLookupError: unknown;
    try {
      ({ data: rawSession, error: sessionLookupError } = await serviceRole
        .from("organization_meta_oauth_sessions")
        .select("created_by, expires_at")
        .eq("organization_id", payload.data.organizationId)
        .eq("nonce", payload.data.nonce)
        .gt("expires_at", currentTime.toISOString())
        .maybeSingle());
    } catch {
      return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);
    }
    if (sessionLookupError) return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);

    const sessionBinding = parseOAuthSessionBinding(rawSession);
    const bindingExpiresAtMs = sessionBinding ? new Date(sessionBinding.expiresAt).getTime() : NaN;
    if (
      !sessionBinding ||
      !Number.isFinite(bindingExpiresAtMs) ||
      bindingExpiresAtMs <= currentTime.getTime()
    ) {
      return jsonError("META_OAUTH_SESSION_EXPIRED", 400);
    }

    if (sessionBinding.createdBy !== user.id) {
      return jsonError("META_OAUTH_SESSION_ACTOR_MISMATCH", 403);
    }

    try {
      ({ data: rawSession, error: sessionLookupError } = await serviceRole
        .from("organization_meta_oauth_sessions")
        .select("organization_id, discovered_pages, user_long_lived_token, expires_at")
        .eq("organization_id", payload.data.organizationId)
        .eq("nonce", payload.data.nonce)
        .gt("expires_at", currentTime.toISOString())
        .maybeSingle());
    } catch {
      return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);
    }
    if (sessionLookupError) return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);

    const oauthSession = parseOAuthSession(rawSession);
    const expiresAtMs = oauthSession ? new Date(oauthSession.expiresAt).getTime() : NaN;
    if (!oauthSession || !Number.isFinite(expiresAtMs) || expiresAtMs <= currentTime.getTime()) {
      return jsonError("META_OAUTH_SESSION_EXPIRED", 400);
    }

    if (!oauthSession.discoveredPages.some(({ id }) => id === payload.data.pageId)) {
      return jsonError("META_PAGE_NOT_FOUND", 400);
    }

    try {
      const fetchFn = dependencies.fetchFn ?? fetch;
      const accounts = await graphGet(fetchFn, "me/accounts", {
        fields: "id,name,access_token",
        access_token: oauthSession.userLongLivedToken,
      });
      const selectedPage = selectedPageFromAccounts(accounts, payload.data.pageId);
      const details = await graphGet(fetchFn, selectedPage.id, {
        fields: "instagram_business_account",
        access_token: selectedPage.accessToken,
      });

      const { error: selectionError } = await serviceRole.rpc("complete_meta_oauth_selection", {
        p_organization_id: oauthSession.organizationId,
        p_nonce: payload.data.nonce,
        p_connected_by: user.id,
        p_facebook_page_id: selectedPage.id,
        p_facebook_page_name: selectedPage.name,
        p_instagram_business_account_id: instagramBusinessAccountId(details),
        p_page_access_token: selectedPage.accessToken,
      });
      if (selectionError) throw new MetaOAuthSelectError("META_CONNECTION_PERSIST_FAILED");

      return redirectToSettings(request);
    } catch (error) {
      if (error instanceof MetaOAuthSelectError) {
        return jsonError(error.code, 502);
      }
      return jsonError("META_OAUTH_SELECTION_FAILED", 502);
    }
  };
}

export function createMetaOAuthPagesHandler(
  dependencies: Pick<SelectDependencies, "now"> = {},
): (request: Request) => Promise<Response> {
  const now = dependencies.now ?? (() => new Date());

  return async function handlePages(request: Request): Promise<Response> {
    const nonce = nonceSchema.safeParse(new URL(request.url).searchParams.get("nonce")?.trim());
    if (!nonce.success) return jsonError("INVALID_REQUEST", 400);

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

    let serviceRole;
    try {
      serviceRole = createSupabaseServiceRoleClient();
    } catch {
      return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);
    }

    let rawSession: unknown;
    let sessionLookupError: unknown;
    try {
      ({ data: rawSession, error: sessionLookupError } = await serviceRole
        .from("organization_meta_oauth_sessions")
        .select("organization_id, discovered_pages, expires_at")
        .eq("nonce", nonce.data)
        .maybeSingle());
    } catch {
      return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);
    }
    if (sessionLookupError) return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);

    const oauthSession = parseOAuthSessionPreview(rawSession);
    if (!oauthSession) return jsonError("META_OAUTH_SESSION_EXPIRED", 400);

    const { data: membership, error: membershipError } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", oauthSession.organizationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
    if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);
    if (!canManageConnections(membership.role as OrganizationRole)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    const expiresAtMs = new Date(oauthSession.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
      return jsonError("META_OAUTH_SESSION_EXPIRED", 400, {
        organizationId: oauthSession.organizationId,
      });
    }

    return Response.json(
      {
        organizationId: oauthSession.organizationId,
        pages: oauthSession.discoveredPages,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          Vary: "Cookie",
        },
      },
    );
  };
}

export const GET = createMetaOAuthPagesHandler();
export const POST = createMetaOAuthSelectHandler();
