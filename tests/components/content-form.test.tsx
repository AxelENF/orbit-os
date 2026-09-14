/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentForm } from "@/components/content/content-form";
import type { AiasOrganizationProfile } from "@/lib/aias/contracts";
import { clearDemoDrafts, readDemoDrafts } from "@/lib/demo/draft-store";
import { clearDemoAssets } from "@/lib/demo/browser-assets";

const aiasProfile: AiasOrganizationProfile = {
  businessName: "Clínica Aurora",
  industry: "Salud privada",
  subIndustry: "Clínicas dentales",
  locations: ["Puebla"],
  offerings: ["Agenda y atención por WhatsApp"],
  idealCustomer: "Personas que buscan atención dental cerca de casa",
  painPoints: ["Las solicitudes se pierden cuando nadie responde a tiempo"],
  proofPoints: ["El equipo recibe solicitudes por WhatsApp"],
  tone: "Claro y profesional",
  forbiddenClaims: ["Resultados médicos garantizados"],
  defaultCta: "Escribe para agendar",
  timezone: "America/Mexico_City",
  workflowPreferences: {
    enabledWorkflows: ["copy_generation"],
    approvalRequired: true,
    defaultPlatforms: ["facebook"],
    publishingWindows: [],
  },
};

const completeBriefFields = (files = [new File(["png"], "creativo.png", { type: "image/png" })]) => {
  fireEvent.change(screen.getByLabelText("Área del negocio"), {
    target: { value: "Captación y seguimiento" },
  });
  fireEvent.change(screen.getByLabelText("Oferta / servicio"), {
    target: { value: "Automatización de agenda por WhatsApp" },
  });
  fireEvent.change(screen.getByLabelText("Rubro del negocio"), {
    target: { value: "Clínicas dentales" },
  });
  fireEvent.change(screen.getByLabelText("Nombre de campaña"), {
    target: { value: "Agenda clínica septiembre" },
  });
  fireEvent.change(screen.getByLabelText("Oferta concreta"), {
    target: { value: "Automatización de agenda por WhatsApp" },
  });
  fireEvent.change(screen.getByLabelText("URL de destino"), {
    target: { value: "https://wa.me/5215555555555?text=AGENDA" },
  });
  fireEvent.change(screen.getByLabelText("CTA"), {
    target: { value: "Solicita una demo" },
  });
  fireEvent.change(screen.getByLabelText("Descripción humana"), {
    target: { value: "Mostrar cómo el equipo atiende y agenda solicitudes." },
  });
  fireEvent.change(screen.getByLabelText("Hechos permitidos"), {
    target: { value: "El equipo responde y agenda solicitudes." },
  });
  fireEvent.change(screen.getByLabelText("Creativo final de Canva"), {
    target: {
      files,
    },
  });
  return files;
};

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function selectAsset(name = "creativo.png") {
  fireEvent.change(screen.getByLabelText("Creativo final de Canva"), {
    target: {
      files: [new File(["png"], name, { type: "image/png" })],
    },
  });
}

