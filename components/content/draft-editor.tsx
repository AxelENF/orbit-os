"use client";

/* Signed Supabase URLs are runtime hosts; the browser renders them directly. */
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import { PublicationTargets } from "@/components/content/publication-targets";
import type { PublicationTarget } from "@/lib/content/repository";
import { approveContentTarget, getContentRecord, submitFinalCopy } from "@/lib/content/client";
import type { ContentRecord, FinalCopySubmission } from "@/lib/content/repository";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";
import {
  approveDemoTarget,
  readDemoDraft,
  submitDemoDraftForReview,
  type DemoCopyOption,
  type DemoDraftRecord,
  type DemoFinalCopy,
} from "@/lib/demo/draft-store";

type DraftEditorProps = {
  draftId: string;
};

const fieldClasses =
  "mt-2 w-full rounded-xl border border-slate-700 bg-[#0c1427] px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-300/80 focus:ring-2 focus:ring-cyan-300/20";

const statusLabels: Record<DemoDraftRecord["content"]["state"], string> = {
  UPLOADED: "Subido",
  GENERATING: "Generando",
  DRAFT: "Borrador",
  REVIEW: "En revisión",
  APPROVED: "Aprobado",
  SCHEDULED: "Programado",
  PUBLISHED: "Publicado",
  REJECTED: "Rechazado",
  ERROR: "Error",
};

const briefLabels: Record<string, string> = {
  businessLine: "Línea",
  service: "Servicio",
  niche: "Nicho",
  contentType: "Tipo",
  objective: "Objetivo",
  format: "Formato",
  cta: "CTA original",
};

function formatValue(key: string, value: string): string {
  if (key === "format") return "Feed 4:5 · 1080 × 1350";
  return value.replaceAll("_", " ");
}

export function DraftEditor({ draftId }: DraftEditorProps) {
  return hasSupabaseBrowserConfig()
    ? <ProductionDraftEditor key={draftId} draftId={draftId} />
    : <DemoDraftEditor draftId={draftId} />;
}

