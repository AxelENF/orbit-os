import { redirect } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import DraftsPage from "@/app/(app)/drafts/page";

describe("DraftsPage", () => {
  it("redirects to /library", () => {
    DraftsPage();
    expect(redirect).toHaveBeenCalledWith("/library");
  });
});
