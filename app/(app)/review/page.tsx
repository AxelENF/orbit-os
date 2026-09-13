"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { PublicationTargets } from "@/components/content/publication-targets";
import {
  approveDemoTarget,
  readDemoDrafts,
  type DemoDraftRecord,
} from "@/lib/demo/draft-store";
import { approveContentTarget, getContentRecord, listContentItems, retryContentTarget } from "@/lib/content/client";
import type { ContentRecord } from "@/lib/content/repository";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

export default function ReviewPage() {
  const [records, setRecords] = useState<DemoDraftRecord[]>([]);
  const [productionRecords, setProductionRecords] = useState<ContentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [productionError, setProductionError] = useState<string | null>(null);
  const isProductionMode = hasSupabaseBrowserConfig();

  function refresh() {
    setRecords(readDemoDrafts());
  }

  useEffect(() => {
    if (isProductionMode) {
      listContentItems()
        .then((items) => Promise.all(items.map((item) => getContentRecord(item.id))))
        .then(setProductionRecords)
        .catch(() => setProductionError("No se pudo cargar la cola de revisión real."))
        .finally(() => setIsLoading(false));
      return;
    }
    const timer = window.setTimeout(() => {
      refresh();
      setIsLoading(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isProductionMode]);

  function handleApprove(contentItemId: string, targetId: string) {
    const next = approveDemoTarget(contentItemId, targetId);
    const approvedTarget = next?.targets.find((target) => target.id === targetId);
    if (!next || !approvedTarget || approvedTarget.status !== "APPROVED") {
      return Promise.reject(new Error("DEMO_TARGET_NOT_APPROVED"));
    }
    refresh();
    return Promise.resolve({ ...approvedTarget, status: "APPROVED" as const });
  }

  async function handleProductionApprove(contentItemId: string, targetId: string) {
    const record = productionRecords.find((candidate) => candidate.content.id === contentItemId);
    const target = record?.targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new Error("PUBLICATION_TARGET_NOT_FOUND");
    const approvedTarget = await approveContentTarget(contentItemId, target);
    if (approvedTarget.status !== "APPROVED") throw new Error("PUBLICATION_TARGET_NOT_APPROVED");
    const refreshed = await getContentRecord(contentItemId);
    setProductionRecords((current) => current.map((candidate) => candidate.content.id === contentItemId ? refreshed : candidate));
    return { ...approvedTarget, status: "APPROVED" as const };
  }

  async function handleProductionRetry(contentItemId: string, targetId: string) {
    const retriedTarget = await retryContentTarget(contentItemId, targetId);
    const refreshed = await getContentRecord(contentItemId);
    setProductionRecords((current) => current.map((candidate) => candidate.content.id === contentItemId ? refreshed : candidate));
    return { ...retriedTarget, status: "APPROVED" as const };
  }

  function hasActionableTarget(record: ContentRecord): boolean {
    return record.targets.some((target) => target.status === "PENDING_REVIEW" || target.status === "ERROR");
  }

  const pendingRecords = records.filter((record) =>
    record.targets.some((target) => target.status === "PENDING_REVIEW"),
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-5 border-b border-white/[0.08] pb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.24em] text-[#A8C7FF]/80">Cola de revisión</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Aprueba antes de publicar.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-400">Facebook e Instagram son decisiones separadas. Una aprobación no crea una publicación ni llama a Meta.</p>
        </div>
        <span className="rounded-full border border-[#FF4D00]/25 bg-[#FF4D00]/10 px-3 py-2 font-mono text-[0.62rem] uppercase tracking-[0.15em] text-orange-100/80">{isProductionMode ? productionRecords.filter((record) => record.targets.some((target) => target.status === "PENDING_REVIEW")).length : pendingRecords.length} pendientes</span>
      </div>

      {isLoading ? <p className="mt-8 text-sm text-slate-500">Cargando destinos locales…</p> : null}

      {productionError ? <p className="mt-8 rounded-xl border border-orange-200/20 bg-orange-200/[0.04] p-4 text-sm text-orange-100" role="alert">{productionError}</p> : null}

      {!isLoading && isProductionMode ? (
        <section className="mt-8 space-y-5">
          {productionRecords.filter(hasActionableTarget).map((record) => {
            const latestDraft = record.drafts.at(-1);
            return (
              <article key={record.content.id} className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5 sm:p-6">
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.17em] text-orange-200/75">Copy recibido · {record.content.service.replaceAll("_", " ")} · {record.content.niche.replaceAll("_", " ")}</p>
                <h2 className="mt-2 text-xl font-semibold text-white">{latestDraft?.headline ?? "Copy todavía no recibido"}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{latestDraft?.body ?? "Solicita el análisis a n8n desde el borrador antes de aprobar un destino."}</p>
                {latestDraft ? <p className="mt-3 text-xs text-cyan-100/75">CTA: {latestDraft.cta}</p> : null}
                <div className="mt-5">
                  <PublicationTargets
                    targets={record.targets}
                    disabled={!latestDraft || record.content.state !== "REVIEW"}
                    retryDisabled={!latestDraft}
                    onApprove={(targetId) => handleProductionApprove(record.content.id, targetId)}
                    onRetry={(targetId) => handleProductionRetry(record.content.id, targetId)}
                  />
                </div>
                <p className="mt-4 rounded-xl border border-orange-200/15 bg-orange-200/[0.035] p-4 text-xs leading-5 text-slate-400">La aprobación se registra en Supabase por destino. Publicar sigue requiriendo una orden separada y no se ejecuta aquí.</p>
              </article>
            );
          })}
          {productionRecords.every((record) => !hasActionableTarget(record)) ? (
            <section className="rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10"><p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Nada pendiente</p><h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">La cola real está vacía.</h2><p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">Cuando un copy llegue a revisión, sus destinos aparecerán aquí de forma independiente.</p></section>
          ) : null}
        </section>
      ) : null}

      {!isLoading && !isProductionMode && pendingRecords.length > 0 ? (
        <section className="mt-8 space-y-5">
          {pendingRecords.map((record) => (
            <article key={record.content.id} className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.17em] text-orange-200/75">Copy final · {record.content.state === "DRAFT" ? "falta enviar a revisión" : "requiere decisión"}</p>
                  <h2 className="mt-2 text-xl font-semibold text-white">{record.finalCopy.headline}</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{record.finalCopy.body}</p>
                  <p className="mt-3 text-xs text-cyan-100/75">CTA: {record.finalCopy.cta}</p>
                </div>
                <Link href={`/drafts/${record.content.id}`} className="inline-flex shrink-0 rounded-lg border border-cyan-200/25 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-200/10">Abrir borrador</Link>
              </div>
              <div className="mt-5">
                <PublicationTargets
                  targets={record.targets}
                  disabled={record.content.state !== "REVIEW"}
                  onApprove={(targetId) => handleApprove(record.content.id, targetId)}
                />
              </div>
              <div className="mt-4 rounded-xl border border-orange-200/15 bg-orange-200/[0.035] p-4 text-xs leading-5 text-slate-400">
                {record.content.state === "DRAFT" ? "Los controles permanecen bloqueados hasta que envíes este copy a revisión desde su borrador." : "Publicar ahora permanece deshabilitado en esta interfaz demo. La aprobación solo registra la autorización local; el puente de servidor requiere staging."}
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {!isLoading && !isProductionMode && pendingRecords.length === 0 ? (
        <section className="mt-8 rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Nada pendiente</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">La cola de revisión está vacía.</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">Cuando envíes un borrador a revisión aparecerán aquí sus dos destinos, cada uno con su propia decisión.</p>
          <Link href="/drafts" className="mt-7 inline-flex rounded-xl border border-cyan-200/25 px-4 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/10">Ver borradores</Link>
        </section>
      ) : null}
    </div>
  );
}
