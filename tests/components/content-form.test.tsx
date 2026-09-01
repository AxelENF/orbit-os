/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentForm } from "@/components/content/content-form";

const completeBriefFields = () => {
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
  afterEach(() => cleanup());

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
    });
    expect(screen.getByText("Borrador guardado en modo local")).toBeInTheDocument();
    expect(
      screen.getByText("Siguiente paso: revisar los borradores antes de publicar."),
    ).toBeInTheDocument();
  });
});
