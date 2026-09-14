/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LogoUploadPanel } from "@/components/logo-studio/logo-upload-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LogoUploadPanel", () => {
  it("shows an empty state when the logo image fails to load (404)", () => {
    render(<LogoUploadPanel organizationId="org-1" />);
    const img = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    expect(screen.getByText(/todavía no subiste un logo/i)).toBeInTheDocument();
  });

  it("rejects a non-PNG file client-side without calling the API", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<LogoUploadPanel organizationId="org-1" />);
    const input = screen.getByLabelText(/subir logo/i) as HTMLInputElement;
    const jpegFile = new File(["fake"], "logo.jpg", { type: "image/jpeg" });
    // Corrección ronda 2 del plan review (Issue 5 seguía roto): en
    // @testing-library/user-event@14.6.7, `applyAccept` NO es una opción
    // del método de instancia `.upload(element, file, options)` — es una
    // opción de `userEvent.setup({ applyAccept: false })`. Pasarla como
    // tercer argumento de `.upload()` no tiene efecto y el archivo se
    // sigue filtrando por el atributo `accept="image/png"` del input
    // antes de disparar el evento cambio.
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, jpegFile);
    expect(screen.getByText(/debe ser un png/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads a PNG and refreshes the image with a cache-busting param on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })));
    const user = userEvent.setup();
    render(<LogoUploadPanel organizationId="org-1" />);
    const input = screen.getByLabelText(/subir logo/i);
    const pngFile = new File(["fake"], "logo.png", { type: "image/png" });
    await user.upload(input, pngFile);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/organizations/org-1/logo", expect.objectContaining({ method: "POST" })));
    const img = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
    expect(img.src).toMatch(/\/api\/organizations\/org-1\/logo\?t=\d+/);
  });

  it("calls onUploadSuccess after a successful upload, so a parent page can refresh anything else that shows the logo (hallazgo ronda 1 del plan review — ver Task 11)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })));
    const onUploadSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LogoUploadPanel organizationId="org-1" onUploadSuccess={onUploadSuccess} />);
    const input = screen.getByLabelText(/subir logo/i);
    await user.upload(input, new File(["fake"], "logo.png", { type: "image/png" }));

    await waitFor(() => expect(onUploadSuccess).toHaveBeenCalledTimes(1));
  });
});
