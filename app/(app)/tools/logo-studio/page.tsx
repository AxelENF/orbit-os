"use client";

import { useEffect, useMemo, useState } from "react";

import { OrganizationSwitcher, parseOrganizationsResponse, type OrganizationOption } from "@/components/aias/organization-switcher";
import { CompositeControls } from "@/components/logo-studio/composite-controls";
import { CompositePreview } from "@/components/logo-studio/composite-preview";
import { CreativeBatchDropzone } from "@/components/logo-studio/creative-batch-dropzone";
import { LogoUploadPanel } from "@/components/logo-studio/logo-upload-panel";
import { compositeToBlob, type CompositeOptions, type OutputFormat } from "@/lib/logo-studio/compose";
import { buildLogoStudioZip, downloadZip } from "@/lib/logo-studio/export-zip";

// Mismo patrón que settings/organizations/page.tsx:26-32 — corrección
// ronda 1: la versión anterior llamaba fetch().then(r => r.json()) sin
// comprobar response.ok ni validar la forma de la respuesta.
async function loadOrganizations(): Promise<{ organizations: OrganizationOption[]; activeOrganizationId: string | null }> {
  const response = await fetch("/api/organizations", { cache: "no-store" });
  if (!response.ok) throw new Error("ORGANIZATION_LOOKUP_FAILED");
  const payload = parseOrganizationsResponse(await response.json());
  if (!payload) throw new Error("INVALID_ORGANIZATIONS_RESPONSE");
  return payload;
}

type ExportFailure = { filename: string };

