import "server-only";

export const ACCEPTED_ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MIN_ASSET_WIDTH = 540;
export const MIN_ASSET_HEIGHT = 675;
const TARGET_ASPECT_RATIO = 4 / 5;
const ASPECT_TOLERANCE = 0.015;

export type AssetDimensions = {
  width: number;
  height: number;
};

export type ValidatedAsset = AssetDimensions & {
  mimeType: (typeof ACCEPTED_ASSET_MIME_TYPES)[number];
};

export class AssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetValidationError";
  }
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
}

function readBigEndian32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function inspectPng(bytes: Uint8Array): AssetDimensions {
  return {
    width: readBigEndian32(bytes, 16),
    height: readBigEndian32(bytes, 20),
  };
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function inspectJpeg(bytes: Uint8Array): AssetDimensions {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) break;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= bytes.length) break;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += segmentLength;
  }
  throw new AssetValidationError("No se pudieron leer las dimensiones del JPG.");
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 16 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

function readLittleEndian24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function inspectWebp(bytes: Uint8Array): AssetDimensions {
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: readLittleEndian24(bytes, 24) + 1,
      height: readLittleEndian24(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: ((bytes[26]! | (bytes[27]! << 8)) & 0x3fff),
      height: ((bytes[28]! | (bytes[29]! << 8)) & 0x3fff),
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  throw new AssetValidationError("Este WEBP no contiene un encabezado compatible.");
}

export function inspectImageDimensions(bytes: Uint8Array): AssetDimensions {
  if (isPng(bytes)) return inspectPng(bytes);
  if (isJpeg(bytes)) return inspectJpeg(bytes);
  if (isWebp(bytes)) return inspectWebp(bytes);
  throw new AssetValidationError("El archivo no es un PNG, JPG o WEBP válido.");
}

export async function validateAsset(file: File): Promise<ValidatedAsset & { bytes: Uint8Array }> {
  if (file.size <= 0 || file.size > MAX_ASSET_BYTES) {
    throw new AssetValidationError("El creativo debe pesar entre 1 byte y 20 MB.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = inspectImageDimensions(bytes);
  const detectedMimeType = isPng(bytes)
    ? "image/png"
    : isJpeg(bytes)
      ? "image/jpeg"
      : "image/webp";
  if (file.type && file.type !== detectedMimeType) {
    throw new AssetValidationError("El tipo declarado no coincide con el contenido del archivo.");
  }
  if (
    dimensions.width < MIN_ASSET_WIDTH ||
    dimensions.height < MIN_ASSET_HEIGHT ||
    Math.abs(dimensions.width / dimensions.height - TARGET_ASPECT_RATIO) > ASPECT_TOLERANCE
  ) {
    throw new AssetValidationError("El creativo debe ser vertical 4:5 y tener al menos 540 × 675 px.");
  }

  return { ...dimensions, mimeType: detectedMimeType, bytes };
}
