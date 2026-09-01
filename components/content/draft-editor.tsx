"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";

import { PublicationTargets } from "@/components/content/publication-targets";
import type { PublicationTarget } from "@/lib/content/repository";
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
  const [record, setRecord] = useState<DemoDraftRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [finalCopy, setFinalCopy] = useState<DemoFinalCopy>({
    headline: "",
    body: "",
    cta: "",
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
    setFinalCopy({ headline: draft.headline, body: draft.body, cta: draft.cta });
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

  function handleApprove(targetId: string) {
    if (!record) return;
    const next = approveDemoTarget(record.content.id, targetId);
    if (!next) {
      setFeedback("Envía el copy a revisión antes de aprobar un destino.");
      return;
    }
    setRecord(next);
    setFeedback("Aprobación local registrada para este destino únicamente.");
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
            <button type="button" disabled className="mt-5 inline-flex min-h-10 items-center rounded-lg border border-white/[0.1] px-3 py-2 text-xs font-semibold text-slate-500 disabled:cursor-not-allowed">Publicar ahora · disponible en Task 7</button>
          </section>

          {feedback ? <p className="rounded-xl border border-cyan-200/20 bg-cyan-200/[0.05] p-4 text-sm text-cyan-100" role="status">{feedback}</p> : null}
        </div>
      </div>
    </div>
  );
}

export type { PublicationTarget };
