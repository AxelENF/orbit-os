import { z } from "zod";

import {
  canManageConnections,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

const inputSchema = z.object({ organizationId: z.string().uuid() });
const noStoreHeaders = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

export async function POST(request: Request): Promise<Response> {
  const input = inputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return jsonError("INVALID_ORGANIZATION_ID", 400);

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
    .eq("organization_id", input.data.organizationId)
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

  const { data, error } = await serviceRole.rpc("revoke_meta_connection", {
    p_organization_id: input.data.organizationId,
  });
  if (error) return jsonError("META_DISCONNECT_FAILED", 503);

  return Response.json(data ?? { revoked: false }, { headers: noStoreHeaders });
}
