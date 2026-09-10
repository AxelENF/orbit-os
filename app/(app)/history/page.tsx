"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { readDemoDrafts, type DemoAuditEvent, type DemoDraftRecord } from "@/lib/demo/draft-store";
import { getContentRecord, listContentItems } from "@/lib/content/client";
import type { ContentRecord } from "@/lib/content/repository";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

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

const eventLabels: Record<DemoAuditEvent["type"], string> = {
  CONTENT_CREATED: "Creativo registrado",
  LOCAL_DRAFTS_CREATED: "Alternativas locales creadas",
  SENT_TO_REVIEW: "Enviado a revisión",
  TARGET_APPROVED: "Destino aprobado",
};

const eventTone: Record<DemoAuditEvent["status"], string> = {
  info: "border-cyan-200/20 bg-cyan-200/[0.04] text-cyan-100",
  success: "border-emerald-200/20 bg-emerald-200/[0.04] text-emerald-100",
  warning: "border-orange-200/20 bg-orange-200/[0.04] text-orange-100",
};

function productionEventLabel(type: string): string {
  const labels: Record<string, string> = {
    CONTENT_CREATED: "Creativo registrado",
    COPY_REQUEST_QUEUED: "Copy solicitado",
    COPY_CALLBACK_RECEIVED: "Copy recibido",
    TARGET_APPROVED: "Destino aprobado",
    PUBLISH_CALLBACK_RECEIVED: "Resultado de publicación",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function HistoryPage() {
  const [records, setRecords] = useState<DemoDraftRecord[]>([]);
  const [productionRecords, setProductionRecords] = useState<ContentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isProductionMode = hasSupabaseBrowserConfig();

  useEffect(() => {
    if (isProductionMode) {
      listContentItems()
        .then((items) => Promise.all(items.map((item) => getContentRecord(item.id))))
        .then(setProductionRecords)
        .catch(() => setProductionRecords([]))
        .finally(() => setIsLoading(false));
      return;
    }
    const timer = window.setTimeout(() => {
      setRecords(readDemoDrafts());
      setIsLoading(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isProductionMode]);

  const events = records
    .flatMap((record) => record.auditEvents.map((event) => ({ event, record })))
    .sort((left, right) => right.event.createdAt.localeCompare(left.event.createdAt));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-5 border-b border-white/[0.08] pb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.24em] text-cyan-200/80">{isProductionMode ? "Historial de producción" : "Historial local"}</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Cada decisión queda visible.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-400">Eventos del demo local, con estados y mensajes sanitizados. No se muestran secretos, respuestas remotas ni falsos éxitos de publicación.</p>
        </div>
        <span className="rounded-full border border-cyan-200/20 bg-cyan-200/[0.05] px-3 py-2 font-mono text-[0.62rem] uppercase tracking-[0.15em] text-cyan-100/80">{isProductionMode ? "Supabase" : "Solo navegador"}</span>
      </div>

      {isLoading ? <p className="mt-8 text-sm text-slate-500">Cargando historial…</p> : null}

      {!isLoading && isProductionMode ? (
        <section className="mt-8 space-y-4">
          {productionRecords.flatMap((record) => record.auditEvents.map((event) => ({ event, record }))).sort((left, right) => right.event.createdAt.localeCompare(left.event.createdAt)).map(({ event, record }) => (
            <article key={event.id} className="grid gap-4 rounded-2xl border border-white/[0.08] bg-[#0b1429] p-5 sm:grid-cols-[auto_1fr_auto] sm:items-start">
              <span className={`inline-flex w-fit rounded-full border px-2 py-1 font-mono text-[0.6rem] uppercase tracking-[0.12em] ${eventTone[event.status]}`}>{event.status}</span>
              <div><h2 className="text-sm font-semibold text-white">{productionEventLabel(event.type)}</h2><p className="mt-1 text-sm leading-6 text-slate-400">{event.message}</p><p className="mt-2 text-xs text-slate-600">{record.asset?.filename ?? record.content.service} · Estado actual: {statusLabels[record.content.state]}</p></div>
              <time className="text-xs text-slate-500 sm:text-right" dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
            </article>
          ))}
          {productionRecords.every((record) => record.auditEvents.length === 0) ? <section className="rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10"><p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Sin eventos todavía</p><h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">El historial real se activa con tu primer creativo.</h2></section> : null}
        </section>
      ) : null}

      {!isLoading && !isProductionMode && events.length > 0 ? (
        <section className="mt-8 space-y-4">
          {events.map(({ event, record }) => (
            <article key={event.id} className="grid gap-4 rounded-2xl border border-white/[0.08] bg-[#0b1429] p-5 sm:grid-cols-[auto_1fr_auto] sm:items-start">
              <span className={`inline-flex w-fit rounded-full border px-2 py-1 font-mono text-[0.6rem] uppercase tracking-[0.12em] ${eventTone[event.status]}`}>{event.status}</span>
              <div>
                <h2 className="text-sm font-semibold text-white">{eventLabels[event.type]}</h2>
                <p className="mt-1 text-sm leading-6 text-slate-400">{event.message}</p>
                <p className="mt-2 text-xs text-slate-600">{record.filename} · Estado actual: {statusLabels[record.content.state]}</p>
              </div>
              <time className="text-xs text-slate-500 sm:text-right" dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
            </article>
          ))}
        </section>
      ) : null}

      {!isLoading && !isProductionMode && events.length === 0 ? (
        <section className="mt-8 rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Sin eventos todavía</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">El historial se activa con tu primer creativo.</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">Los registros locales aparecerán después de guardar el export de Canva y sus decisiones de revisión.</p>
          <Link href="/library/new" className="mt-7 inline-flex rounded-xl border border-cyan-200/25 px-4 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/10">Crear primer registro</Link>
        </section>
      ) : null}
    </div>
  );
}
