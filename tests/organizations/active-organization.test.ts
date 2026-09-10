import { describe, expect, it } from "vitest";

import {
  OrganizationSelectionRequiredError,
  resolveActiveOrganization,
} from "@/lib/organizations/active-organization";

const memberships = [
  { organizationId: "organization-a", userId: "user-a", role: "owner" as const },
  { organizationId: "organization-b", userId: "user-a", role: "editor" as const },
];

describe("active organization resolution", () => {
  it("requires a selection for multiple memberships", () => {
    expect(() => resolveActiveOrganization(memberships)).toThrow(
      OrganizationSelectionRequiredError,
    );
  });

  it("accepts only a selected membership from the authenticated session", () => {
    expect(resolveActiveOrganization(memberships, "organization-b")).toEqual(
      memberships[1],
    );
    expect(() => resolveActiveOrganization(memberships, "organization-c")).toThrow(
      /organization membership/i,
    );
  });
});
