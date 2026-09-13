"use client";

import { useId, useState } from "react";

const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const ACCEPTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;

type AssetDropzoneProps = {
  value: File[];
  onChange: (files: File[]) => void;
  isProductionMode?: boolean;
};

function isAcceptedImage(file: File): boolean {
  const fileName = file.name.toLowerCase();
  return (
    ACCEPTED_MIME_TYPES.includes(
      file.type as (typeof ACCEPTED_MIME_TYPES)[number],
    ) || ACCEPTED_EXTENSIONS.some((extension) => fileName.endsWith(extension))
  );
}

export function AssetDropzone({ value, onChange, isProductionMode = false }: AssetDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  function acceptFiles(fileList: FileList | File[]) {
    const selectedFiles = Array.from(fileList);
    if (!selectedFiles.length) return;

    const validFiles: File[] = [];
    let validationError: string | null = null;

    for (const file of selectedFiles) {
      if (!isAcceptedImage(file)) {
        validationError ??= "Usa un archivo PNG, JPG o WEBP para continuar.";
        continue;
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        validationError ??= "El creativo debe pesar menos de 20 MB.";
        continue;
      }

      validFiles.push(file);
    }

    const availableSlots = Math.max(MAX_FILES - value.length, 0);
    const filesToAdd = validFiles.slice(0, availableSlots);
    const nextFiles = [...value, ...filesToAdd];
    const exceedsMaximum = value.length + validFiles.length > MAX_FILES;

    if (filesToAdd.length) onChange(nextFiles);

    if (validationError) {
      setError(validationError);
    } else if (exceedsMaximum) {
      setError("Puedes seleccionar hasta 10 archivos.");
    } else {
      setError(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label
          className="text-sm font-semibold text-slate-100"
          htmlFor={inputId}
        >
          Creativo final de Canva
          <span className="ml-1 text-orange-300" aria-hidden="true">
            *
          </span>
        </label>
        <span className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-slate-500">
          PNG · JPG · WEBP
        </span>
      </div>

      <label
        className={`group flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-orange-300/80 focus-within:ring-offset-2 focus-within:ring-offset-[#0a1020] ${
          isDragging
            ? "border-orange-300 bg-orange-300/10"
            : "border-slate-600 bg-[#0c1427] hover:border-cyan-300/70 hover:bg-[#101b34]"
        }`}
        htmlFor={inputId}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <input
          aria-label="Creativo final de Canva"
          aria-required="true"
          required
          id={inputId}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          multiple
          onChange={(event) => acceptFiles(event.target.files ?? [])}
        />

        {value.length ? (
          <>
            <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-cyan-300/10 text-cyan-200 ring-1 ring-cyan-200/30">
              {value.length}
            </span>
            <ul className="w-full max-w-md space-y-2 text-left">
              {value.map((file, index) => (
                <li
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2"
                  key={`${file.name}-${file.lastModified}-${index}`}
                >
                  <span className="min-w-0 truncate text-sm font-semibold text-white">
                    {file.name}
                  </span>
                  <button
                    aria-label={`Quitar ${file.name}`}
                    className="shrink-0 text-xs font-semibold text-orange-200 hover:text-orange-100"
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onChange(value.filter((_, fileIndex) => fileIndex !== index));
                      setError(null);
                    }}
                  >
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
            <span className="mt-1 text-xs text-slate-400">
              {isProductionMode ? "Listo para subir a Storage privado" : "Listo para guardar · el archivo sigue en este navegador"}
            </span>
            <span className="mt-4 text-xs font-semibold text-orange-200 group-hover:text-orange-100">
              Elegir más archivos
            </span>
          </>
        ) : (
          <>
            <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-orange-300/10 text-2xl text-orange-200 ring-1 ring-orange-200/30">
              ↑
            </span>
            <span className="text-sm font-semibold text-white">
              Arrastra el export final aquí
            </span>
            <span className="mt-1 text-xs text-slate-400">
              o selecciona un archivo desde tu equipo
            </span>
          </>
        )}
      </label>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-slate-500">
        <span>
          Recomendado: <strong className="font-semibold text-slate-300">1080 × 1350 px</strong> · formato 4:5
        </span>
        <span>{isProductionMode ? "Validamos tipo, dimensiones y proporción en servidor." : "Validamos tipo de archivo, no dimensiones."}</span>
      </div>

      {error ? (
        <p className="text-sm text-orange-200" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
