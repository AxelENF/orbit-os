export const ORGANIZATION_ROLES = ["owner", "editor", "reviewer", "viewer"] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export function canEditCampaign(role: OrganizationRole): boolean {
  return role === "owner" || role === "editor";
}

export function canApproveCampaign(role: OrganizationRole): boolean {
  return role === "owner" || role === "reviewer";
}

export function canManageConnections(role: OrganizationRole): boolean {
  return role === "owner";
}
