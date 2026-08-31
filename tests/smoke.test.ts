import { describe, expect, it } from "vitest";

import { APP_NAME } from "@/lib/content/constants";

describe("content constants", () => {
  it("exports the SnapGad Content OS app name", () => {
    expect(APP_NAME).toBe("SnapGad Content OS");
  });
});
