import JSZip from "jszip";

import type { OutputFormat } from "@/lib/logo-studio/compose";

export type ZipEntryInput = {
  originalFilename: string;
  outputFormat: OutputFormat;
  blob: Blob;
};

export function resolveOutputFilename(originalFilename: string, outputFormat: OutputFormat): string {
  const extension = outputFormat === "image/png" ? "png" : "jpg";
  // Corrección ronda 1: la spec exige el mismo saneamiento que ya usa
  // lib/supabase/repository.ts:556-559 para nombres de archivo — la
  // versión anterior de este plan no lo aplicaba en absoluto.
  const sanitized = originalFilename
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120) || "creative";
  const withoutExtension = sanitized.replace(/\.[^./\\]+$/, "");
  return `${withoutExtension}.${extension}`;
}

function dedupe(names: string[]): string[] {
  // Corrección ronda 1 (bug real): la versión anterior usaba un contador
  // por nombre ORIGINAL, no verificaba si el nombre GENERADO ya estaba en
  // uso — con ["foto.jpg", "foto-2.jpg", "foto.jpg"], producía dos
  // entradas "foto-2.jpg" (una ya presente en el input, otra generada al
  // desambiguar la tercera). Esta versión rastrea el conjunto de nombres
  // ya asignados y sigue incrementando el sufijo hasta encontrar uno
  // realmente libre.
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const base = dot === -1 ? name : name.slice(0, dot);
    const extension = dot === -1 ? "" : name.slice(dot);
    let suffix = 2;
    let candidate = `${base}-${suffix}${extension}`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}${extension}`;
    }
    used.add(candidate);
    return candidate;
  });
}

export async function buildLogoStudioZip(entries: ZipEntryInput[]): Promise<Blob> {
  const finalNames = dedupe(entries.map((entry) => resolveOutputFilename(entry.originalFilename, entry.outputFormat)));
  const zip = new JSZip();
  entries.forEach((entry, index) => {
    zip.file(finalNames[index], entry.blob);
  });
  return zip.generateAsync({ type: "blob" });
}

export function downloadZip(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
