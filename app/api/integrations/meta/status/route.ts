import { z } from "zod";

import type { OrganizationRole } from "@/lib/organizations/permissions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const organizationIdSchema = z.string().uuid();
const META_STATUS_ROLES: OrganizationRole[] = ["owner", "editor", "reviewer"];
const noStoreHeaders = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

export async function GET(request: Request): Promise<Response> {
  const organizationId = organizationIdSchema.safeParse(
    new URL(request.url).searchParams.get("organizationId")?.trim(),
  );
  if (!organizationId.success) return jsonError("INVALID_ORGANIZATION_ID", 400);

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
    .eq("organization_id", organizationId.data)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
  if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);
  if (!META_STATUS_ROLES.includes(membership.role as OrganizationRole)) {
    return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
  }

  const { data, error } = await supabase.rpc("get_meta_connection_status", {
    p_organization_id: organizationId.data,
  });
  if (error) {
    return error.message === "ORGANIZATION_ACTOR_FORBIDDEN"
      ? jsonError("ORGANIZATION_ACCESS_DENIED", 403)
      : jsonError("META_STATUS_LOOKUP_FAILED", 503);
  }

  return Response.json(data ?? { status: "NOT_CONNECTED" }, { headers: noStoreHeaders });
}
