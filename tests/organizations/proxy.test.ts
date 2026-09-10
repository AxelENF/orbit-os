import { describe, expect, it } from "vitest";

import { config } from "@/proxy";

describe("protected organization pages", () => {
  it("keeps onboarding and organization settings inside the auth matcher", () => {
    expect(config.matcher).toEqual(
      expect.arrayContaining([
        "/onboarding",
        "/onboarding/:path*",
        "/settings",
        "/settings/:path*",
      ]),
    );
  });
});
