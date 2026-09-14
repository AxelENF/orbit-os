export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type CompositeOptions = { corner: Corner; sizePercent: number; marginPercent: number };
export type OutputFormat = "image/png" | "image/jpeg";

export function computeLogoPlacement(
  creativeWidth: number,
  creativeHeight: number,
  logoNaturalWidth: number,
  logoNaturalHeight: number,
  options: CompositeOptions,
): { x: number; y: number; width: number; height: number } {
  if (logoNaturalWidth <= 0 || logoNaturalHeight <= 0) {
    throw new Error("Logo dimensions must be positive.");
  }
  const shortSide = Math.min(creativeWidth, creativeHeight);
  const margin = shortSide * (options.marginPercent / 100);
  const availableWidth = creativeWidth - margin * 2;
  const availableHeight = creativeHeight - margin * 2;

  let width = shortSide * (options.sizePercent / 100);
  let height = width * (logoNaturalHeight / logoNaturalWidth);

  const scale = Math.min(1, availableWidth / width, availableHeight / height);
  width *= scale;
  height *= scale;

  const x = options.corner.includes("left") ? margin : creativeWidth - width - margin;
  const y = options.corner.includes("top") ? margin : creativeHeight - height - margin;
  return { x, y, width, height };
}

export function compositeToBlob(
  creativeImage: HTMLImageElement,
  logoImage: HTMLImageElement,
  options: CompositeOptions,
  outputFormat: OutputFormat,
  jpegQuality = 0.92,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = creativeImage.naturalWidth;
  canvas.height = creativeImage.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to get a 2D canvas context.");

  context.drawImage(creativeImage, 0, 0, canvas.width, canvas.height);
  const placement = computeLogoPlacement(canvas.width, canvas.height, logoImage.naturalWidth, logoImage.naturalHeight, options);
  context.drawImage(logoImage, placement.x, placement.y, placement.width, placement.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error("Canvas export failed.")); return; }
        resolve(blob);
      },
      outputFormat,
      outputFormat === "image/jpeg" ? jpegQuality : undefined,
    );
  });
}
