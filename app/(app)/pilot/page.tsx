"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { PilotReadiness } from "@/lib/pilot/readiness";

const statusStyle = {
  READY: "border-emerald-200/25 bg-emerald-200/[0.08] text-emerald-100",
  ACTION_REQUIRED: "border-orange-200/25 bg-orange-200/[0.08] text-orange-100",
  BLOCKED: "border-red-200/20 bg-red-200/[0.06] text-red-100",
} as const;

const statusLabel = {
  READY: "Listo",
  ACTION_REQUIRED: "Acción requerida",
  BLOCKED: "Bloqueado",
} as const;

export default function PilotPage() {
  const [readiness, setReadiness] = useState<PilotReadiness | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/pilot/readiness", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("READINESS_UNAVAILABLE");
        setReadiness(await response.json() as PilotReadiness);
      })
      .catch(() => setError(true));
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="border-b border-white/[0.08] pb-8">
        <p className="font-mono text-[0.68rem] uppercase tracking-[0.24em] text-[#A8C7FF]/80">Piloto personal</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Antes de automatizar, confirma la base.</h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-400">Este tablero sólo muestra postura de configuración. No revela secretos, no prueba proveedores y no publica en Meta.</p>
      </div>

      {!readiness && !error ? <p className="mt-8 text-sm text-slate-500">Leyendo estado del piloto…</p> : null}
      {error ? <p className="mt-8 rounded-xl border border-orange-200/20 bg-orange-200/[0.04] p-4 text-sm text-orange-100">No se pudo leer la postura del piloto. Recarga la pantalla antes de cambiar configuración.</p> : null}

      {readiness ? <>
        <section className="mt-8 rounded-3xl border border-[#315bd6]/35 bg-[radial-gradient(circle_at_80%_0%,rgba(49,91,214,0.18),transparent_42%),#091735] p-6 sm:p-8">
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-[#A8C7FF]/75">Siguiente acción</p>
          <p className="mt-3 max-w-3xl text-xl font-semibold tracking-[-0.025em] text-white">{readiness.nextAction}</p>
          <p className="mt-4 text-xs uppercase tracking-[0.14em] text-slate-500">Modo actual: {readiness.mode}</p>
        </section>
        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          {readiness.checks.map((check) => <article key={check.id} className="rounded-2xl border border-white/[0.08] bg-[#091735] p-5">
            <div className="flex items-start justify-between gap-4"><h2 className="text-base font-semibold text-white">{check.title}</h2><span className={`shrink-0 rounded-full border px-2.5 py-1 text-[0.58rem] font-bold uppercase tracking-[0.12em] ${statusStyle[check.status]}`}>{statusLabel[check.status]}</span></div>
            <p className="mt-3 text-sm leading-6 text-slate-400">{check.detail}</p>
          </article>)}
        </section>
        <div className="mt-8 flex flex-wrap gap-3"><Link href="/library/new" className="inline-flex min-h-11 items-center rounded-xl bg-[#FF4D00] px-4 text-sm font-bold text-white transition hover:bg-[#ff6a2f]">Crear campaña</Link><Link href="/settings/organizations" className="inline-flex min-h-11 items-center rounded-xl border border-[#A8C7FF]/25 px-4 text-sm font-semibold text-[#A8C7FF] transition hover:bg-[#A8C7FF]/10">Ver organizaciones</Link></div>
      </> : null}
    </div>
  );
}
