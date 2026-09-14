"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";

import { compositeToBlob, type CompositeOptions } from "@/lib/logo-studio/compose";

export function CompositePreview({
  creativeFile,
  logoImageUrl,
  options,
}: {
  creativeFile: File | null;
  logoImageUrl: string;
  options: CompositeOptions;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!creativeFile) {
      // The empty state must clear the previous async preview immediately.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewUrl(null);
      setHasError(false);
      return;
    }
    let cancelled = false;
    setHasError(false);
    // Corrección ronda 2 del plan review: limpia el preview anterior de
    // inmediato al empezar una carga nueva — antes se quedaba mostrando
    // la imagen VIEJA mientras la nueva componía, en vez de pasar a
    // "Generando preview…" de una vez.
    setPreviewUrl(null);

    async function render() {
      const creativeImage = new Image();
      const logoImage = new Image();
      const creativeUrl = URL.createObjectURL(creativeFile!);
      try {
        await Promise.all([
          new Promise<void>((resolve, reject) => { creativeImage.onload = () => resolve(); creativeImage.onerror = reject; creativeImage.src = creativeUrl; }),
          new Promise<void>((resolve, reject) => { logoImage.onload = () => resolve(); logoImage.onerror = reject; logoImage.src = logoImageUrl; }),
        ]);
      } finally {
        // Corrección ronda 2 (fuga real de recursos): revocar SIEMPRE,
        // incluso si una de las dos cargas falla — la versión anterior
        // solo revocaba en el camino feliz, dejando el blob: URL vivo si
        // el logo (o el creativo) fallaba al cargar.
        URL.revokeObjectURL(creativeUrl);
      }
      if (cancelled) return;

      const blob = await compositeToBlob(creativeImage, logoImage, options, "image/png");
      if (cancelled) return;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPreviewUrl(url);
    }

    render().catch(() => {
      if (cancelled) return;
      setPreviewUrl(null);
      setHasError(true);
    });

    return () => {
      cancelled = true;
    };
  }, [creativeFile, logoImageUrl, options]);

  // Limpieza en unmount — la versión anterior solo revocaba la URL previa
  // cuando una NUEVA llegaba, nunca al desmontar el componente.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  if (!creativeFile) return <p>Carga al menos un creativo para ver el preview.</p>;
  if (hasError) return <p role="alert">No se pudo generar el preview. Verifica que el creativo sea una imagen válida.</p>;
  return previewUrl ? <img src={previewUrl} alt="Preview del composite" /> : <p>Generando preview…</p>;
}
