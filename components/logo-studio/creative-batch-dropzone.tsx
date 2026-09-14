"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

export const MAX_BATCH_SIZE = 30;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function CreativeBatchDropzone({ onFilesChange }: { onFilesChange: (files: File[]) => void }) {
  const [error, setError] = useState<string | null>(null);

  // Corrección ronda 1 (bug real): con `maxFiles` configurado abajo,
  // react-dropzone YA pone los archivos sobrantes en `fileRejections`
  // (code "too-many-files") — nunca llegan a `acceptedFiles`, así que la
  // rama vieja `acceptedFiles.length > MAX_BATCH_SIZE` era código muerto,
  // jamás se ejecutaba. Distingue el motivo del rechazo por su `code` en
  // vez de asumirlo por longitud (verifica el string exacto de
  // ErrorCode.TooManyFiles contra la versión instalada de react-dropzone,
  // 20.1.1, al implementar).
  const onDrop = useCallback((acceptedFiles: File[], fileRejections: { file: File; errors: readonly { code: string }[] }[]) => {
    const hasTooManyFiles = fileRejections.some((rejection) => rejection.errors.some((error) => error.code === "too-many-files"));
    const hasOtherRejection = fileRejections.some((rejection) => rejection.errors.some((error) => error.code !== "too-many-files"));

    if (hasTooManyFiles) {
      setError(`Máximo ${MAX_BATCH_SIZE} creativos por lote.`);
    } else if (hasOtherRejection) {
      setError("Hay archivos con tipo de archivo no soportado o demasiado grande — solo se aceptan .png/.jpg/.jpeg/.webp hasta 10 MB cada uno.");
    } else {
      setError(null);
    }
    onFilesChange(acceptedFiles);
  }, [onFilesChange]);

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    multiple: true,
    maxFiles: MAX_BATCH_SIZE,
    maxSize: MAX_FILE_BYTES,
    accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] },
  });

  return (
    <div {...getRootProps()}>
      <input {...getInputProps()} aria-label="Cargar creativos" />
      <p>Arrastra tus creativos aquí, o haz click para elegir archivos.</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
