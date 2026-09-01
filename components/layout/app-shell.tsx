import Link from "next/link";

const navigation = [
  { href: "/library", label: "Biblioteca", eyebrow: "Assets" },
  { href: "/library/new", label: "Subir creativo", eyebrow: "Nuevo" },
  { href: "/drafts", label: "Borradores", eyebrow: "Próximo" },
  { href: "/review", label: "Revisión", eyebrow: "Control" },
  { href: "/history", label: "Historial", eyebrow: "Trazabilidad" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#060c1b] text-slate-100">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 border-r border-white/[0.07] bg-[#071025]/95 px-6 py-7 lg:block">
        <Link href="/" className="group block" aria-label="Ir al inicio de SnapGad Content OS">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.28em] text-orange-300/85">
            SnapGad
          </p>
          <p className="mt-1 text-xl font-semibold tracking-tight text-white group-hover:text-cyan-100">
            Content OS
          </p>
          <p className="mt-2 max-w-[13rem] text-xs leading-5 text-slate-500">
            Creativos con contexto. Publicaciones con control.
          </p>
        </Link>

        <nav className="mt-12 space-y-2" aria-label="Navegación principal">
          {navigation.map((item, index) => (
            <Link
              key={item.href}
              href={item.href}
              className="group flex items-center gap-3 rounded-xl border border-transparent px-3 py-3 transition hover:border-cyan-200/15 hover:bg-cyan-200/[0.05]"
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-white/[0.04] font-mono text-xs text-slate-500 transition group-hover:bg-orange-300/15 group-hover:text-orange-200">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-200 group-hover:text-white">
                  {item.label}
                </span>
                <span className="block text-[0.65rem] uppercase tracking-[0.14em] text-slate-600">
                  {item.eyebrow}
                </span>
              </span>
            </Link>
          ))}
        </nav>

        <div className="absolute inset-x-6 bottom-7 rounded-2xl border border-orange-300/15 bg-orange-300/[0.05] p-4">
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-orange-200/75">
            Modo actual
          </p>
          <p className="mt-2 text-sm font-semibold text-white">Demo local</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Sin llamadas externas. Tu aprobación siempre es el siguiente paso.
          </p>
        </div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-10 border-b border-white/[0.07] bg-[#060c1b]/85 px-5 py-4 backdrop-blur-xl sm:px-8 lg:hidden">
          <div className="flex items-center justify-between gap-4">
            <Link href="/" className="min-w-0">
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-orange-300/85">SnapGad</p>
              <p className="truncate text-lg font-semibold text-white">Content OS</p>
            </Link>
            <Link
              href="/library/new"
              className="rounded-lg bg-orange-300 px-3 py-2 text-xs font-bold text-[#17110a]"
            >
              Subir creativo
            </Link>
          </div>
        </header>
        <main className="min-h-screen px-5 py-8 sm:px-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
