import { z } from "zod";

import { cookies } from "next/headers";

import {
  canManageConnections,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import { META_OAUTH_NONCE_COOKIE } from "@/lib/integrations/meta-oauth-state";
import {
  collectGraphCollection,
  GRAPH_API_BASE,
} from "@/lib/integrations/meta-graph-client";
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
  createdBy: string;
};

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

function parseOAuthSession(value: unknown): OAuthSession | null {
  if (!isRecord(value)) return null;
  const organizationId = stringValue(value.organizationId);
  const expiresAt = stringValue(value.expiresAt);
  const discoveredPages = parseDiscoveredPages(value.discoveredPages);
  const createdBy = stringValue(value.createdBy);
  const userLongLivedToken = stringValue(value.userLongLivedToken);
  if (!organizationId || !expiresAt || !discoveredPages || !createdBy || !userLongLivedToken) {
    return null;
  }

  return { organizationId, discoveredPages, expiresAt, createdBy, userLongLivedToken };
}

function sessionIsExpired(session: OAuthSession, currentTime: Date): boolean {
  const expiresAtMs = new Date(session.expiresAt).getTime();
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= currentTime.getTime();
}

async function graphGet(
  fetchFn: typeof fetch,
  path: string,
  params: Record<string, string>,
): Promise<GraphRecord> {
  const url = new URL(
    /^https?:\/\//i.test(path)
      ? path
      : `${GRAPH_API_BASE}/${path.replace(/^\/+/, "")}`,
  );
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
      ({ data: rawSession, error: sessionLookupError } = await serviceRole.rpc(
        "resolve_meta_oauth_session",
        {
          p_organization_id: payload.data.organizationId,
          p_nonce: payload.data.nonce,
        },
      ));
    } catch {
      return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);
    }
    if (sessionLookupError) return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);

    const oauthSession = parseOAuthSession(rawSession);
    if (!oauthSession || sessionIsExpired(oauthSession, currentTime)) {
      return jsonError("META_OAUTH_SESSION_EXPIRED", 400);
    }

    if (oauthSession.organizationId !== payload.data.organizationId) {
      return jsonError("META_OAUTH_SESSION_EXPIRED", 400);
    }

    if (oauthSession.createdBy !== user.id) {
      return jsonError("META_OAUTH_SESSION_ACTOR_MISMATCH", 403);
    }

    if (!oauthSession.discoveredPages.some(({ id }) => id === payload.data.pageId)) {
      return jsonError("META_PAGE_NOT_FOUND", 400);
    }

    try {
      const fetchFn = dependencies.fetchFn ?? fetch;
      const accountItems = await collectGraphCollection<unknown>(graphGet.bind(null, fetchFn), "me/accounts", {
        fields: "id,name,access_token",
        access_token: oauthSession.userLongLivedToken,
      });
      const selectedPage = selectedPageFromAccounts({ data: accountItems }, payload.data.pageId);
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

    const cookieStore = await cookies();
    if (cookieStore.get(META_OAUTH_NONCE_COOKIE)?.value !== nonce.data) {
      return jsonError("OAUTH_NONCE_MISMATCH", 400);
    }

    // The browser only supplies the nonce. Resolve it through each organization
    // the actor can manage instead of reading the token-bearing session table.
    // `nonce` is the primary key, so at most one authorized organization can
    // resolve it; the creator check below prevents handoff between collaborators.
    const { data: membershipRows, error: membershipError } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", user.id);
    if (membershipError) return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);

    const memberships = Array.isArray(membershipRows)
      ? membershipRows.flatMap((membership) => {
          const organizationId = stringValue(membership.organization_id);
          const role = stringValue(membership.role);
          if (!organizationId || !role || !canManageConnections(role as OrganizationRole)) return [];
          return [{ organizationId }];
        })
      : [];
    if (memberships.length === 0) return jsonError("ORGANIZATION_NOT_FOUND", 404);

    let serviceRole;
    try {
      serviceRole = createSupabaseServiceRoleClient();
    } catch {
      return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);
    }

    let oauthSession: OAuthSession | null = null;
    for (const membership of memberships) {
      let rawSession: unknown;
      let sessionLookupError: unknown;
      try {
        ({ data: rawSession, error: sessionLookupError } = await serviceRole.rpc(
          "resolve_meta_oauth_session",
          {
            p_organization_id: membership.organizationId,
            p_nonce: nonce.data,
          },
        ));
      } catch {
        return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);
      }
      if (sessionLookupError) return jsonError("META_OAUTH_SESSION_LOOKUP_FAILED", 503);

      const candidate = parseOAuthSession(rawSession);
      if (!candidate) continue;
      if (candidate.organizationId !== membership.organizationId) {
        return jsonError("META_OAUTH_SESSION_EXPIRED", 400);
      }
      oauthSession = candidate;
      break;
    }

    if (!oauthSession || sessionIsExpired(oauthSession, now())) {
      return jsonError("META_OAUTH_SESSION_EXPIRED", 400);
    }

    if (oauthSession.createdBy !== user.id) {
      return jsonError("META_OAUTH_SESSION_ACTOR_MISMATCH", 403);
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
