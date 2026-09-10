import { describe, expect, it } from "vitest";

import { createMetaPublisher } from "@/lib/integrations/meta-publisher";

describe("Meta publisher preflight", () => {
  it("fails closed without constructing a Meta client when credentials are absent", async () => {
    await expect(createMetaPublisher({}).preflight()).resolves.toEqual({
      status: "NOT_CONFIGURED",
      missing: ["META_APP_ID", "META_APP_SECRET", "META_PAGE_ID", "META_PAGE_ACCESS_TOKEN"],
    });
  });

  it("reports ready only when all server-side variables are present", async () => {
    await expect(
      createMetaPublisher({
        META_APP_ID: "app-id",
        META_APP_SECRET: "app-secret",
        META_PAGE_ID: "page-id",
        META_PAGE_ACCESS_TOKEN: "page-token",
      }).preflight(),
    ).resolves.toEqual({ status: "READY" });
  });
});
