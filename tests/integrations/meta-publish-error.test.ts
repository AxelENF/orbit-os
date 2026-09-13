import { describe, expect, it } from "vitest";

import { MetaPublishError } from "@/lib/integrations/meta-publish-error";

describe("MetaPublishError", () => {
  it("carries retryable and requiresReconnect classifications", () => {
    const error = new MetaPublishError("Meta rejected the publish request.", true, true);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MetaPublishError");
    expect(error.message).toBe("Meta rejected the publish request.");
    expect(error.retryable).toBe(true);
    expect(error.requiresReconnect).toBe(true);
  });

  it("defaults requiresReconnect to false", () => {
    const error = new MetaPublishError("The post was rejected by policy.", false);

    expect(error.retryable).toBe(false);
    expect(error.requiresReconnect).toBe(false);
  });
});
