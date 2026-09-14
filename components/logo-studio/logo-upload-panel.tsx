"use client";

import Image from "next/image";
import { useState, type ChangeEvent } from "react";
import { flushSync } from "react-dom";

export function LogoUploadPanel({
  organizationId,
  onUploadSuccess,
}: {
  organizationId: string;
  // The parent can use this to refresh other UI that displays the same logo.
  onUploadSuccess?: () => void;
}) {
  const [hasLogo, setHasLogo] = useState(true); // optimista; onError lo corrige
  const [cacheBust, setCacheBust] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/png") {
      setError("El logo debe ser un PNG con fondo transparente.");
      return;
    }
    setError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.set("logo", file);
      const response = await fetch(`/api/organizations/${organizationId}/logo`, { method: "POST", body: formData });
      if (!response.ok) throw new Error("UPLOAD_FAILED");
      setHasLogo(true);
      setCacheBust(Date.now());
      onUploadSuccess?.();
    } catch {
      setError("No se pudo subir el logo. Inténtalo de nuevo.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-slate-700/80 bg-[#0a1020] p-5 shadow-[0_18px_50px_rgba(2,8,23,0.2)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-100">Logo de la organización</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Usa un PNG con fondo transparente para mantener el logo nítido en cada creativo.
          </p>
        </div>
        <span className="shrink-0 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-500">
          PNG
        </span>
      </div>

      {hasLogo ? (
        <div className="relative flex min-h-44 items-center justify-center rounded-2xl border border-slate-700 bg-[#101b34] p-6">
          <Image
            fill
            unoptimized
            sizes="(min-width: 640px) 50vw, 100vw"
            className="max-h-32 max-w-full object-contain"
            src={`/api/organizations/${organizationId}/logo${cacheBust ? `?t=${cacheBust}` : ""}`}
            alt="Logo de la organización"
            onError={() => flushSync(() => setHasLogo(false))}
          />
        </div>
      ) : (
        <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-600 bg-[#0c1427] px-6 py-8 text-center">
          <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-orange-300/10 text-2xl text-orange-200 ring-1 ring-orange-200/30">
            ↑
          </span>
          <p className="text-sm font-semibold text-white">Todavía no subiste un logo.</p>
          <p className="mt-1 text-xs text-slate-400">Elige un PNG para usarlo en el Batch Studio.</p>
        </div>
      )}

      <label
        className="group flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-dashed border-slate-600 bg-[#0c1427] px-4 py-3 transition-colors hover:border-cyan-300/70 hover:bg-[#101b34] focus-within:ring-2 focus-within:ring-orange-300/80 focus-within:ring-offset-2 focus-within:ring-offset-[#0a1020]"
        htmlFor="logo-upload-input"
      >
        <input
          id="logo-upload-input"
          className="sr-only"
          type="file"
          accept="image/png"
          aria-label="Subir logo"
          onChange={handleFileChange}
          disabled={isUploading}
        />
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-orange-300/10 text-xl text-orange-200 ring-1 ring-orange-200/30">
            ↑
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-white">
              {isUploading ? "Subiendo logo…" : hasLogo ? "Reemplazar logo" : "Subir logo"}
            </span>
            <span className="mt-1 block text-xs text-slate-400">PNG · fondo transparente</span>
          </span>
        </span>
        <span className="shrink-0 text-xs font-semibold text-orange-200 group-hover:text-orange-100">
          {isUploading ? "Procesando" : "Elegir archivo"}
        </span>
      </label>

      {error ? (
        <p className="text-sm text-orange-200" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
