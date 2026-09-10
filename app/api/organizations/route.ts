import { cookies } from "next/headers";

import {
  ACTIVE_ORGANIZATION_COOKIE,
} from "@/lib/organizations/active-organization";
import { verifyActiveOrganizationCookieValue } from "@/lib/organizations/active-organization-cookie";
import type { OrganizationRole } from "@/lib/organizations/permissions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};

export type OrganizationListItem = {
  id: string;
  name: string;
  role: OrganizationRole;
};

export type OrganizationListHandlerDependencies = {
  getSession: () => Promise<{ userId: string } | null>;
  getMemberships: (userId: string) => Promise<readonly OrganizationListItem[]>;
  getActiveOrganizationCookie: () => string | null | Promise<string | null>;
  getSecret: () => string | undefined;
  now?: () => number;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

export function createOrganizationsListHandler(
  dependencies: OrganizationListHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async function handleOrganizationsList(request: Request): Promise<Response> {
    void request;
    const session = await dependencies.getSession();
    if (!session) return jsonError("AUTHENTICATION_REQUIRED", 401);

    let organizations: readonly OrganizationListItem[];
    try {
      organizations = await dependencies.getMemberships(session.userId);
    } catch {
      return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
    }

    let cookieValue: string | null;
    try {
      cookieValue = await dependencies.getActiveOrganizationCookie();
    } catch {
      return jsonError("ORGANIZATION_INTEGRATION_NOT_CONFIGURED", 503);
    }

    let activeOrganizationId: string | null = null;
    if (cookieValue) {
      const secret = dependencies.getSecret();
      if (!secret) return jsonError("ACTIVE_ORGANIZATION_NOT_CONFIGURED", 503);

      activeOrganizationId = verifyActiveOrganizationCookieValue(
        cookieValue,
        session.userId,
        secret,
        dependencies.now?.(),
      );
      if (!organizations.some(({ id }) => id === activeOrganizationId)) {
        activeOrganizationId = null;
      }
    }

    return Response.json(
      { organizations, activeOrganizationId },
      { status: 200, headers: noStoreHeaders },
    );
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: sessionError,
    } = await supabase.auth.getUser();

    const handler = createOrganizationsListHandler({
      getSession: async () => (sessionError || !user ? null : { userId: user.id }),
      getMemberships: async (userId) => {
        const { data: membershipRows, error: membershipError } = await supabase
          .from("organization_members")
          .select("organization_id, role")
          .eq("user_id", userId);
        if (membershipError) throw membershipError;

        const memberships = (membershipRows ?? []) as Array<{
          organization_id: string;
          role: OrganizationRole;
        }>;
        if (memberships.length === 0) return [];

        const organizationIds = memberships.map(({ organization_id }) => organization_id);
        const { data: organizationRows, error: organizationError } = await supabase
          .from("organizations")
          .select("id, name")
          .in("id", organizationIds);
        if (organizationError) throw organizationError;

        const names = new Map(
          ((organizationRows ?? []) as Array<{ id: string; name: string }>).map(({ id, name }) => [
            id,
            name,
          ]),
        );

        return memberships.flatMap(({ organization_id, role }) => {
          const name = names.get(organization_id);
          return name ? [{ id: organization_id, name, role }] : [];
        });
      },
      getActiveOrganizationCookie: async () => {
        const cookieStore = await cookies();
        return cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value ?? null;
      },
      getSecret: () => process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET,
    });

    return handler(request);
  } catch {
    return jsonError("ORGANIZATION_INTEGRATION_NOT_CONFIGURED", 503);
  }
}
