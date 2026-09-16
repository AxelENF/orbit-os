/** @vitest-environment node */
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { composeLogoServerSide, LogoTooLargeError } from "@/lib/logo-studio/compose-server";

async function solidPng(width: number, height: number, color: { r: number; g: number; b: number; alpha: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

describe("composeLogoServerSide", () => {
  it("overlays the logo onto the creative at the position computeLogoPlacement would compute", async () => {
    const creative = await solidPng(1080, 1350, { r: 255, g: 0, b: 0, alpha: 1 });
    const logo = await solidPng(200, 100, { r: 0, g: 255, b: 0, alpha: 1 });

    const result = await composeLogoServerSide({
      creativeBytes: creative,
      logoBytes: logo,
      options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
      outputFormat: "image/png",
    });

    const resultImage = sharp(result);
    const metadata = await resultImage.metadata();
    expect(metadata.width).toBe(1080);
    expect(metadata.height).toBe(1350);
    // Esquina inferior derecha debe tener algo de verde (el logo); esquina
    // superior izquierda debe seguir siendo puro rojo (sin logo ahí).
    const bottomRightPixel = await resultImage
      .clone()
      .extract({ left: 1000, top: 1300, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(bottomRightPixel[1]).toBeGreaterThan(100); // canal verde presente
    const topLeftPixel = await resultImage
      .clone()
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(topLeftPixel[0]).toBeGreaterThan(200); // sigue siendo rojo puro
    expect(topLeftPixel[1]).toBeLessThan(50);
  });

  it(`rejects a logo over MAX_LOGO_BYTES even though it was already accepted at upload time (fallback para logos heredados)`, async () => {
    const creative = await solidPng(1080, 1350, { r: 255, g: 0, b: 0, alpha: 1 });
    const oversizedLogo = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(
      composeLogoServerSide({
        creativeBytes: creative,
        logoBytes: oversizedLogo,
        options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
        outputFormat: "image/png",
      }),
    ).rejects.toThrow(LogoTooLargeError);
  });

  it("outputs JPEG when outputFormat is image/jpeg", async () => {
    const creative = await solidPng(1080, 1350, { r: 255, g: 0, b: 0, alpha: 1 });
    const logo = await solidPng(200, 100, { r: 0, g: 255, b: 0, alpha: 1 });
    const result = await composeLogoServerSide({
      creativeBytes: creative, logoBytes: logo,
      options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
      outputFormat: "image/jpeg",
    });
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe("jpeg");
  });
});
