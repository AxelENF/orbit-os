"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { PublicationTargets } from "@/components/content/publication-targets";
import {
  approveDemoTarget,
  readDemoDrafts,
  type DemoDraftRecord,
} from "@/lib/demo/draft-store";

export default function ReviewPage() {
  const [records, setRecords] = useState<DemoDraftRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  function refresh() {
    setRecords(readDemoDrafts());
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refresh();
      setIsLoading(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function handleApprove(contentItemId: string, targetId: string) {
    const next = approveDemoTarget(contentItemId, targetId);
    if (next) refresh();
  }

  const pendingRecords = records.filter((record) =>
    record.targets.some((target) => target.status === "PENDING_REVIEW"),
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-5 border-b border-white/[0.08] pb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.24em] text-cyan-200/80">Cola de revisión</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Aprueba cada red cuando el copy esté listo.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-400">Facebook e Instagram son decisiones separadas. Una aprobación no crea una publicación ni llama a Meta.</p>
        </div>
        <span className="rounded-full border border-orange-200/20 bg-orange-200/[0.05] px-3 py-2 font-mono text-[0.62rem] uppercase tracking-[0.15em] text-orange-100/80">{pendingRecords.length} pendientes · Demo local</span>
      </div>

      {isLoading ? <p className="mt-8 text-sm text-slate-500">Cargando destinos locales…</p> : null}

      {!isLoading && pendingRecords.length > 0 ? (
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
                {record.content.state === "DRAFT" ? "Los controles permanecen bloqueados hasta que envíes este copy a revisión desde su borrador." : "Publicar ahora está deshabilitado hasta que Task 7 conecte un workflow probado. La aprobación solo registra la autorización local."}
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {!isLoading && pendingRecords.length === 0 ? (
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
