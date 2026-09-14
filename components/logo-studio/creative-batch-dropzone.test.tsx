/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreativeBatchDropzone, MAX_BATCH_SIZE, MAX_FILE_BYTES } from "@/components/logo-studio/creative-batch-dropzone";

afterEach(() => cleanup());

describe("CreativeBatchDropzone", () => {
  it("accepts multiple valid image files", async () => {
    const onFilesChange = vi.fn();
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    await user.upload(input, [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.jpg", { type: "image/jpeg" }),
    ]);
    expect(onFilesChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: "a.png" }), expect.objectContaining({ name: "b.jpg" })]));
  });

  it("rejects a file with an unsupported type", async () => {
    const onFilesChange = vi.fn();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    // Corrección ronda 2 del plan review (mismo hallazgo que Task 7):
    // `applyAccept` va en `userEvent.setup(...)`, no como tercer
    // argumento de `.upload()` — ahí no tiene efecto en
    // @testing-library/user-event@14.6.7.
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["a"], "a.pdf", { type: "application/pdf" }));
    expect(screen.getByText(/tipo de archivo no soportado/i)).toBeInTheDocument();
  });

  it(`rejects a batch larger than MAX_BATCH_SIZE (${MAX_BATCH_SIZE}) with its own distinct message`, async () => {
    const onFilesChange = vi.fn();
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) => new File(["a"], `${index}.png`, { type: "image/png" }));
    await user.upload(input, tooMany);
    // Corrección ronda 1 (bug real): con `maxFiles` configurado,
    // react-dropzone ya mete los archivos sobrantes en `fileRejections`
    // con code "too-many-files" — `acceptedFiles.length` nunca puede
    // superar MAX_BATCH_SIZE por sí solo. El mensaje debe distinguirse del
    // genérico "tipo no soportado" de la prueba anterior.
    expect(screen.getByText(new RegExp(`máximo ${MAX_BATCH_SIZE}`, "i"))).toBeInTheDocument();
    expect(screen.queryByText(/tipo de archivo no soportado/i)).not.toBeInTheDocument();
  });

  it(`rejects an individual file larger than MAX_FILE_BYTES`, async () => {
    const onFilesChange = vi.fn();
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    const bigFile = new File([new Uint8Array(MAX_FILE_BYTES + 1)], "big.png", { type: "image/png" });
    await user.upload(input, bigFile);
    expect(screen.getByText(/demasiado grande/i)).toBeInTheDocument();
  });
});
