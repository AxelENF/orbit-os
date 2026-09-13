import { describe, expect, it } from "vitest";

import { createMetaPublisher } from "@/lib/integrations/meta-publisher";

describe("Meta publisher app preflight", () => {
  it("returns READY when META_APP_ID and META_APP_SECRET are present", async () => {
    await expect(
      createMetaPublisher({
        META_APP_ID: "app-id",
        META_APP_SECRET: "app-secret",
      }).preflightApp(),
    ).resolves.toEqual({ status: "READY" });
  });

  it("lists only missing app variables, regardless of page variables", async () => {
    await expect(
      createMetaPublisher({
        META_PAGE_ID: "page-id",
        META_PAGE_ACCESS_TOKEN: "page-token",
      }).preflightApp(),
    ).resolves.toEqual({
      status: "NOT_CONFIGURED",
      missing: ["META_APP_ID", "META_APP_SECRET"],
    });
  });
});
