/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiasProfileForm } from "@/components/aias/profile-form";

const organizationId = "11111111-1111-4111-8111-111111111111";

const savedProfile = {
  businessName: "Clínica Norte",
  industry: "Salud",
  subIndustry: "Clínica dental",
  locations: ["Puebla"],
  offerings: ["Consulta inicial"],
  idealCustomer: "Personas que necesitan una cita",
  painPoints: ["Pierden solicitudes fuera de horario"],
  proofPoints: ["El equipo responde y agenda solicitudes"],
  tone: "Claro y profesional",
  forbiddenClaims: ["Resultados garantizados"],
  defaultCta: "Escribe para agendar",
  timezone: "America/Mexico_City",
  workflowPreferences: {
    enabledWorkflows: ["copy_generation"],
    approvalRequired: true,
    defaultPlatforms: ["facebook"],
    publishingWindows: [],
  },
};

describe("AiasProfileForm", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("explains the local demo boundary without attempting a network write", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<AiasProfileForm organizationId={organizationId} enabled={false} />);

    expect(screen.getByText(/formulario está listo/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads an empty profile and saves the organization context with a versioned response", async () => {
    const fetchMock = vi.fn().mockImplementation((_input: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            profile: {
              organizationId,
              version: 1,
              profile: savedProfile,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AiasProfileForm organizationId={organizationId} enabled />);

    await waitFor(() => expect(screen.getByLabelText("Nombre del negocio")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Nombre del negocio"), { target: { value: "Clínica Norte" } });
    fireEvent.change(screen.getByLabelText("Rubro principal"), { target: { value: "Salud" } });
    fireEvent.change(screen.getByLabelText("Servicios u ofertas"), { target: { value: "Consulta inicial" } });
    fireEvent.change(screen.getByLabelText("Cliente ideal"), {
      target: { value: "Personas que necesitan una cita" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Perfil AIAS guardado/i));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const saveCall = fetchMock.mock.calls[1];
    expect(saveCall?.[1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      metadata: { source: "aias-onboarding" },
      profile: {
        businessName: "Clínica Norte",
        offerings: ["Consulta inicial"],
      },
    });
  });
});
