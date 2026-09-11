/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => <img {...(props as Record<string, string>)} alt={props.alt as string} />,
}));
vi.mock("@/lib/supabase/client", () => ({ hasSupabaseBrowserConfig: () => true }));

const listContentItems = vi.fn();
const getContentRecord = vi.fn();
vi.mock("@/lib/content/client", () => ({
  listContentItems: (...args: unknown[]) => listContentItems(...args),
  getContentRecord: (...args: unknown[]) => getContentRecord(...args),
}));

import DraftsPage from "@/app/(app)/drafts/page";

function record(state: "GENERATING" | "DRAFT") {
  return {
    content: { id: "content-1", state, service: "bot_whatsapp", niche: "clinicas", contentType: "venta_directa" },
    drafts: [],
    targets: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DraftsPage polling", () => {
  it("polls every 4s while a record is GENERATING and stops once it becomes DRAFT", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listContentItems.mockResolvedValue([{ id: "content-1" }]);
    getContentRecord
      .mockResolvedValueOnce(record("GENERATING"))
      .mockResolvedValueOnce(record("DRAFT"));

    render(<DraftsPage />);

    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4000);
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(4000);
    expect(getContentRecord).toHaveBeenCalledTimes(2);
  });

  it("does not poll when nothing is GENERATING", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listContentItems.mockResolvedValue([{ id: "content-1" }]);
    getContentRecord.mockResolvedValue(record("DRAFT"));

    render(<DraftsPage />);
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4000);
    expect(getContentRecord).toHaveBeenCalledTimes(1);
  });
});
