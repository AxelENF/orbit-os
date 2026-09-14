/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { compositeToBlob, computeLogoPlacement } from "@/lib/logo-studio/compose";

function fakeImage(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  return { naturalWidth, naturalHeight } as unknown as HTMLImageElement;
}

describe("compositeToBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws the creative full-size, then the logo at the exact placement computeLogoPlacement predicts, and resolves with the mocked blob", async () => {
    const drawImageCalls: unknown[][] = [];
    const fakeContext = {
      drawImage: (...args: unknown[]) => { drawImageCalls.push(args); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeContext as unknown as CanvasRenderingContext2D);
    const fakeBlob = new Blob(["fake"], { type: "image/png" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
      callback(fakeBlob);
    });

    const creative = fakeImage(1080, 1350);
    const logo = fakeImage(200, 100);
    const options = { corner: "bottom-right" as const, sizePercent: 15, marginPercent: 4 };
    const result = await compositeToBlob(creative, logo, options, "image/png");
    const expectedPlacement = computeLogoPlacement(1080, 1350, 200, 100, options);

    expect(result).toBe(fakeBlob);
    expect(drawImageCalls).toHaveLength(2); // creativo, luego logo
    // Corrección ronda 1: antes solo se verificaba QUÉ objeto se dibujó,
    // no las coordenadas/tamaño reales — ahora se comparan contra
    // computeLogoPlacement directamente, no un número inventado.
    expect(drawImageCalls[0]).toEqual([creative, 0, 0, 1080, 1350]);
    expect(drawImageCalls[1]).toEqual([logo, expectedPlacement.x, expectedPlacement.y, expectedPlacement.width, expectedPlacement.height]);
  });

  it("passes the given jpegQuality to toBlob for image/jpeg output", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
      callback(new Blob(["fake"], { type: "image/jpeg" }));
    });

    await compositeToBlob(fakeImage(1080, 1350), fakeImage(200, 100), { corner: "top-left", sizePercent: 15, marginPercent: 4 }, "image/jpeg", 0.8);

    expect(toBlobSpy).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.8);
  });

  it("rejects when toBlob yields null (canvas export failure)", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
      callback(null);
    });

    await expect(
      compositeToBlob(fakeImage(1080, 1350), fakeImage(200, 100), { corner: "top-left", sizePercent: 15, marginPercent: 4 }, "image/png"),
    ).rejects.toThrow();
  });
});