function DemoDraftEditor({ draftId }: DraftEditorProps) {
  const [record, setRecord] = useState<DemoDraftRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [finalCopy, setFinalCopy] = useState<DemoFinalCopy>({
    headline: "",
    body: "",
    cta: "",
    hashtags: [],
  });
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = readDemoDraft(draftId);
      setRecord(stored);
      if (stored) {
        setSelectedDraftId(stored.selectedDraftId);
        setFinalCopy(stored.finalCopy);
      }
      setIsLoading(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftId]);

  function chooseDraft(draft: DemoCopyOption) {
    setSelectedDraftId(draft.id);
    setFinalCopy({ headline: draft.headline, body: draft.body, cta: draft.cta, hashtags: draft.hashtags });
    setFeedback(null);
  }

  function handleSendToReview() {
    if (!record) return;
    const next = submitDemoDraftForReview(record.content.id, finalCopy, selectedDraftId);
    if (!next) {
      setFeedback("No se pudo guardar la revisión local. Vuelve a abrir el borrador.");
      return;
    }
    setRecord(next);
    setFeedback("Copy final guardado y enviado a revisión humana.");
  }

  function handleApprove(targetId: string): Promise<PublicationTarget & { status: "APPROVED" }> {
    if (!record) return Promise.reject(new Error("DEMO_RECORD_NOT_FOUND"));
    const next = approveDemoTarget(record.content.id, targetId);
    if (!next) {
      setFeedback("Envía el copy a revisión antes de aprobar un destino.");
      return Promise.reject(new Error("DEMO_TARGET_NOT_REVIEWABLE"));
    }
    const approvedTarget = next.targets.find((target) => target.id === targetId);
    if (!approvedTarget || approvedTarget.status !== "APPROVED") {
      return Promise.reject(new Error("DEMO_TARGET_NOT_APPROVED"));
    }
    setRecord(next);
    setFeedback("Aprobación local registrada para este destino únicamente.");
    return Promise.resolve({ ...approvedTarget, status: "APPROVED" });
  }

  if (isLoading) {
    return <p className="mx-auto max-w-6xl text-sm text-slate-500">Cargando borrador local…</p>;
  }

  if (!record) {
    return (
      <div className="mx-auto max-w-3xl rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Borrador no encontrado</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Este registro no está en el demo local.</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">Puede que se haya limpiado el almacenamiento de este navegador. Crea un nuevo creativo para continuar.</p>
        <Link href="/library/new" className="mt-7 inline-flex rounded-xl bg-orange-300 px-4 py-3 text-sm font-bold text-[#17110a]">Subir creativo</Link>
      </div>
    );
  }

  const briefEntries = Object.entries(record.content).filter(([key]) => key in briefLabels);
  const canSendToReview = record.content.state === "DRAFT" && finalCopy.body.trim().length > 0 && finalCopy.cta.trim().length > 0;
  const targetsAreReviewable = record.content.state === "REVIEW" || record.content.state === "APPROVED";

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex flex-col gap-4 border-b border-white/[0.08] pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/drafts" className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-cyan-200/75 hover:text-cyan-100">← Borradores</Link>
          <p className="mt-6 font-mono text-[0.68rem] uppercase tracking-[0.24em] text-orange-200/80">Revisión del copy</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Ajusta cada palabra antes de abrir un destino.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">El creativo sigue siendo el export final de Canva. Aquí se decide el texto y se conserva qué red aprobaste.</p>
        </div>
        <span className="rounded-full border border-cyan-200/20 bg-cyan-200/[0.05] px-3 py-2 font-mono text-[0.62rem] uppercase tracking-[0.15em] text-cyan-100/80">{statusLabels[record.content.state]} · Demo local</span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.86fr_1.14fr]">
        <div className="space-y-6">
          <section className="overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0b1429]">
            <div className="relative aspect-[4/5] max-h-[38rem] bg-[#081127]">
              {/* This preview originates from the browser-local demo store. */}
              <Image src={record.previewDataUrl} alt={`Preview de ${record.filename}`} fill sizes="(min-width: 1280px) 36vw, 100vw" unoptimized className="object-cover" />
            </div>
            <div className="space-y-3 p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/75">Preview del asset</p>
                <span className="text-xs text-slate-500">{record.filename}</span>
              </div>
              <p className="text-xs leading-5 text-slate-500">Archivo local: no se genera ni se edita la imagen dentro de este flujo.</p>
            </div>
          </section>

          <section className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-cyan-200/75">Brief fuente</p>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              {briefEntries.map(([key, value]) => (
                <div key={key} className="rounded-xl border border-white/[0.07] bg-[#081127] px-3 py-3">
                  <dt className="text-[0.62rem] uppercase tracking-[0.14em] text-slate-500">{briefLabels[key]}</dt>
                  <dd className="mt-1 text-sm capitalize text-slate-200">{formatValue(key, String(value))}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 rounded-xl border border-orange-200/15 bg-orange-200/[0.04] p-4">
              <p className="text-[0.62rem] uppercase tracking-[0.14em] text-orange-200/75">Hechos permitidos</p>
              <ul className="mt-2 space-y-1 text-sm leading-6 text-slate-300">
                {record.content.allowedFacts.map((fact) => <li key={fact}>· {fact}</li>)}
              </ul>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-3xl border border-cyan-200/15 bg-cyan-200/[0.035] p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-cyan-200/80">Análisis visual · Demo local</p>
                <h2 className="mt-2 text-xl font-semibold text-white">Contexto pendiente de proveedor</h2>
              </div>
              <span className="rounded-full border border-cyan-200/20 px-2 py-1 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-cyan-100/70">No ejecutado</span>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-300">{record.visualAnalysis.summary}</p>
            <p className="mt-3 text-xs leading-5 text-slate-500">No se ejecutó IA ni se hizo ninguna llamada externa. Los copys de abajo son ejemplos locales para probar el recorrido.</p>
          </section>

          <section className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5 sm:p-6">
            <div className="flex items-end justify-between gap-3 border-b border-white/[0.08] pb-4">
              <div>
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-orange-200/80">Alternativas locales</p>
                <h2 className="mt-2 text-xl font-semibold text-white">Elige una base y edítala</h2>
              </div>
              <span className="text-xs text-slate-500">{record.drafts.length} opciones</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {record.drafts.map((draft, index) => {
                const selected = selectedDraftId === draft.id;
                return (
                  <button
                    key={draft.id}
                    className={`rounded-2xl border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-cyan-200/60 ${selected ? "border-cyan-200/55 bg-cyan-200/[0.08]" : "border-white/[0.08] bg-[#081127] hover:border-cyan-200/25"}`}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => chooseDraft(draft)}
                  >
                    <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-cyan-200/70">Alternativa 0{index + 1}</span>
                    <span className="mt-3 block text-sm font-semibold leading-5 text-white">{draft.headline}</span>
                    <span className="mt-2 block line-clamp-4 text-xs leading-5 text-slate-400">{draft.body}</span>
                    <span className="mt-2 block text-xs text-cyan-200/70">{draft.hashtags.join(" ")}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5 sm:p-6">
            <div className="border-b border-white/[0.08] pb-4">
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-orange-200/80">Copy final editable</p>
              <h2 className="mt-2 text-xl font-semibold text-white">Haz que la CTA diga exactamente lo que debe pasar.</h2>
            </div>
            <div className="mt-5 space-y-4">
              <label className="block text-sm font-semibold text-slate-100" htmlFor="final-headline">Titular final
                <input id="final-headline" className={fieldClasses} value={finalCopy.headline} onChange={(event) => setFinalCopy((current) => ({ ...current, headline: event.target.value }))} />
              </label>
              <label className="block text-sm font-semibold text-slate-100" htmlFor="final-body">Texto final
                <textarea id="final-body" className={`${fieldClasses} min-h-40 resize-y`} value={finalCopy.body} onChange={(event) => setFinalCopy((current) => ({ ...current, body: event.target.value }))} />
              </label>
              <label className="block text-sm font-semibold text-slate-100" htmlFor="final-cta">CTA final
                <input id="final-cta" className={fieldClasses} value={finalCopy.cta} onChange={(event) => setFinalCopy((current) => ({ ...current, cta: event.target.value }))} />
              </label>
              <label className="block text-sm font-semibold text-slate-100" htmlFor="final-hashtags">Hashtags finales
                <input
                  id="final-hashtags"
                  className={fieldClasses}
                  value={finalCopy.hashtags.join(" ")}
                  onChange={(event) => setFinalCopy((current) => ({
                    ...current,
                    hashtags: event.target.value.split(/\s+/).map((tag) => tag.trim()).filter(Boolean),
                  }))}
                  placeholder="#AutomatizacionWhatsApp #NegociosMexico"
                />
              </label>
            </div>
            <button
              className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] shadow-lg shadow-orange-300/10 transition hover:bg-orange-200 focus:outline-none focus:ring-2 focus:ring-orange-200 focus:ring-offset-2 focus:ring-offset-[#0a1020] disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              disabled={!canSendToReview}
              onClick={handleSendToReview}
            >
              {record.content.state === "DRAFT" ? "Enviar a revisión" : "Copy enviado a revisión"}
            </button>
            {record.content.state === "DRAFT" ? <p className="mt-3 text-xs leading-5 text-slate-500">Editar el texto no publica nada. El siguiente paso requiere aprobación humana por destino.</p> : null}
          </section>

          {targetsAreReviewable ? (
            <PublicationTargets targets={record.targets} onApprove={handleApprove} />
          ) : (
            <section className="rounded-2xl border border-dashed border-orange-200/20 bg-orange-200/[0.035] p-5">
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-orange-200/75">Destinos bloqueados</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">Envía el copy a revisión para habilitar Facebook e Instagram por separado.</p>
            </section>
          )}

          <section className="rounded-2xl border border-white/[0.08] bg-[#0b1429] p-5">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-orange-200/75">Guardrails</p>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-slate-400">
              {record.warnings.map((warning) => <li key={warning}>· {warning}</li>)}
            </ul>
            <button type="button" disabled className="mt-5 inline-flex min-h-10 items-center rounded-lg border border-white/[0.1] px-3 py-2 text-xs font-semibold text-slate-500 disabled:cursor-not-allowed">Publicar ahora · requiere conexión de producción</button>
          </section>

          {feedback ? <p className="rounded-xl border border-cyan-200/20 bg-cyan-200/[0.05] p-4 text-sm text-cyan-100" role="status">{feedback}</p> : null}
        </div>
      </div>
    </div>
  );
}

export type { PublicationTarget };

function emptyEditableFinalCopy(): FinalCopySubmission {
  return {
    headline: "",
    body: "",
    cta: "",
    hashtags: [],
  };
}

export function toEditableFinalCopy(record: ContentRecord): FinalCopySubmission {
  if (record.finalCopy) {
    return {
      ...(record.finalCopy.selectedCopyDraftId
        ? { selectedCopyDraftId: record.finalCopy.selectedCopyDraftId }
        : {}),
      headline: record.finalCopy.headline,
      body: record.finalCopy.body,
      cta: record.finalCopy.cta,
      hashtags: record.finalCopy.hashtags,
    };
  }

  const latest = record.drafts.at(-1);
  if (!latest) return emptyEditableFinalCopy();

  return {
    selectedCopyDraftId: latest.id,
    headline: latest.headline,
    body: latest.body,
    cta: latest.cta,
    hashtags: latest.hashtags,
  };
}

function copyRetryKeyFromRecord(record: ContentRecord): string | null {
  const event = record.auditEvents.findLast((candidate) => candidate.type === "COPY_REQUEST_QUEUED");
  const idempotencyKey = event?.metadata.idempotencyKey;
  return typeof idempotencyKey === "string" ? idempotencyKey : null;
}

function ProductionDraftEditor({ draftId }: DraftEditorProps) {
  const [record, setRecord] = useState<ContentRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isRequestingCopy, setIsRequestingCopy] = useState(false);
  const [isSubmittingFinalCopy, setIsSubmittingFinalCopy] = useState(false);
  const [selectedDraftId, setSelectedDraftId] = useState<string | undefined>();
  const [finalCopy, setFinalCopy] = useState<FinalCopySubmission>(emptyEditableFinalCopy);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copyRetryKey, setCopyRetryKey] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const applyLoadedRecord = useCallback((loadedRecord: ContentRecord | null) => {
    setRecord(loadedRecord);
    const editableFinalCopy = loadedRecord
      ? toEditableFinalCopy(loadedRecord)
      : emptyEditableFinalCopy();
    setSelectedDraftId(editableFinalCopy.selectedCopyDraftId);
    setFinalCopy(editableFinalCopy);
  }, []);

  const refresh = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setIsLoading(true);
    setLoadError(null);
    try {
      const loadedRecord = await getContentRecord(draftId);
      if (requestSequence !== requestSequenceRef.current) return;
      applyLoadedRecord(loadedRecord);
    } catch {
      if (requestSequence !== requestSequenceRef.current) return;
      setLoadError("No se pudo cargar este registro. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      if (requestSequence === requestSequenceRef.current) setIsLoading(false);
    }
  }, [applyLoadedRecord, draftId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      requestSequenceRef.current += 1;
    };
  }, [refresh]);

  async function requestCopy() {
    if (!record?.asset?.signedUrl) {
      setFeedback("Este registro no tiene una URL privada disponible para n8n.");
      return;
    }
    const existingCopyRetryKey = copyRetryKey ?? copyRetryKeyFromRecord(record);
    const idempotencyKey = existingCopyRetryKey ?? crypto.randomUUID();
    setIsRequestingCopy(true);
    setFeedback(null);
    const content = record.content;
    const brief = {
      businessLine: content.businessLine,
      service: content.service,
      niche: content.niche,
      contentType: content.contentType,
      objective: content.objective,
      format: content.format,
      cta: content.cta,
      humanDescription: content.humanDescription,
      allowedFacts: content.allowedFacts,
      ...(content.campaign
        ? {
            campaignName: content.campaign.campaignName,
            offer: content.campaign.offer,
            funnelStage: content.campaign.funnelStage,
            destination: content.campaign.destination,
            destinationValue: content.campaign.destinationValue,
          }
        : {}),
    };
    try {
      const response = await fetch("/api/integrations/n8n/copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          contentItemId: content.id,
          assetUrl: record.asset.signedUrl,
          brief,
          idempotencyKey,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "COPY_REQUEST_FAILED");
      }
      const payload = (await response.json()) as { status?: string; idempotencyKey?: string };
      if (payload.status === "DELIVERY_UNCONFIRMED") {
        setCopyRetryKey(payload.idempotencyKey ?? idempotencyKey);
        setFeedback("No se pudo confirmar la entrega a n8n. Puedes reenviar esta misma solicitud sin duplicar el trabajo.");
      } else {
        setCopyRetryKey(null);
        setFeedback("Solicitud enviada a n8n. Refresca cuando llegue el callback con las alternativas.");
      }
      await refresh();
    } catch {
      setFeedback("No se pudo solicitar el copy. Verifica n8n y la configuración de staging.");
    } finally {
      setIsRequestingCopy(false);
    }
  }

  async function approveTarget(targetId: string): Promise<PublicationTarget & { status: "APPROVED" }> {
    if (!record) throw new Error("CONTENT_RECORD_NOT_LOADED");
    const target = record.targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new Error("PUBLICATION_TARGET_NOT_FOUND");
    const approvedTarget = await approveContentTarget(record.content.id, target);
    if (approvedTarget.status !== "APPROVED") throw new Error("PUBLICATION_TARGET_NOT_APPROVED");
    await refresh();
    setFeedback("Aprobación registrada para este destino.");
    return { ...approvedTarget, status: "APPROVED" };
  }

  function chooseProductionDraft(draft: ContentRecord["drafts"][number]) {
    setSelectedDraftId(draft.id);
    setFinalCopy({
      selectedCopyDraftId: draft.id,
      headline: draft.headline,
      body: draft.body,
      cta: draft.cta,
      hashtags: draft.hashtags,
    });
    setFeedback(null);
  }

  async function sendFinalCopyToReview() {
    if (!record) return;
    setIsSubmittingFinalCopy(true);
    setFeedback(null);
    try {
      await submitFinalCopy(record.content.id, {
        ...finalCopy,
        ...(selectedDraftId ? { selectedCopyDraftId: selectedDraftId } : {}),
      });
      await refresh();
      setFeedback("Copy final bloqueado como versión de revisión. Ahora puedes aprobar cada red por separado.");
    } catch {
      await refresh();
      setFeedback("No se pudo confirmar la respuesta del copy final. Se recargó el registro para comprobar si ya quedó en revisión.");
    } finally {
      setIsSubmittingFinalCopy(false);
    }
  }

  if (isLoading) return <p className="mx-auto max-w-6xl text-sm text-slate-500">Cargando registro real…</p>;
  if (loadError && !record) {
    return (
      <div className="mx-auto max-w-3xl rounded-3xl border border-orange-200/20 bg-orange-200/[0.04] px-6 py-14 text-center sm:px-10" role="alert">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-orange-200/80">No se pudo cargar</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">{loadError}</h1>
        <button type="button" onClick={() => void refresh()} className="mt-7 inline-flex rounded-xl bg-orange-300 px-4 py-3 text-sm font-bold text-[#17110a]">Reintentar carga</button>
      </div>
    );
  }
  if (!record) {
    return <div className="mx-auto max-w-3xl rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10"><p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Registro no encontrado</p><h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">No existe un creativo visible para esta sesión.</h1><Link href="/drafts" className="mt-7 inline-flex rounded-xl bg-orange-300 px-4 py-3 text-sm font-bold text-[#17110a]">Volver a borradores</Link></div>;
  }

  const content = record.content;
  const briefEntries = Object.entries(content).filter(([key]) => key in briefLabels);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex flex-col gap-4 border-b border-white/[0.08] pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div><Link href="/drafts" className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-cyan-200/75 hover:text-cyan-100">← Borradores</Link><p className="mt-6 font-mono text-[0.68rem] uppercase tracking-[0.24em] text-orange-200/80">Registro Supabase</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Revisa el contexto antes de pedir el siguiente paso.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">El asset permanece privado, n8n sólo recibe una URL temporal y cada red mantiene su propia aprobación.</p></div>
        <span className="rounded-full border border-cyan-200/20 bg-cyan-200/[0.05] px-3 py-2 font-mono text-[0.62rem] uppercase tracking-[0.15em] text-cyan-100/80">{content.state} · Supabase</span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.86fr_1.14fr]">
        <div className="space-y-6">
          <section className="overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0b1429]">
            <div className="flex aspect-[4/5] max-h-[38rem] items-center justify-center bg-[#081127]">{record.asset?.signedUrl ? <img src={record.asset.signedUrl} alt={`Preview de ${record.asset.filename}`} className="h-full w-full object-cover" /> : <span className="text-xs text-slate-600">Asset sin URL temporal</span>}</div>
            <div className="space-y-3 p-5"><div className="flex items-center justify-between gap-3"><p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/75">Preview del asset</p><span className="text-xs text-slate-500">{record.asset?.filename ?? "Sin archivo"}</span></div><p className="text-xs leading-5 text-slate-500">URL temporal firmada para lectura. No se expone el path interno de Storage.</p></div>
          </section>
          <section className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5"><p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-cyan-200/75">Brief fuente</p><dl className="mt-4 grid gap-3 sm:grid-cols-2">{briefEntries.map(([key, value]) => <div key={key} className="rounded-xl border border-white/[0.07] bg-[#081127] px-3 py-3"><dt className="text-[0.62rem] uppercase tracking-[0.14em] text-slate-500">{briefLabels[key]}</dt><dd className="mt-1 text-sm capitalize text-slate-200">{formatValue(key, String(value))}</dd></div>)}</dl><div className="mt-4 rounded-xl border border-orange-200/15 bg-orange-200/[0.04] p-4"><p className="text-[0.62rem] uppercase tracking-[0.14em] text-orange-200/75">Hechos permitidos</p><ul className="mt-2 space-y-1 text-sm leading-6 text-slate-300">{content.allowedFacts.map((fact) => <li key={fact}>· {fact}</li>)}</ul></div></section>
        </div>

        <div className="space-y-6">
          <section className="rounded-3xl border border-cyan-200/15 bg-cyan-200/[0.035] p-5 sm:p-6"><div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-cyan-200/80">Motor n8n</p><h2 className="mt-2 text-xl font-semibold text-white">Solicita análisis visual y dos alternativas</h2></div><span className="rounded-full border border-cyan-200/20 px-2 py-1 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-cyan-100/70">{content.state}</span></div><p className="mt-4 text-sm leading-6 text-slate-300">n8n recibe el brief almacenado y una URL temporal; el callback debe coincidir con la llave de idempotencia antes de crear borradores.</p><button type="button" onClick={() => void requestCopy()} disabled={isRequestingCopy || (content.state === "GENERATING" && !copyRetryKey && !copyRetryKeyFromRecord(record))} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] disabled:cursor-not-allowed disabled:opacity-45">{isRequestingCopy ? "Enviando solicitud…" : content.state === "GENERATING" ? "Reenviar solicitud a n8n" : "Solicitar copy a n8n"}</button></section>
           <section className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5 sm:p-6"><div className="flex items-end justify-between gap-3 border-b border-white/[0.08] pb-4"><div><p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-orange-200/80">Alternativas recibidas</p><h2 className="mt-2 text-xl font-semibold text-white">Elige una base, luego edítala</h2></div><span className="text-xs text-slate-500">{record.drafts.length} opciones</span></div>{record.drafts.length > 0 ? <div className="mt-4 grid gap-3 sm:grid-cols-2">{record.drafts.map((draft, index) => <button key={draft.id} type="button" onClick={() => chooseProductionDraft(draft)} aria-pressed={selectedDraftId === draft.id} disabled={Boolean(record.finalCopy)} className={`rounded-2xl border p-4 text-left transition disabled:cursor-default ${selectedDraftId === draft.id ? "border-cyan-200/55 bg-cyan-200/[0.08]" : "border-white/[0.08] bg-[#081127] hover:border-cyan-200/25"}`}><span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-cyan-200/70">Alternativa 0{index + 1}</span><h3 className="mt-3 text-sm font-semibold leading-5 text-white">{draft.headline}</h3><p className="mt-2 text-xs leading-5 text-slate-400">{draft.body}</p><p className="mt-3 text-xs text-cyan-100/75">CTA: {draft.cta}</p><p className="mt-1 text-xs text-cyan-200/70">{(draft.hashtags ?? []).join(" ")}</p></button>)}</div> : <p className="mt-4 rounded-xl border border-dashed border-white/[0.12] p-4 text-sm text-slate-500">Aún no hay callback de n8n.</p>}</section>
          <section className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5 sm:p-6"><div className="border-b border-white/[0.08] pb-4"><p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-orange-200/80">Copy final seleccionado</p><h2 className="mt-2 text-xl font-semibold text-white">Una versión inmutable antes de aprobar destinos</h2></div><div className="mt-5 space-y-4"><label className="block text-sm font-semibold text-slate-100" htmlFor="production-final-headline">Titular final<input id="production-final-headline" disabled={Boolean(record.finalCopy)} className={fieldClasses} value={finalCopy.headline} onChange={(event) => setFinalCopy((current) => ({ ...current, headline: event.target.value }))} /></label><label className="block text-sm font-semibold text-slate-100" htmlFor="production-final-body">Texto final<textarea id="production-final-body" disabled={Boolean(record.finalCopy)} className={`${fieldClasses} min-h-36 resize-y`} value={finalCopy.body} onChange={(event) => setFinalCopy((current) => ({ ...current, body: event.target.value }))} /></label><label className="block text-sm font-semibold text-slate-100" htmlFor="production-final-cta">CTA final<input id="production-final-cta" disabled={Boolean(record.finalCopy)} className={fieldClasses} value={finalCopy.cta} onChange={(event) => setFinalCopy((current) => ({ ...current, cta: event.target.value }))} /></label><label className="block text-sm font-semibold text-slate-100" htmlFor="production-final-hashtags">Hashtags finales<input id="production-final-hashtags" disabled={Boolean(record.finalCopy)} className={fieldClasses} value={(finalCopy.hashtags ?? []).join(" ")} onChange={(event) => setFinalCopy((current) => ({ ...current, hashtags: event.target.value.split(/\s+/).map((tag) => tag.trim()).filter(Boolean) }))} placeholder="#AutomatizacionWhatsApp #NegociosMexico" /></label></div>{record.finalCopy ? <p className="mt-5 rounded-xl border border-cyan-200/20 bg-cyan-200/[0.05] p-4 text-xs leading-5 text-cyan-100">Versión {record.finalCopy.version} seleccionada. Para modificarla debe volver a borrador mediante un flujo auditado.</p> : <button type="button" onClick={() => void sendFinalCopyToReview()} disabled={isSubmittingFinalCopy || content.state !== "DRAFT" || !finalCopy.headline.trim() || !finalCopy.body.trim() || !finalCopy.cta.trim()} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] disabled:cursor-not-allowed disabled:opacity-45">{isSubmittingFinalCopy ? "Validando copy…" : "Enviar copy final a revisión"}</button>}</section>
          <PublicationTargets targets={record.targets} disabled={!record.finalCopy || content.state !== "REVIEW"} onApprove={approveTarget} />
          {loadError ? <div className="rounded-xl border border-orange-200/20 bg-orange-200/[0.04] p-4 text-sm text-orange-100" role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()} className="mt-3 text-xs font-bold uppercase tracking-[0.14em] text-orange-200 hover:text-orange-100">Reintentar carga</button></div> : null}
          {feedback ? <p className="rounded-xl border border-cyan-200/20 bg-cyan-200/[0.05] p-4 text-sm text-cyan-100" role="status">{feedback}</p> : null}
        </div>
      </div>
    </div>
  );
}