describe("ContentForm", () => {
  afterEach(() => {
    cleanup();
    clearDemoDrafts();
    clearDemoAssets();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps generate disabled until the commercial brief is factual and complete", () => {
    render(<ContentForm onSubmit={vi.fn()} />);

    const submit = screen.getByRole("button", {
      name: "Generar borradores",
    });

    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("CTA"), {
      target: { value: "Solicita una demo" },
    });

    expect(submit).toBeDisabled();
  });

  it("prefills editable commercial suggestions from the saved AIAS profile", async () => {
    render(<ContentForm aiasProfile={aiasProfile} onSubmit={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Área del negocio")).toHaveValue("Salud privada");
    });
    expect(screen.getByLabelText("Oferta / servicio")).toHaveValue("Agenda y atención por WhatsApp");
    expect(screen.getByLabelText("Rubro del negocio")).toHaveValue("Clínicas dentales");
    expect(screen.getByLabelText("CTA")).toHaveValue("Escribe para agendar");
    expect(screen.getByLabelText("Hechos permitidos")).toHaveValue("El equipo recibe solicitudes por WhatsApp");
    expect(screen.getByText("Sugerencias cargadas desde el perfil AIAS. Revísalas antes de generar copy.")).toBeInTheDocument();
  });

  it("submits a complete brief and shows the local next step", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ContentForm onSubmit={onSubmit} />);

    const files = completeBriefFields();

    const submit = screen.getByRole("button", {
      name: "Generar borradores",
    });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      businessLine: "Captación y seguimiento",
      service: "Automatización de agenda por WhatsApp",
      niche: "Clínicas dentales",
      cta: "Solicita una demo",
      humanDescription: "Mostrar cómo el equipo atiende y agenda solicitudes.",
      allowedFacts: ["El equipo responde y agenda solicitudes."],
      campaignName: "Agenda clínica septiembre",
      destination: "whatsapp",
    });
    expect(onSubmit.mock.calls[0]?.[1]).toEqual(files);
    expect(screen.getByText("Borrador guardado en modo local")).toBeInTheDocument();
    expect(
      screen.getByText("Siguiente paso: revisar los borradores antes de publicar."),
    ).toBeInTheDocument();
  });

  it("creates two local draft options after a default demo submission", async () => {
    render(<ContentForm />);

    completeBriefFields();
    fireEvent.click(screen.getByRole("button", { name: "Generar borradores" }));

    await waitFor(() => expect(screen.getByText("Borrador guardado en modo local")).toBeInTheDocument());

    const drafts = readDemoDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.drafts).toHaveLength(2);
    expect(drafts[0]?.visualAnalysis.source).toBe("local-demo");
    expect(drafts[0]?.targets.map((target) => target.platform)).toEqual(["FACEBOOK", "INSTAGRAM"]);

  });

  it("sends every selected asset under the assets FormData field in production mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    // Selecting an asset in production mode also fires the (unrelated) image
    // suggestion request from the "image suggestion provenance" tests below —
    // the mock has to tell that apart from the real submission by URL instead
    // of assuming a single call.
    const fetchMock = vi.fn().mockImplementation(async (input) => {
      if (String(input) === "/api/content/suggestions") {
        return jsonResponse({ suggestions: null });
      }
      return { ok: true, json: async () => ({ content: { id: "content-1" } }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const files = [
      new File(["png-1"], "primero.png", { type: "image/png" }),
      new File(["png-2"], "segundo.png", { type: "image/png" }),
    ];

    render(<ContentForm aiasProfile={aiasProfile} />);
    completeBriefFields(files);
    fireEvent.click(screen.getByRole("button", { name: "Generar borradores" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/content", expect.anything()));
    const submissionCall = fetchMock.mock.calls.find(([url]) => url === "/api/content");
    const request = submissionCall?.[1] as RequestInit;
    const body = request.body as FormData;
    expect(body.getAll("assets")).toEqual(files);
    expect(body.get("asset")).toBeNull();
  });

  describe("image suggestion provenance", () => {
    const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    beforeEach(() => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    });

    afterEach(() => {
      if (previousSupabaseUrl === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
      }
      if (previousSupabaseAnonKey === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousSupabaseAnonKey;
      }
      vi.restoreAllMocks();
    });

    it("las sugerencias de la imagen llenan contentType/objective aunque tengan un valor default no vacío", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          suggestions: {
            contentType: "venta_directa",
            objective: "agenda_demo",
          },
        }),
      );
      render(<ContentForm aiasProfile={aiasProfile} onSubmit={vi.fn()} />);

      selectAsset();

      await waitFor(() => {
        expect(screen.getByLabelText("Tipo de contenido")).toHaveValue("venta_directa");
        expect(screen.getByLabelText("Objetivo")).toHaveValue("agenda_demo");
      });
    });

    it("una edición manual del usuario nunca se sobrescribe por una sugerencia posterior, incluso si el usuario la deja vacía", async () => {
      const suggestionResponse = deferred<Response>();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        expect(String(input)).toBe("/api/content/suggestions");
        return suggestionResponse.promise;
      });
      render(<ContentForm aiasProfile={aiasProfile} onSubmit={vi.fn()} />);

      selectAsset();
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
      fireEvent.change(screen.getByLabelText("Rubro del negocio"), {
        target: { value: "manual" },
      });
      fireEvent.change(screen.getByLabelText("Rubro del negocio"), {
        target: { value: "" },
      });

      suggestionResponse.resolve(
        jsonResponse({ suggestions: { niche: "clinicas" } }),
      );

      await waitFor(() => {
        expect(screen.getByText("✨ Sugerido por tu imagen — revisa antes de continuar.")).toBeInTheDocument();
      });
      expect(screen.getByLabelText("Rubro del negocio")).toHaveValue("");
    });

    it("una edición manual en un <select> también cuenta como editado", async () => {
      const suggestionResponse = deferred<Response>();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        expect(String(input)).toBe("/api/content/suggestions");
        return suggestionResponse.promise;
      });
      render(<ContentForm aiasProfile={aiasProfile} onSubmit={vi.fn()} />);

      selectAsset();
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
      fireEvent.change(screen.getByLabelText("Tipo de contenido"), {
        target: { value: "prueba" },
      });

      suggestionResponse.resolve(
        jsonResponse({ suggestions: { contentType: "venta_directa" } }),
      );

      await waitFor(() => {
        expect(screen.getByText("✨ Sugerido por tu imagen — revisa antes de continuar.")).toBeInTheDocument();
      });
      expect(screen.getByLabelText("Tipo de contenido")).toHaveValue("prueba");
    });

    it("una segunda imagen reemplaza las sugerencias no tocadas de la primera", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({ suggestions: { niche: "clinicas" } }),
      ).mockResolvedValueOnce(
        jsonResponse({ suggestions: { niche: "spas" } }),
      );
      render(<ContentForm aiasProfile={aiasProfile} onSubmit={vi.fn()} />);

      selectAsset("creativo-1.png");
      await waitFor(() => expect(screen.getByLabelText("Rubro del negocio")).toHaveValue("clinicas"));

      selectAsset("creativo-2.png");

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(screen.getByLabelText("Rubro del negocio")).toHaveValue("spas");
      });
    });

    it("applyProfile() (defaults de AIAS) no sobrescribe un campo ya editado por el usuario", async () => {
      const organizationsResponse = deferred<Response>();
      const profileResponse = deferred<Response>();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url === "/api/organizations") return organizationsResponse.promise;
        if (url.startsWith("/api/organizations/")) return profileResponse.promise;
        throw new Error(`Unexpected fetch: ${url}`);
      });
      render(<ContentForm onSubmit={vi.fn()} />);

      fireEvent.change(screen.getByLabelText("Descripción humana"), {
        target: { value: "Descripción escrita por el usuario" },
      });
      fireEvent.change(screen.getByLabelText("Descripción humana"), {
        target: { value: "" },
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      organizationsResponse.resolve(
        jsonResponse({
          organizations: [{ id: "org-1", name: "Org", role: "owner" }],
          activeOrganizationId: "org-1",
        }),
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      profileResponse.resolve(jsonResponse({ profile: { profile: aiasProfile } }));

      await waitFor(() => {
        expect(screen.getByText("Sugerencias cargadas desde el perfil AIAS. Revísalas antes de generar copy.")).toBeInTheDocument();
      });
      expect(screen.getByLabelText("Descripción humana")).toHaveValue("");
    });

    it("un campo sugerido en null no toca el campo existente", async () => {
      const secondSuggestionResponse = deferred<Response>();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (input) => {
        expect(String(input)).toBe("/api/content/suggestions");
        return jsonResponse({ suggestions: { offer: "Automatización de agenda" } });
      }).mockImplementationOnce(async (input) => {
        expect(String(input)).toBe("/api/content/suggestions");
        return secondSuggestionResponse.promise;
      });
      render(<ContentForm aiasProfile={aiasProfile} onSubmit={vi.fn()} />);

      selectAsset("creativo-1.png");
      await waitFor(() => expect(screen.getByLabelText("Oferta concreta")).toHaveValue("Automatización de agenda"));

      selectAsset("creativo-2.png");
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText("Analizando tu creativo…")).toBeInTheDocument());

      secondSuggestionResponse.resolve(jsonResponse({ suggestions: { offer: null } }));

      await waitFor(() => {
        expect(screen.getByText("✨ Sugerido por tu imagen — revisa antes de continuar.")).toBeInTheDocument();
      });
      expect(screen.getByLabelText("Oferta concreta")).toHaveValue("Automatización de agenda");
    });
  });
});
