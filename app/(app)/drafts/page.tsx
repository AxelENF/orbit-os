"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";

import { readDemoDrafts, type DemoDraftRecord } from "@/lib/demo/draft-store";

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

export default function DraftsPage() {
  const [drafts, setDrafts] = useState<DemoDraftRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDrafts(readDemoDrafts());
      setIsLoading(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-6 border-b border-white/[0.08] pb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.24em] text-cyan-200/80">Borradores de copy</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Texto con contexto, listo para una decisión humana.</h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-400">Cada registro conserva el export final, el brief, dos alternativas locales y la separación entre Facebook e Instagram.</p>
        </div>
        <Link href="/library/new" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] shadow-lg shadow-orange-300/10 transition hover:bg-orange-200">+ Nuevo creativo</Link>
      </div>

      {isLoading ? <p className="mt-8 text-sm text-slate-500">Cargando borradores locales…</p> : null}

      {!isLoading && drafts.length > 0 ? (
        <section className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {drafts.map((draft) => (
            <article key={draft.content.id} className="overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0b1429]">
              <div className="relative aspect-[4/5] overflow-hidden bg-[#081127]">
                <Image src={draft.previewDataUrl} alt={`Preview de ${draft.filename}`} fill sizes="(min-width: 1280px) 30vw, (min-width: 640px) 45vw, 100vw" unoptimized className="object-cover" />
              </div>
              <div className="space-y-4 p-5">
                <div className="flex items-center justify-between gap-3">
                  <span className="rounded-full border border-cyan-200/20 bg-cyan-200/[0.05] px-2 py-1 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-cyan-100/80">{statusLabels[draft.content.state]}</span>
                  <span className="text-xs text-slate-500">Demo local</span>
                </div>
                <div>
                  <h2 className="truncate text-sm font-semibold text-white">{draft.filename}</h2>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{draft.content.service.replaceAll("_", " ")} · {draft.content.niche.replaceAll("_", " ")} · {draft.content.contentType.replaceAll("_", " ")}</p>
                </div>
                <div className="flex items-center justify-between border-t border-white/[0.08] pt-4 text-xs text-slate-500">
                  <span>{draft.drafts.length} alternativas</span>
                  <span>{draft.targets.filter((target) => target.status === "APPROVED").length}/2 destinos aprobados</span>
                </div>
                <Link href={`/drafts/${draft.content.id}`} className="inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-cyan-200/25 px-3 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/10">Abrir borrador →</Link>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {!isLoading && drafts.length === 0 ? (
        <section className="mt-8 rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-cyan-200/10 text-2xl text-cyan-100 ring-1 ring-cyan-200/20">✦</div>
          <p className="mt-6 font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Sin borradores todavía</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">El primer copy empieza con un export final.</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">Sube un creativo desde Canva y completa el brief. En demo local se crearán dos opciones sin llamar a IA ni a servicios externos.</p>
          <Link href="/library/new" className="mt-7 inline-flex rounded-xl border border-cyan-200/25 px-4 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/10">Crear primer borrador</Link>
        </section>
      ) : null}
    </div>
  );
}
