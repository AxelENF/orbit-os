/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const completeBriefFields = () => {
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
      files: [new File(["png"], "creativo.png", { type: "image/png" })],
    },
  });
};

describe("ContentForm", () => {
  afterEach(() => {
    cleanup();
    clearDemoDrafts();
    clearDemoAssets();
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

    completeBriefFields();

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
});
