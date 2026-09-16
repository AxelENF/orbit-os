import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createApiKeyRevokeHandler,
  jsonError,
  type ApiKeyHandlerDependencies,
  type ApiKeyRevokeRouteContext,
} from "./route-handlers";
import {
  ORGANIZATION_ROLES,
  type OrganizationRole,
} from "@/lib/organizations/permissions";

async function withDependencies(
  request: Request,
  context: ApiKeyRevokeRouteContext,
): Promise<Response> {
  try {
    const supabase = await createSupabaseServerClient();
    const dependencies: ApiKeyHandlerDependencies = {
      getSession: async () => {
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser();
        return error || !user ? null : { userId: user.id };
      },
      getMembership: async ({ organizationId, userId }) => {
        const { data, error } = await supabase
          .from("organization_members")
          .select("role")
          .eq("organization_id", organizationId)
          .eq("user_id", userId)
          .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        if (
          typeof data.role !== "string" ||
          !ORGANIZATION_ROLES.includes(data.role as OrganizationRole)
        ) {
          throw new Error("Invalid organization role returned by Supabase.");
        }
        return { role: data.role as OrganizationRole };
      },
      getClient: async () => supabase,
    };
    return await createApiKeyRevokeHandler(dependencies)(request, context);
  } catch {
    return jsonError("API_KEY_INTEGRATION_NOT_CONFIGURED", 503);
  }
}

export async function DELETE(
  request: Request,
  context: ApiKeyRevokeRouteContext,
): Promise<Response> {
  return withDependencies(request, context);
}
