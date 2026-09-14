/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logo-studio/export-zip", () => ({
  buildLogoStudioZip: vi.fn().mockResolvedValue(new Blob(["zip"])),
  downloadZip: vi.fn(),
}));
vi.mock("@/lib/logo-studio/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logo-studio/compose")>();
  return { ...actual, compositeToBlob: vi.fn().mockResolvedValue(new Blob(["fake"])) };
});

import LogoStudioPage from "@/app/(app)/tools/logo-studio/page";
import { buildLogoStudioZip } from "@/lib/logo-studio/export-zip";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  naturalWidth = 1080;
  naturalHeight = 1350;
  #src = "";
  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => {
      if (value.includes("corrupt")) this.onerror?.(new Event("error"));
      else this.onload?.();
    });
  }
  get src() { return this.#src; }
}

function organizationsResponse() {
  return new Response(JSON.stringify({
    organizations: [
      { id: "org-1", name: "SnapGad", role: "owner" },
      { id: "org-2", name: "Otra organización", role: "owner" },
    ],
    activeOrganizationId: "org-1",
  }), { status: 200 });
}

function stubObjectUrls(createObjectURL: (file: File) => string) {
  const OriginalURL = URL;
  const TestURL = Object.assign(class extends OriginalURL {}, {
    createObjectURL,
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("URL", TestURL);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LogoStudioPage", () => {
  it("resolves the active organization from GET /api/organizations using response.ok + parseOrganizationsResponse, same as settings/organizations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(organizationsResponse())));
    render(<LogoStudioPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/organizations", expect.anything()));
    expect(await screen.findByText(/SnapGad/i)).toBeInTheDocument();
  });

  it("shows an error instead of crashing when GET /api/organizations responds with a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "AUTHENTICATION_REQUIRED" }), { status: 401 })));
    render(<LogoStudioPage />);
    await waitFor(() => expect(screen.getByText(/no se pudieron cargar tus organizaciones/i)).toBeInTheDocument());
  });

  it("remounts the logo panel (and its stale hasLogo state) when the active organization changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(organizationsResponse())));
    const user = userEvent.setup();
    render(<LogoStudioPage />);
    await screen.findByText(/SnapGad/i);

    const img1 = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
    expect(img1.src).toContain("/api/organizations/org-1/logo");

    // Corrección ronda 2 del plan review (Issue 8 — test efectivamente
    // vacío): asignar `.value` directamente no dispara `onChange` en un
    // <select> controlado de React — `userEvent.selectOptions` sí dispara
    // el evento real que OrganizationSwitcher escucha.
    await user.selectOptions(screen.getByLabelText("Organización activa"), "org-2");

    await waitFor(() => {
      const img2 = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
      expect(img2.src).toContain("/api/organizations/org-2/logo");
      expect(img2.src).not.toContain("org-1");
    });
  });

  it("exports successfully composited creatives even when one fails to load, instead of aborting the whole ZIP (Promise.allSettled, not Promise.all)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(organizationsResponse())));
    vi.stubGlobal("Image", FakeImage);
    // Corrección ronda 2 del plan review (Issue 8 — el mock anterior no
    // podía funcionar): createObjectURL devolvía siempre el mismo string
    // "blob:fake" sin importar el archivo, así que FakeImage nunca podía
    // distinguir cuál era "corrupt". Aquí la URL incluye el nombre del
    // archivo, que es justo lo que FakeImage.src revisa.
    const createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
    stubObjectUrls(createObjectURL);
    const user = userEvent.setup();
    render(<LogoStudioPage />);
    await screen.findByText(/SnapGad/i);

    const goodFile = new File(["a"], "good.png", { type: "image/png" });
    const corruptFile = new File(["b"], "corrupt.png", { type: "image/png" });
    await user.upload(screen.getByLabelText(/cargar creativos/i), [goodFile, corruptFile]);
    await user.click(screen.getByRole("button", { name: /exportar/i }));

    await waitFor(() => expect(buildLogoStudioZip).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ originalFilename: "good.png" })]),
    ));
    expect(buildLogoStudioZip).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ originalFilename: "corrupt.png" })]),
    );
    // Error visible, no silencioso — contradiría el manejo de errores de la spec.
    expect(await screen.findByText(/no se pudo procesar/i)).toHaveTextContent("corrupt.png");
  });

  it("shows a visible error (not a silent rejected promise) when the logo itself fails to load during export", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(organizationsResponse())));
    // Corrección ronda 3 del plan review (Issue 6 seguía roto — el
    // comentario anterior decía "ajusta después" sin ajustar nada):
    // logoImageUrl es una ruta real (`/api/organizations/org-1/logo`),
    // nunca contiene "corrupt", así que el `FakeImage` compartido nunca
    // habría fallado para el logo. Un contador de orden de instancias
    // tampoco sirve aquí: CompositePreview (Task 10) crea sus propias
    // instancias de Image de forma independiente y puede adelantarse a
    // handleExport. La señal confiable es estructural: los creativos
    // siempre cargan desde un `blob:` URL (ver createObjectURL abajo);
    // el logo carga directamente desde la ruta del proxy, nunca un `blob:`
    // URL — se distingue por eso, no por contenido de texto ni orden.
    class LogoFailsFakeImage {
      onload: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      naturalWidth = 1080;
      naturalHeight = 1350;
      #src = "";
      set src(value: string) {
        this.#src = value;
        queueMicrotask(() => {
          if (!value.startsWith("blob:")) this.onerror?.(new Event("error"));
          else this.onload?.();
        });
      }
      get src() { return this.#src; }
    }
    vi.stubGlobal("Image", LogoFailsFakeImage);
    stubObjectUrls(vi.fn((file: File) => `blob:${file.name}`));
    const user = userEvent.setup();
    render(<LogoStudioPage />);
    await screen.findByText(/SnapGad/i);

    await user.upload(screen.getByLabelText(/cargar creativos/i), new File(["a"], "good.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: /exportar/i }));

    // Corrección ronda 2 del plan review (bug real, Issue nuevo): el botón
    // llama `() => void handleExport()` — sin un try/catch de nivel
    // superior en handleExport, un rechazo aquí (falla del logo, o de
    // buildLogoStudioZip) desaparece en silencio, sin ningún mensaje
    // visible. Debe aparecer un error, no un cuelgue silencioso.
    //
    // Corrección ronda 3 (bug real: posibles múltiples role="alert"):
    // CompositePreview también recibe el mismo logoImageUrl y fallará su
    // propia carga de forma independiente, mostrando SU PROPIO alert —
    // correcto, no es un bug, son dos componentes reportando el mismo
    // problema real por separado. Por eso se busca por el TEXTO
    // específico del mensaje de handleExport, no por
    // getByRole("alert") (singular, lanzaría con más de un match).
    expect(await screen.findByText(/no se pudo generar el zip/i)).toBeInTheDocument();
  });
});
