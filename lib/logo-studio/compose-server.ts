import "server-only";
import sharp from "sharp";

import { computeLogoPlacement, type CompositeOptions, type OutputFormat } from "@/lib/logo-studio/compose";
import { MAX_LOGO_BYTES } from "@/app/api/organizations/[id]/logo/route";

export class LogoTooLargeError extends Error {
  constructor() {
    super(`The stored logo exceeds ${MAX_LOGO_BYTES} bytes and cannot be used for server-side compositing.`);
    this.name = "LogoTooLargeError";
  }
}

export async function composeLogoServerSide(input: {
  creativeBytes: Buffer;
  logoBytes: Buffer;
  options: CompositeOptions;
  outputFormat: OutputFormat;
  jpegQuality?: number;
}): Promise<Buffer> {
  if (input.logoBytes.byteLength > MAX_LOGO_BYTES) {
    throw new LogoTooLargeError();
  }

  const creative = sharp(input.creativeBytes);
  const creativeMetadata = await creative.metadata();
  const creativeWidth = creativeMetadata.width ?? 0;
  const creativeHeight = creativeMetadata.height ?? 0;

  const logo = sharp(input.logoBytes);
  const logoMetadata = await logo.metadata();
  const logoWidth = logoMetadata.width ?? 0;
  const logoHeight = logoMetadata.height ?? 0;

  const placement = computeLogoPlacement(creativeWidth, creativeHeight, logoWidth, logoHeight, input.options);

  const resizedLogo = await logo
    .resize(Math.round(placement.width), Math.round(placement.height))
    .toBuffer();

  const composited = creative.composite([
    { input: resizedLogo, left: Math.round(placement.x), top: Math.round(placement.y) },
  ]);

  return input.outputFormat === "image/png"
    ? composited.png().toBuffer()
    : composited.jpeg({ quality: Math.round((input.jpegQuality ?? 0.92) * 100) }).toBuffer();
}
