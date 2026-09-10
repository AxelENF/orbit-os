import { describe, expect, it } from "vitest";

import { createActiveOrganizationHandler } from "@/lib/organizations/active-organization-handler";

const memberships = [
  { organizationId: "organization-a", userId: "user-a", role: "owner" as const },
  { organizationId: "organization-b", userId: "user-a", role: "editor" as const },
];

function request(organizationId: unknown): Request {
  return new Request("http://localhost/api/organizations/active", {
    method: "POST",
    body: JSON.stringify({ organizationId }),
    headers: { "content-type": "application/json" },
  });
}

describe("active organization handler", () => {
  it("sets a signed cookie after validating the selected membership", async () => {
    let cookieValue: string | null = null;
    const handler = createActiveOrganizationHandler({
      getSession: async () => ({ userId: "user-a" }),
      getMemberships: async () => memberships,
      getSecret: () => "test-secret",
      setCookie: (value) => {
        cookieValue = value;
      },
      now: () => 1_000,
    });

    const response = await handler(request("organization-b"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizationId: "organization-b" });
    expect(cookieValue).toMatch(/\./);
  });

  it("rejects a selection outside the authenticated memberships", async () => {
    let cookieWasSet = false;
    const handler = createActiveOrganizationHandler({
      getSession: async () => ({ userId: "user-a" }),
      getMemberships: async () => memberships,
      getSecret: () => "test-secret",
      setCookie: () => {
        cookieWasSet = true;
      },
    });

    const response = await handler(request("organization-c"));

    expect(response.status).toBe(403);
    expect(cookieWasSet).toBe(false);
  });
});