export default function LogoStudioPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creativeFiles, setCreativeFiles] = useState<File[]>([]);
  const [options, setOptions] = useState<CompositeOptions>({ corner: "bottom-right", sizePercent: 15, marginPercent: 4 });
  const [isExporting, setIsExporting] = useState(false);
  const [exportFailures, setExportFailures] = useState<ExportFailure[]>([]);
  // Corrección ronda 2 (recomendación aplicada): error de nivel superior,
  // distinto de exportFailures (que es por creativo) — cubre fallos que
  // no son culpa de ningún archivo individual (el logo mismo no carga, o
  // buildLogoStudioZip falla).
  const [topLevelExportError, setTopLevelExportError] = useState<string | null>(null);
  // Corrección ronda 1: contador de cache-bust compartido — se incrementa
  // vía LogoUploadPanel.onUploadSuccess (Task 7) para que CompositePreview
  // (Task 10) también deje de usar la versión cacheada del logo anterior.
  // Corrección ronda 2 (recomendación aplicada): contador monotónico en
  // vez de Date.now() — evita, aunque sea de forma remota, dos subidas en
  // el mismo milisegundo produciendo el mismo valor de cache-bust.
  const [logoCacheBust, setLogoCacheBust] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadOrganizations()
      .then((payload) => {
        if (cancelled) return;
        setOrganizations(payload.organizations);
        setActiveOrganizationId(payload.activeOrganizationId);
      })
      .catch(() => {
        if (!cancelled) setLoadError("No se pudieron cargar tus organizaciones.");
      });
    return () => { cancelled = true; };
  }, []);

  const logoImageUrl = useMemo(
    () => activeOrganizationId ? `/api/organizations/${activeOrganizationId}/logo${logoCacheBust ? `?t=${logoCacheBust}` : ""}` : null,
    [activeOrganizationId, logoCacheBust],
  );

  async function handleExport() {
    if (!activeOrganizationId || !logoImageUrl || creativeFiles.length === 0) return;
    setIsExporting(true);
    setExportFailures([]);
    setTopLevelExportError(null);
    // Corrección ronda 2 del plan review (bug real): el botón dispara
    // `() => void handleExport()` — sin este try/catch envolviendo TODA
    // la función, un fallo al cargar el logo mismo o en
    // buildLogoStudioZip rechazaba la promesa devuelta por handleExport,
    // que el `void` del botón descarta sin más: ningún mensaje visible,
    // contradiciendo el manejo de errores de la spec. El
    // Promise.allSettled de abajo sigue aislando fallos POR CREATIVO
    // (exportFailures); este try/catch cubre todo lo demás.
    try {
      const logoImage = new Image();
      await new Promise<void>((resolve, reject) => { logoImage.onload = () => resolve(); logoImage.onerror = reject; logoImage.src = logoImageUrl; });

      // Corrección ronda 1 (bug real): Promise.all abortaba TODO el export
      // si un solo creativo fallaba al cargar — Promise.allSettled aísla
      // cada fallo, igual que useAttentionTargets ya hace en la rama de
      // navegación para getContentRecord.
      const outcomes = await Promise.allSettled(creativeFiles.map(async (file) => {
        const creativeImage = new Image();
        const objectUrl = URL.createObjectURL(file);
        try {
          // Corrección ronda 3 del plan review (bug real, misma clase de
          // fuga ya arreglada en CompositePreview/Task 10 pero que faltaba
          // aplicar aquí): si la carga de la imagen rechaza, la línea de
          // revokeObjectURL de abajo nunca se ejecutaba — el objectUrl de
          // cada creativo que falla se quedaba vivo indefinidamente.
          await new Promise<void>((resolve, reject) => { creativeImage.onload = () => resolve(); creativeImage.onerror = reject; creativeImage.src = objectUrl; });
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
        const outputFormat: OutputFormat = file.type === "image/png" ? "image/png" : "image/jpeg";
        const blob = await compositeToBlob(creativeImage, logoImage, options, outputFormat);
        return { originalFilename: file.name, outputFormat, blob };
      }));

      const entries = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
      const failures = creativeFiles
        .filter((_, index) => outcomes[index].status === "rejected")
        .map((file) => ({ filename: file.name }));

      // Corrección ronda 3 del plan review (bug real: dos role="alert"
      // simultáneos posibles): cuando TODOS los creativos fallan, antes se
      // seteaban exportFailures Y topLevelExportError a la vez, generando
      // dos elementos role="alert" al mismo tiempo — findByRole("alert")
      // (singular) en un test lanzaría por encontrar más de uno. Ahora son
      // mutuamente excluyentes por construcción: el caso "todos fallaron"
      // solo setea topLevelExportError y sale antes de tocar
      // exportFailures; exportFailures solo se setea en el camino donde sí
      // hay algo que exportar (puede ser fallos parciales, o vacío si todo
      // salió bien).
      if (entries.length === 0) {
        setTopLevelExportError(`No se pudo procesar ningún creativo del lote (${failures.length} fallaron).`);
        return;
      }
      setExportFailures(failures);
      const zipBlob = await buildLogoStudioZip(entries);
      downloadZip(zipBlob, `snapgad-logos-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch {
      setTopLevelExportError("No se pudo generar el ZIP. Verifica que la organización tenga un logo subido e inténtalo de nuevo.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div>
      <h1>Logo Studio</h1>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {organizations.length > 0 ? (
        <OrganizationSwitcher
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
          onOrganizationChange={setActiveOrganizationId}
        />
      ) : null}
      {activeOrganizationId && logoImageUrl ? (
        <>
          {/*
            Corrección ronda 1 (bug real): key={activeOrganizationId} fuerza
            un remount completo de LogoUploadPanel al cambiar de
            organización — sin esto, su estado interno hasLogo se queda con
            el valor de la organización anterior hasta que el <img> nuevo
            dispara su propio onError.
          */}
          <LogoUploadPanel
            key={activeOrganizationId}
            organizationId={activeOrganizationId}
            onUploadSuccess={() => setLogoCacheBust((value) => value + 1)}
          />
          <CreativeBatchDropzone onFilesChange={setCreativeFiles} />
          <CompositeControls value={options} onChange={setOptions} />
          <CompositePreview creativeFile={creativeFiles[0] ?? null} logoImageUrl={logoImageUrl} options={options} />
          <button type="button" onClick={() => void handleExport()} disabled={creativeFiles.length === 0 || isExporting}>
            {isExporting ? "Exportando…" : "Exportar ZIP"}
          </button>
          {exportFailures.length > 0 ? (
            <p role="alert">No se pudo procesar: {exportFailures.map((failure) => failure.filename).join(", ")}. El resto del lote sí se exportó.</p>
          ) : null}
          {topLevelExportError ? <p role="alert">{topLevelExportError}</p> : null}
        </>
      ) : null}
    </div>
  );
}
