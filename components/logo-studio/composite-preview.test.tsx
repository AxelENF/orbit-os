/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logo-studio/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logo-studio/compose")>();
  return { ...actual, compositeToBlob: vi.fn().mockResolvedValue(new Blob(["fake"], { type: "image/png" })) };
});

import { CompositePreview } from "@/components/logo-studio/composite-preview";
import { compositeToBlob } from "@/lib/logo-studio/compose";

// jsdom no dispara onload/onerror al asignar Image.src — se sustituye el
// constructor global por uno controlable: cualquier src que contenga
// "fail" dispara onerror, el resto dispara onload en el siguiente microtask.
class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  naturalWidth = 1080;
  naturalHeight = 1350;
  #src = "";
  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => {
      if (value.includes("fail")) this.onerror?.(new Event("error"));
      else this.onload?.();
    });
  }
  get src() { return this.#src; }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CompositePreview", () => {
  it("shows a placeholder when there's no creative selected yet", () => {
    render(<CompositePreview creativeFile={null} logoImageUrl="/api/organizations/org-1/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);
    expect(screen.getByText(/carga al menos un creativo/i)).toBeInTheDocument();
  });

  it("renders the composited preview once both images 'load' successfully", async () => {
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue("blob:fake"), revokeObjectURL: vi.fn() });
    const file = new File(["a"], "a.png", { type: "image/png" });

    render(<CompositePreview creativeFile={file} logoImageUrl="/api/organizations/org-1/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);

    expect(screen.getByText(/generando preview/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument());
    expect(compositeToBlob).toHaveBeenCalled();
  });

  it("shows a visible error instead of hanging on 'Generando preview…' forever when the logo image fails to load", async () => {
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue("blob:fake"), revokeObjectURL: vi.fn() });
    const file = new File(["a"], "a.png", { type: "image/png" });

    render(<CompositePreview creativeFile={file} logoImageUrl="/api/organizations/org-1/logo-fail" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText(/generando preview/i)).not.toBeInTheDocument();
  });

  it("revokes the previous preview's object URL when a new creative replaces it, and on unmount", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue("blob:fake"), revokeObjectURL });
    const fileA = new File(["a"], "a.png", { type: "image/png" });
    const fileB = new File(["b"], "b.png", { type: "image/png" });

    const { rerender, unmount } = render(<CompositePreview creativeFile={fileA} logoImageUrl="/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);
    await waitFor(() => expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument());

    rerender(<CompositePreview creativeFile={fileB} logoImageUrl="/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);
    await waitFor(() => expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument());

    // Corrección ronda 2 del plan review (Issue 7 — test no hermético):
    // para el reemplazo de fileA por fileB ya ocurrieron 2 revocaciones
    // (la URL intermedia del creativo de fileA, y la del preview
    // compuesto anterior) — comprobar `>= 2` DESPUÉS de desmontar no
    // probaba que el cleanup de unmount específicamente corriera, porque
    // ya se cumplía antes de llamar unmount(). Se captura el conteo justo
    // antes de desmontar y se exige que aumente en exactamente 1 —
    // la única revocación que puede venir del cleanup de unmount.
    const callsBeforeUnmount = revokeObjectURL.mock.calls.length;
    unmount();
    expect(revokeObjectURL.mock.calls.length).toBe(callsBeforeUnmount + 1);
  });
});
