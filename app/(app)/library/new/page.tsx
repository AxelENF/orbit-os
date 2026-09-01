import Link from "next/link";

import { ContentForm } from "@/components/content/content-form";

export default function NewContentPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex flex-col gap-3 border-b border-white/[0.08] pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/library" className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-cyan-200/75 hover:text-cyan-100">
            ← Biblioteca
          </Link>
          <p className="mt-6 font-mono text-[0.68rem] uppercase tracking-[0.24em] text-orange-200/80">Nuevo creativo</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-white">Dale contexto antes de pedir copy.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Un brief claro protege tu marca y le da a n8n lo necesario para redactar una publicación útil, no una lista genérica de funciones.
          </p>
        </div>
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-slate-600">Paso 01 / 03</span>
      </div>
      <ContentForm />
    </div>
  );
}
