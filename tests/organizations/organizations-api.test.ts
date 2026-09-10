import { describe, expect, it } from "vitest";

import {
  createOrganizationsListHandler,
  type OrganizationListItem,
} from "@/app/api/organizations/route";
import { createActiveOrganizationCookieValue } from "@/lib/organizations/active-organization-cookie";

const organizations: OrganizationListItem[] = [
  { id: "organization-a", name: "Clínica Norte", role: "owner" },
  { id: "organization-b", name: "Restaurante Centro", role: "editor" },
];

function handlerFor(overrides: Partial<Parameters<typeof createOrganizationsListHandler>[0]> = {}) {
  return createOrganizationsListHandler({
    getSession: async () => ({ userId: "user-a" }),
    getMemberships: async (userId) => {
      expect(userId).toBe("user-a");
      return organizations;
    },
    getActiveOrganizationCookie: async () => null,
    getSecret: () => "test-secret",
    ...overrides,
  });
}

describe("GET /api/organizations", () => {
  it("returns only authenticated memberships and the signed active organization", async () => {
    const cookie = createActiveOrganizationCookieValue(
      { organizationId: "organization-b", userId: "user-a" },
      "test-secret",
    );
    const response = await handlerFor({
      getActiveOrganizationCookie: async () => cookie,
    })(new Request("http://localhost/api/organizations"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      organizations,
      activeOrganizationId: "organization-b",
    });
  });

  it("does not trust a signed cookie for another user or an inaccessible organization", async () => {
    const cookie = createActiveOrganizationCookieValue(
      { organizationId: "organization-c", userId: "user-b" },
      "test-secret",
    );
    const response = await handlerFor({
      getActiveOrganizationCookie: async () => cookie,
    })(new Request("http://localhost/api/organizations"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizations,
      activeOrganizationId: null,
    });
  });

  it("returns 401 without an authenticated session", async () => {
    const response = await handlerFor({
      getSession: async () => null,
    })(new Request("http://localhost/api/organizations"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "AUTHENTICATION_REQUIRED" });
  });

  it("returns 503 when the membership integration cannot be read", async () => {
    const response = await handlerFor({
      getMemberships: async () => {
        throw new Error("database unavailable");
      },
    })(new Request("http://localhost/api/organizations"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "ORGANIZATION_LOOKUP_FAILED" });
  });
});
