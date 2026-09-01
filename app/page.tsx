import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#060c1b] px-6 py-8 text-slate-100 sm:px-10 sm:py-12">
      <main className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-6xl flex-col justify-between rounded-[2rem] border border-white/[0.08] bg-[radial-gradient(circle_at_78%_18%,rgba(38,130,255,0.16),transparent_32%),linear-gradient(135deg,#0a1734_0%,#071025_56%,#060b18_100%)] p-7 shadow-2xl shadow-black/25 sm:p-12">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-orange-300/85">SnapGad</p>
            <p className="mt-1 text-xl font-semibold tracking-tight text-white">Content OS</p>
          </div>
          <span className="rounded-full border border-cyan-200/20 bg-cyan-200/[0.05] px-3 py-1.5 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-100/80">Demo local</span>
        </div>

        <div className="max-w-3xl py-20">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/75">Tu línea de producción de marketing</p>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.02] tracking-[-0.06em] text-white sm:text-7xl">
            Creativos con contexto.<br /><span className="text-orange-300">Publicaciones con control.</span>
          </h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-slate-400 sm:text-lg">
            Sube el export final de Canva, define para quién es y prepara el siguiente paso de tu automatización sin perder la voz de SnapGad.
          </p>
          <Link href="/library" className="mt-9 inline-flex min-h-12 items-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] shadow-lg shadow-orange-300/10 transition hover:bg-orange-200">
            Abrir biblioteca →
          </Link>
        </div>

        <div className="grid gap-3 border-t border-white/[0.08] pt-6 text-sm text-slate-400 sm:grid-cols-3">
          <span><b className="text-white">01</b> Clasifica el creativo</span>
          <span><b className="text-white">02</b> Genera borradores</span>
          <span><b className="text-white">03</b> Aprueba antes de publicar</span>
        </div>
      </main>
    </div>
  );
}
