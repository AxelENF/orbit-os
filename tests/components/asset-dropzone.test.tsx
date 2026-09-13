/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetDropzone } from "@/components/content/asset-dropzone";

function imageFile(name: string, contents = "png"): File {
  return new File([contents], name, { type: "image/png" });
}

function dropFiles(files: File[]) {
  const input = screen.getByLabelText("Creativo final de Canva");
  fireEvent.drop(input.parentElement!, {
    dataTransfer: { files },
  });
}

describe("AssetDropzone", () => {
  afterEach(() => {
    cleanup();
  });

  it("acepta hasta 10 archivos, onChange recibe el arreglo completo en orden de selección", () => {
    const onChange = vi.fn();
    const files = [imageFile("uno.png"), imageFile("dos.png"), imageFile("tres.png")];

    render(<AssetDropzone value={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Creativo final de Canva"), {
      target: { files },
    });

    expect(onChange).toHaveBeenCalledWith(files);
  });

  it("el input file tiene el atributo multiple", () => {
    render(<AssetDropzone value={[]} onChange={vi.fn()} />);

    expect(screen.getByLabelText("Creativo final de Canva")).toHaveAttribute("multiple");
  });

  it("el drop de varios archivos a la vez los agrega todos (hasta el máximo de 10)", () => {
    const onChange = vi.fn();
    const files = [imageFile("uno.png"), imageFile("dos.png"), imageFile("tres.png")];

    render(<AssetDropzone value={[imageFile("existente.png")]} onChange={onChange} />);
    dropFiles(files);

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "existente.png" }),
      ...files,
    ]);
  });

  it("seleccionar más de 10 archivos muestra un error y no llama onChange con más de 10", () => {
    const onChange = vi.fn();
    const files = Array.from({ length: 11 }, (_, index) => imageFile(`archivo-${index}.png`));

    render(<AssetDropzone value={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Creativo final de Canva"), {
      target: { files },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/10 archivos/i);
    expect(onChange).toHaveBeenCalledWith(files.slice(0, 10));
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(10);
  });

  it("permite quitar un archivo individual del arreglo antes de subir", () => {
    const onChange = vi.fn();
    const first = imageFile("uno.png");
    const second = imageFile("dos.png");

    render(<AssetDropzone value={[first, second]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Quitar dos.png" }));

    expect(onChange).toHaveBeenCalledWith([first]);
  });

  it("valida cada archivo con las mismas reglas de tipo/tamaño de hoy, individualmente", () => {
    const onChange = vi.fn();
    const valid = imageFile("valido.png");
    const invalid = new File(["texto"], "notas.txt", { type: "text/plain" });
    const tooLarge = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "grande.png", {
      type: "image/png",
    });

    render(<AssetDropzone value={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Creativo final de Canva"), {
      target: { files: [valid, invalid, tooLarge] },
    });

    expect(onChange).toHaveBeenCalledWith([valid]);
    expect(screen.getByRole("alert")).toHaveTextContent(/PNG, JPG o WEBP/i);
  });
});
