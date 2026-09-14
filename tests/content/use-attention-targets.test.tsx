/** @vitest-environment jsdom */
import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getContentRecord = vi.fn();
const approveContentTarget = vi.fn();
const retryContentTarget = vi.fn();
vi.mock("@/lib/content/client", () => ({
  getContentRecord: (...args: unknown[]) => getContentRecord(...args),
  approveContentTarget: (...args: unknown[]) => approveContentTarget(...args),
  retryContentTarget: (...args: unknown[]) => retryContentTarget(...args),
}));

import { useAttentionTargets } from "@/lib/content/use-attention-targets";

function record(id: string, targets: Array<{ id: string; status: string }> = []) {
  return { content: { id, state: "REVIEW" }, targets, drafts: [], auditEvents: [], publicationResults: [] };
}

const targetA = { id: "target-a", contentItemId: "a", platform: "FACEBOOK" as const, status: "PENDING_REVIEW" as const };

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAttentionTargets", () => {
  it("fetches getContentRecord only for the given ids", async () => {
    getContentRecord.mockImplementation((id: string) => Promise.resolve(record(id)));

    renderHook(() => useAttentionTargets(["a", "b"]));

    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(2));
    expect(getContentRecord).toHaveBeenCalledWith("a");
    expect(getContentRecord).toHaveBeenCalledWith("b");
  });

  it("omits only the id that fails, keeps the rest", async () => {
    getContentRecord.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("boom")) : Promise.resolve(record(id)),
    );

    const { result } = renderHook(() => useAttentionTargets(["a", "b"]));

    await waitFor(() => expect(result.current.records.some((r) => r.content.id === "a")).toBe(true));
    expect(result.current.records.some((r) => r.content.id === "b")).toBe(false);
    expect(result.current.failedIds).toContain("b");
  });

  it("calls onTargetResolved after a successful approve, and refetches that one record", async () => {
    getContentRecord.mockImplementation((id: string) => Promise.resolve(record(id)));
    approveContentTarget.mockResolvedValue({ ...targetA, status: "APPROVED" });
    const onTargetResolved = vi.fn();

    const { result } = renderHook(() => useAttentionTargets(["a"], onTargetResolved));
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    getContentRecord.mockClear();

    await act(async () => {
      await result.current.handleApprove("a", targetA);
    });

    expect(approveContentTarget).toHaveBeenCalledWith("a", targetA);
    expect(getContentRecord).toHaveBeenCalledWith("a");
    expect(onTargetResolved).toHaveBeenCalledTimes(1);
  });

  it("does not call onTargetResolved when approve rejects", async () => {
    getContentRecord.mockImplementation((id: string) => Promise.resolve(record(id)));
    approveContentTarget.mockRejectedValue(new Error("boom"));
    const onTargetResolved = vi.fn();

    const { result } = renderHook(() => useAttentionTargets(["a"], onTargetResolved));
    await waitFor(() => expect(result.current.records).toHaveLength(1));

    await expect(act(async () => {
      await result.current.handleApprove("a", targetA);
    })).rejects.toThrow();

    expect(onTargetResolved).not.toHaveBeenCalled();
  });

  it("calls onTargetResolved after a successful retry", async () => {
    getContentRecord.mockImplementation((id: string) => Promise.resolve(record(id)));
    retryContentTarget.mockResolvedValue({ ...targetA, status: "APPROVED" });
    const onTargetResolved = vi.fn();

    const { result } = renderHook(() => useAttentionTargets(["a"], onTargetResolved));
    await waitFor(() => expect(result.current.records).toHaveLength(1));

    await act(async () => {
      await result.current.handleRetry("a", targetA.id);
    });

    expect(retryContentTarget).toHaveBeenCalledWith("a", targetA.id);
    expect(onTargetResolved).toHaveBeenCalledTimes(1);
  });
});
