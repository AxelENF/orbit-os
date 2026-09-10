import { z } from "zod";

import {
  ACTIVE_ORGANIZATION_COOKIE_MAX_AGE_SECONDS,
  createActiveOrganizationCookieValue,
} from "@/lib/organizations/active-organization-cookie";
import { resolveActiveOrganization } from "@/lib/organizations/active-organization";
import {
  OrganizationAccessError,
  type OrganizationContext,
  type OrganizationSession,
} from "@/lib/organizations/context";

const activeOrganizationRequestSchema = z.object({
  organizationId: z.string().trim().min(1).max(200),
});

export type ActiveOrganizationHandlerDependencies = {
  getSession: () => Promise<OrganizationSession | null>;
  getMemberships: (userId: string) => Promise<readonly OrganizationContext[]>;
  getSecret: () => string | undefined;
  setCookie: (value: string, maxAge: number) => void | Promise<void>;
  now?: () => number;
};

export function createActiveOrganizationHandler(
  dependencies: ActiveOrganizationHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async function handleActiveOrganization(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    const parsed = activeOrganizationRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return Response.json({ error: "ORGANIZATION_ID_REQUIRED" }, { status: 400 });
    }

    const session = await dependencies.getSession();
    if (!session) return Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 });

    let organization: OrganizationContext;
    try {
      const memberships = await dependencies.getMemberships(session.userId);
      organization = resolveActiveOrganization(memberships, parsed.data.organizationId);
    } catch (error) {
      if (error instanceof OrganizationAccessError) {
        return Response.json({ error: "ORGANIZATION_ACCESS_DENIED" }, { status: 403 });
      }
      return Response.json({ error: "ORGANIZATION_LOOKUP_FAILED" }, { status: 500 });
    }

    const secret = dependencies.getSecret();
    if (!secret) {
      return Response.json({ error: "ACTIVE_ORGANIZATION_NOT_CONFIGURED" }, { status: 503 });
    }

    const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
    const cookieValue = createActiveOrganizationCookieValue(
      {
        organizationId: organization.organizationId,
        userId: session.userId,
        expiresAt: now() + ACTIVE_ORGANIZATION_COOKIE_MAX_AGE_SECONDS,
      },
      secret,
    );
    await dependencies.setCookie(cookieValue, ACTIVE_ORGANIZATION_COOKIE_MAX_AGE_SECONDS);

    return Response.json({ organizationId: organization.organizationId });
  };
}
