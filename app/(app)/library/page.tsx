import Link from "next/link";

const lanes = [
  { title: "Controlar", description: "POS, inventario y operación visible.", tone: "text-cyan-200" },
  { title: "Captar", description: "Web, CRM y oportunidades calificadas.", tone: "text-blue-200" },
  { title: "Automatizar", description: "Bots, citas y tareas que avanzan.", tone: "text-orange-200" },
];

export default function LibraryPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-6 border-b border-white/[0.08] pb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.24em] text-cyan-200/80">Biblioteca de contenido</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
            Un lugar para cada creativo que sí tiene contexto.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-400">
            Sube los exports finales de Canva, segmenta la oferta y deja lista la información que la IA puede usar sin inventar.
          </p>
        </div>
        <Link
          href="/library/new"
          className="inline-flex min-h-12 items-center justify-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] shadow-lg shadow-orange-300/10 transition hover:bg-orange-200"
        >
          + Subir creativo
        </Link>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {lanes.map((lane, index) => (
          <div key={lane.title} className="rounded-2xl border border-white/[0.08] bg-[#0b1429] p-5">
            <div className="flex items-center justify-between">
              <span className={`font-mono text-[0.65rem] uppercase tracking-[0.2em] ${lane.tone}`}>0{index + 1}</span>
              <span className="size-2 rounded-full bg-white/15" aria-hidden="true" />
            </div>
            <h2 className="mt-7 text-lg font-semibold text-white">{lane.title}</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">{lane.description}</p>
          </div>
        ))}
      </div>

      <section className="mt-8 rounded-3xl border border-dashed border-cyan-200/20 bg-cyan-200/[0.025] px-6 py-14 text-center sm:px-10">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-cyan-200/10 text-2xl text-cyan-100 ring-1 ring-cyan-200/20">✦</div>
        <p className="mt-6 font-mono text-[0.65rem] uppercase tracking-[0.22em] text-cyan-200/75">Sin activos todavía</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">Empieza con tu primer export de Canva</h2>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">
          El archivo se queda en este navegador durante el modo demo. Cuando conectemos Supabase, se guardará en tu biblioteca privada con su historial.
        </p>
        <Link href="/library/new" className="mt-7 inline-flex rounded-xl border border-cyan-200/25 px-4 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/10">
          Crear primer registro
        </Link>
      </section>
    </div>
  );
}
