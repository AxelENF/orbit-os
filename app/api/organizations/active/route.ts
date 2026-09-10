import { cookies } from "next/headers";

import { createActiveOrganizationHandler } from "@/lib/organizations/active-organization-handler";
import {
  ACTIVE_ORGANIZATION_COOKIE,
} from "@/lib/organizations/active-organization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { OrganizationRole } from "@/lib/organizations/permissions";

export async function POST(request: Request): Promise<Response> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: sessionError,
    } = await supabase.auth.getUser();

    const handler = createActiveOrganizationHandler({
      getSession: async () => (sessionError || !user ? null : { userId: user.id }),
      getMemberships: async (userId) => {
        const { data, error } = await supabase
          .from("organization_members")
          .select("organization_id, user_id, role")
          .eq("user_id", userId);
        if (error) throw error;
        return (data ?? []).map((membership) => ({
          organizationId: membership.organization_id,
          userId: membership.user_id,
          role: membership.role as OrganizationRole,
        }));
      },
      getSecret: () => process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET,
      setCookie: async (value, maxAge) => {
        const cookieStore = await cookies();
        cookieStore.set(ACTIVE_ORGANIZATION_COOKIE, value, {
          httpOnly: true,
          maxAge,
          path: "/",
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        });
      },
    });

    return handler(request);
  } catch {
    return Response.json({ error: "ORGANIZATION_INTEGRATION_NOT_CONFIGURED" }, { status: 503 });
  }
}
