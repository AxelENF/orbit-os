import Link from "next/link";

import { ContentForm } from "@/components/content/content-form";
import { AppIcon } from "@/components/layout/app-icon";

export default function NewContentPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex flex-col gap-5 border-b border-white/[0.08] pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/library" className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-[#A8C7FF]/75 hover:text-white">
            ← Campañas
          </Link>
          <p className="mt-6 font-mono text-[0.68rem] uppercase tracking-[0.24em] text-[#FF8B68]">Nueva campaña</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Dale dirección antes de pedir copy.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Sube el export final de Canva, define el resultado que buscas y deja un registro que puedas revisar antes de publicar.
          </p>
        </div>
        <div className="flex items-center gap-2 text-right"><span className="size-2 rounded-full bg-[#FF4D00]" aria-hidden="true" /><span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-slate-500">Brief · Creativo · Revisión</span></div>
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_260px] xl:items-start">
        <ContentForm />
        <aside className="order-first space-y-4 xl:order-last xl:sticky xl:top-8">
          <section className="rounded-2xl border border-[#A8C7FF]/15 bg-[#091735] p-5">
            <div className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-xl bg-[#FF4D00]/15 text-[#FF8B68]"><AppIcon name="spark" size={17} /></span><p className="text-sm font-semibold text-white">Ruta de campaña</p></div>
            <ol className="mt-5 space-y-4 text-xs">
              <li className="flex gap-3"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#FF4D00] text-[0.65rem] font-bold text-white">1</span><span className="pt-0.5 text-slate-300">Clasifica la oferta y el nicho.</span></li>
              <li className="flex gap-3"><span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[#A8C7FF]/30 text-[0.65rem] font-bold text-[#A8C7FF]">2</span><span className="pt-0.5 text-slate-400">Adjunta el export terminado.</span></li>
              <li className="flex gap-3"><span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[#A8C7FF]/30 text-[0.65rem] font-bold text-[#A8C7FF]">3</span><span className="pt-0.5 text-slate-400">Revisa el copy antes de aprobar.</span></li>
            </ol>
          </section>
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-[#A8C7FF]/70">Regla SnapGad</p>
            <p className="mt-3 text-sm leading-6 text-slate-300">La IA propone. La marca y la aprobación final siempre permanecen contigo.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
