/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentForm } from "@/components/content/content-form";
import { clearDemoDrafts, readDemoDrafts } from "@/lib/demo/draft-store";
import { clearDemoAssets } from "@/lib/demo/browser-assets";

const completeBriefFields = () => {
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
