import { describe, expect, it } from "vitest";

import {
  createActiveOrganizationCookieValue,
  verifyActiveOrganizationCookieValue,
} from "@/lib/organizations/active-organization-cookie";

describe("active organization cookie", () => {
  it("binds the selected organization to the authenticated user", () => {
    const value = createActiveOrganizationCookieValue(
      { organizationId: "organization-a", userId: "user-a" },
      "test-secret",
    );

    expect(verifyActiveOrganizationCookieValue(value, "user-a", "test-secret")).toBe(
      "organization-a",
    );
    expect(verifyActiveOrganizationCookieValue(value, "user-b", "test-secret")).toBeNull();
  });

  it("rejects tampered and expired values", () => {
    const value = createActiveOrganizationCookieValue(
      { organizationId: "organization-a", userId: "user-a", expiresAt: 1 },
      "test-secret",
    );

    expect(verifyActiveOrganizationCookieValue(`${value}tampered`, "user-a", "test-secret")).toBeNull();
    expect(verifyActiveOrganizationCookieValue(value, "user-a", "test-secret")).toBeNull();
  });
});
