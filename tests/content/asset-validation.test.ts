import { describe, expect, it } from "vitest";

import { inspectImageDimensions, validateAsset } from "@/lib/content/asset-validation";

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

describe("server asset validation", () => {
  it("reads PNG dimensions and accepts the 4:5 minimum", async () => {
    const bytes = pngBytes(1080, 1350);
    expect(inspectImageDimensions(bytes)).toEqual({ width: 1080, height: 1350 });
    await expect(
      validateAsset(new File([blobPart(bytes)], "creative.png", { type: "image/png" })),
    ).resolves.toMatchObject({
      mimeType: "image/png",
      width: 1080,
      height: 1350,
    });
  });

  it("rejects spoofed MIME and non-4:5 dimensions", async () => {
    await expect(
      validateAsset(new File([blobPart(pngBytes(1080, 1350))], "creative.jpg", { type: "image/jpeg" })),
    ).rejects.toThrow("tipo declarado");
    await expect(
      validateAsset(new File([blobPart(pngBytes(1200, 1200))], "square.png", { type: "image/png" })),
    ).rejects.toThrow("4:5");
  });

  it("rejects files without a recognizable image signature", async () => {
    await expect(
      validateAsset(new File(["not-an-image"], "creative.png", { type: "image/png" })),
    ).rejects.toThrow("no es un PNG");
  });
});
