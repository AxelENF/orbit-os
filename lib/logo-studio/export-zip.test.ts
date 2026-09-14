/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { buildLogoStudioZip, resolveOutputFilename } from "@/lib/logo-studio/export-zip";

describe("resolveOutputFilename", () => {
  it("derives the extension from outputFormat, not the original filename", () => {
    expect(resolveOutputFilename("foto.webp", "image/jpeg")).toBe("foto.jpg");
    expect(resolveOutputFilename("foto.png", "image/png")).toBe("foto.png");
    expect(resolveOutputFilename("foto.jpeg", "image/jpeg")).toBe("foto.jpg");
  });

  it("sanitizes the filename the same way lib/supabase/repository.ts:556-559 does (hallazgo ronda 1)", () => {
    expect(resolveOutputFilename("mi foto (final)!.webp", "image/jpeg")).toBe("mi_foto__final__.jpg");
  });
});

describe("buildLogoStudioZip", () => {
  it("deduplicates names that only collide AFTER extension conversion", async () => {
    const entries = [
      { originalFilename: "foto.webp", outputFormat: "image/jpeg" as const, blob: new Blob(["a"]) },
      { originalFilename: "foto.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["b"]) },
    ];
    const zipBlob = await buildLogoStudioZip(entries);
    const zip = await JSZip.loadAsync(zipBlob);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["foto-2.jpg", "foto.jpg"]);
  });

  it("never assigns the same final name twice, even when a generated suffix collides with an existing input name (hallazgo ronda 1 — bug real de dedupe)", async () => {
    // foto.jpg, foto-2.jpg (ya viene con ese nombre), y otro foto.jpg —
    // el tercero no puede resolver a "foto-2.jpg", ya está tomado por el
    // segundo; debe seguir a "foto-3.jpg".
    const entries = [
      { originalFilename: "foto.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["a"]) },
      { originalFilename: "foto-2.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["b"]) },
      { originalFilename: "foto.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["c"]) },
    ];
    const zipBlob = await buildLogoStudioZip(entries);
    const zip = await JSZip.loadAsync(zipBlob);
    expect(Object.keys(zip.files).sort()).toEqual(["foto-2.jpg", "foto-3.jpg", "foto.jpg"]);
  });

  it("packages N blobs into a zip with exactly N entries", async () => {
    const entries = [
      { originalFilename: "a.png", outputFormat: "image/png" as const, blob: new Blob(["a"]) },
      { originalFilename: "b.png", outputFormat: "image/png" as const, blob: new Blob(["b"]) },
      { originalFilename: "c.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["c"]) },
    ];
    const zipBlob = await buildLogoStudioZip(entries);
    const zip = await JSZip.loadAsync(zipBlob);
    expect(Object.keys(zip.files)).toHaveLength(3);
  });
});
