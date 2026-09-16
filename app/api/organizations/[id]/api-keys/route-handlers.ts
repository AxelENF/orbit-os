import { z } from "zod";

import {
  canManageConnections,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

export type ApiKeyRouteContext = { params: Promise<{ id: string }> };
export type ApiKeyRevokeRouteContext = {
  params: Promise<{ id: string; keyId?: string }>;
};
export type ApiKeyClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

type ApiKeySession = { userId: string };
type ApiKeyMembership = { role: string };

export type ApiKeyHandlerDependencies = {
  getSession: () => Promise<ApiKeySession | null>;
  getMembership: (input: {
    organizationId: string;
    userId: string;
  }) => Promise<ApiKeyMembership | null>;
  getClient: () => Promise<ApiKeyClient>;
};

const organizationIdSchema = z.string().uuid();
const createApiKeyInputSchema = z.object({
  label: z.string().trim().min(1),
});

const noStoreHeaders = { "Cache-Control": "no-store" };

export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

async function resolveAuthAndMembership(
  dependencies: ApiKeyHandlerDependencies,
  params: { id: string },
): Promise<
  | { organizationId: string; membership: ApiKeyMembership }
  | Response
> {
  const parsed = organizationIdSchema.safeParse(params.id);
  if (!parsed.success) return jsonError("INVALID_ORGANIZATION_ID", 400);

  const session = await dependencies.getSession();
  if (!session) return jsonError("AUTHENTICATION_REQUIRED", 401);

  let membership: ApiKeyMembership | null;
  try {
    membership = await dependencies.getMembership({
      organizationId: parsed.data,
      userId: session.userId,
    });
  } catch {
    return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
  }
  if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);

  return { organizationId: parsed.data, membership };
}

function isNotOrganizationOwnerError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === "NOT_ORGANIZATION_OWNER"
  );
}

export function createApiKeyCreateHandler(
  dependencies: ApiKeyHandlerDependencies,
): (request: Request, context: ApiKeyRouteContext) => Promise<Response> {
  return async function handleCreate(
    request: Request,
    context: ApiKeyRouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const resolved = await resolveAuthAndMembership(dependencies, params);
    if (resolved instanceof Response) return resolved;
    if (!canManageConnections(resolved.membership.role as OrganizationRole)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    const parsedPayload = createApiKeyInputSchema.safeParse(payload);
    if (!parsedPayload.success) return jsonError("INVALID_REQUEST", 400);

    let result: { data: unknown; error: unknown };
    try {
      const client = await dependencies.getClient();
      result = await client.rpc("create_organization_api_key", {
        p_organization_id: resolved.organizationId,
        p_label: parsedPayload.data.label,
      });
    } catch {
      return jsonError("API_KEY_INTEGRATION_NOT_CONFIGURED", 503);
    }

    if (result.error) {
      return isNotOrganizationOwnerError(result.error)
        ? jsonError("ORGANIZATION_ACCESS_DENIED", 403)
        : jsonError("API_KEY_CREATE_FAILED", 503);
    }
    if (!Array.isArray(result.data) || result.data.length !== 1) {
      return jsonError("API_KEY_CREATE_FAILED", 500);
    }

    const row = result.data[0] as {
      id: string;
      key_prefix: string;
      secret: string;
    };
    return Response.json(
      {
        id: row.id,
        keyPrefix: row.key_prefix,
        secret: row.secret,
      },
      { status: 201, headers: noStoreHeaders },
    );
  };
}

export function createApiKeyListHandler(
  dependencies: ApiKeyHandlerDependencies,
): (request: Request, context: ApiKeyRouteContext) => Promise<Response> {
  return async function handleList(
    _request: Request,
    context: ApiKeyRouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const resolved = await resolveAuthAndMembership(dependencies, params);
    if (resolved instanceof Response) return resolved;
    if (!canManageConnections(resolved.membership.role as OrganizationRole)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    try {
      const client = await dependencies.getClient();
      const { data, error } = await client
        .from("organization_api_keys")
        .select(
          "id, organization_id, label, key_prefix, created_by, created_at, last_used_at, revoked_at",
        )
        .eq("organization_id", resolved.organizationId);
      if (error) return jsonError("API_KEY_LOOKUP_FAILED", 503);
      return Response.json({ keys: data ?? [] }, { headers: noStoreHeaders });
    } catch {
      return jsonError("API_KEY_INTEGRATION_NOT_CONFIGURED", 503);
    }
  };
}

export function createApiKeyRevokeHandler(
  dependencies: ApiKeyHandlerDependencies,
): (
  request: Request,
  context: ApiKeyRevokeRouteContext,
) => Promise<Response> {
  return async function handleRevoke(
    _request: Request,
    context: ApiKeyRevokeRouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const resolved = await resolveAuthAndMembership(dependencies, params);
    if (resolved instanceof Response) return resolved;
    if (!canManageConnections(resolved.membership.role as OrganizationRole)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    if (!params.keyId) return jsonError("INVALID_REQUEST", 400);

    try {
      const client = await dependencies.getClient();
      const { data, error } = await client
        .from("organization_api_keys")
        .select("id")
        .eq("id", params.keyId)
        .eq("organization_id", resolved.organizationId)
        .maybeSingle();
      if (error) return jsonError("API_KEY_LOOKUP_FAILED", 503);
      if (!data) return jsonError("API_KEY_NOT_FOUND", 404);

      const revokeResult = await client.rpc("revoke_organization_api_key", {
        p_key_id: params.keyId,
      });
      if (revokeResult.error) {
        return isNotOrganizationOwnerError(revokeResult.error)
          ? jsonError("ORGANIZATION_ACCESS_DENIED", 403)
          : jsonError("API_KEY_REVOKE_FAILED", 503);
      }
      return new Response(null, {
        status: 204,
        headers: noStoreHeaders,
      });
    } catch {
      return jsonError("API_KEY_INTEGRATION_NOT_CONFIGURED", 503);
    }
  };
}
