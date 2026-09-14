import { redirect } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import ReviewPage from "@/app/(app)/review/page";

describe("ReviewPage", () => {
  it("redirects to /library?filter=attention", () => {
    ReviewPage();
    expect(redirect).toHaveBeenCalledWith("/library?filter=attention");
  });
});
