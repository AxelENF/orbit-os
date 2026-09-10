import type { OrganizationRole } from "@/lib/organizations/permissions";

export type OrganizationSession = {
  userId: string;
};

export type OrganizationMembership = {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
};

export type OrganizationContext = OrganizationMembership;

export type OrganizationContextDependencies = {
  getSession: () => Promise<OrganizationSession | null>;
  getMembership: (input: {
    organizationId: string;
    userId: string;
  }) => Promise<OrganizationMembership | null>;
};

export class OrganizationAccessError extends Error {
  constructor() {
    super("An organization membership is required.");
    this.name = "OrganizationAccessError";
  }
}

/**
 * Resolves organization access from the authenticated session, never from a
 * caller-supplied user identity. Runtime auth/database wiring is intentionally
 * provided by the caller once the tenancy adapter is introduced.
 */
export async function requireOrganizationContext(
  organizationId: string,
  dependencies: OrganizationContextDependencies,
): Promise<OrganizationContext> {
  const session = await dependencies.getSession();
  if (!session) throw new OrganizationAccessError();

  const membership = await dependencies.getMembership({
    organizationId,
    userId: session.userId,
  });
  if (
    !membership ||
    membership.organizationId !== organizationId ||
    membership.userId !== session.userId
  ) {
    throw new OrganizationAccessError();
  }

  return membership;
}
