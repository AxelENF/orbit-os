/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getContentRecord, submitFinalCopy } = vi.hoisted(() => ({
  getContentRecord: vi.fn(),
  submitFinalCopy: vi.fn(),
}));

vi.mock("@/lib/content/client", () => ({
  approveContentTarget: vi.fn(),
  getContentRecord,
  submitFinalCopy,
}));

vi.mock("@/lib/supabase/client", () => ({
  hasSupabaseBrowserConfig: () => true,
}));

import { DraftEditor, toEditableFinalCopy } from "@/components/content/draft-editor";
import type { ContentRecord } from "@/lib/content/repository";

function recordWithFinalCopy(id: string, body: string, state: "DRAFT" | "REVIEW" = "DRAFT"): ContentRecord {
  return {
    content: {
      id,
      state,
      createdAt: "2026-09-07T00:00:00.000Z",
      businessLine: "AUTOMATIZAR",
      service: "bot_whatsapp",
      niche: "clinicas",
      contentType: "venta_directa",
      objective: "agenda_demo",
      format: "feed_4_5",
      cta: "Agenda una demo",
      humanDescription: "Muestra una cita confirmada.",
      allowedFacts: ["El bot ayuda a agendar citas."],
    },
    targets: [],
    drafts: [],
    auditEvents: [],
    finalCopy: {
      id: `final-${id}`,
      contentItemId: id,
      selectedCopyDraftId: `draft-${id}`,
      headline: `Titular ${id}`,
      body,
      cta: "Agenda una demo",
      checksum: "checksum",
      version: 1,
      createdAt: "2026-09-07T00:00:00.000Z",
    },
  };
}

function recordWithEditableDraft(id: string): ContentRecord {
  const record = recordWithFinalCopy(id, "Copy aún editable");
  delete record.finalCopy;
  record.drafts = [{
    id: `draft-${id}`,
    contentItemId: id,
    headline: `Titular ${id}`,
    body: "El bot puede atender, calificar y agendar citas.",
    cta: "Agenda una demo",
    visualAnalysis: {},
    createdAt: "2026-09-07T00:00:00.000Z",
  }];
  return record;
}

describe("toEditableFinalCopy", () => {
  it("derives the visible copy from the record loaded most recently", () => {
    const firstRecord = recordWithFinalCopy("first", "Copy del primer registro");
    const secondRecord = recordWithFinalCopy("second", "Copy del segundo registro");

    const firstVisibleCopy = toEditableFinalCopy(firstRecord);
    const secondVisibleCopy = toEditableFinalCopy(secondRecord);

    expect(firstVisibleCopy).toMatchObject({
      selectedCopyDraftId: "draft-first",
      body: "Copy del primer registro",
    });
    expect(secondVisibleCopy).toMatchObject({
      selectedCopyDraftId: "draft-second",
      body: "Copy del segundo registro",
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("DraftEditor production loading", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the copy from the current route when an older load resolves late", async () => {
    const firstLoad = deferred<ContentRecord>();
    const secondLoad = deferred<ContentRecord>();
    getContentRecord.mockImplementation((id: string) => (
      id === "first" ? firstLoad.promise : secondLoad.promise
    ));

    const view = render(DraftEditor({ draftId: "first" }));
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledWith("first"));

    view.rerender(DraftEditor({ draftId: "second" }));
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledWith("second"));

    await act(async () => {
      secondLoad.resolve(recordWithFinalCopy("second", "Copy del segundo registro"));
      await secondLoad.promise;
    });
    await waitFor(() => expect(screen.getByLabelText("Titular final")).toHaveValue("Titular second"));

    await act(async () => {
      firstLoad.resolve(recordWithFinalCopy("first", "Copy del primer registro"));
      await firstLoad.promise;
    });
    expect(screen.getByLabelText("Titular final")).toHaveValue("Titular second");
  });

  it("shows a retryable load error instead of a missing-record screen", async () => {
    getContentRecord
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(recordWithFinalCopy("unavailable", "Copy después del reintento"));

    render(DraftEditor({ draftId: "unavailable" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar este registro");
    const retry = screen.getByRole("button", { name: "Reintentar carga" });
    expect(retry).toBeEnabled();
    expect(screen.queryByText("No existe un creativo visible para esta sesión.")).not.toBeInTheDocument();

    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByLabelText("Texto final")).toHaveValue("Copy después del reintento"));
  });

  it("hydrates the visible final copy after a successful load", async () => {
    getContentRecord.mockResolvedValueOnce(recordWithFinalCopy("hydrated", "Copy final hidratado"));

    render(DraftEditor({ draftId: "hydrated" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Titular final")).toHaveValue("Titular hydrated");
      expect(screen.getByLabelText("Texto final")).toHaveValue("Copy final hidratado");
    });
  });

  it("refreshes into review when a final-copy response is lost after persistence", async () => {
    const draftRecord = recordWithEditableDraft("persisted");
    const reviewedRecord = recordWithFinalCopy("persisted", "El bot puede atender, calificar y agendar citas.", "REVIEW");
    getContentRecord.mockResolvedValueOnce(draftRecord).mockResolvedValueOnce(reviewedRecord);
    submitFinalCopy.mockRejectedValueOnce(new Error("response lost"));

    render(DraftEditor({ draftId: "persisted" }));
    expect(await screen.findByRole("button", { name: "Enviar copy final a revisión" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Enviar copy final a revisión" }));

    await waitFor(() => expect(screen.getByText(/Versión 1 seleccionada/)).toBeInTheDocument());
    expect(screen.getByLabelText("Texto final")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Se recargó el registro");
  });
});
