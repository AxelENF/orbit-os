import {
  OrganizationAccessError,
  type OrganizationContext,
} from "@/lib/organizations/context";
import { ORGANIZATION_ROLES } from "@/lib/organizations/permissions";

export const ACTIVE_ORGANIZATION_COOKIE = "snapgad_active_organization";

export class OrganizationSelectionRequiredError extends Error {
  constructor() {
    super("An active organization selection is required.");
    this.name = "OrganizationSelectionRequiredError";
  }
}

/**
 * Resolve the active tenant from memberships already loaded for the session.
 * A requested id is never trusted by itself: it must match one of those rows.
 */
export function resolveActiveOrganization(
  memberships: readonly OrganizationContext[],
  activeOrganizationId?: string | null,
): OrganizationContext {
  if (memberships.length === 0) throw new OrganizationAccessError();

  const selectedId = activeOrganizationId?.trim() || null;
  const membership = selectedId
    ? memberships.find(({ organizationId }) => organizationId === selectedId)
    : memberships.length === 1
      ? memberships[0]
      : undefined;

  if (!membership) {
    if (selectedId) throw new OrganizationAccessError();
    throw new OrganizationSelectionRequiredError();
  }
  if (!ORGANIZATION_ROLES.includes(membership.role)) {
    throw new OrganizationAccessError();
  }

  return membership;
}
