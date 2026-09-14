"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { RuntimeMode } from "@/components/layout/runtime-mode";
import { AppIcon, type IconName } from "@/components/layout/app-icon";
import { OrganizationSwitcher } from "@/components/aias/organization-switcher";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

const navigation = [
  { href: "/", label: "Inicio", eyebrow: "Resumen", icon: "home" },
  { href: "/library", label: "Campañas", eyebrow: "Workspace", icon: "campaigns" },
  { href: "/library/new", label: "Nueva campaña", eyebrow: "Crear", icon: "plus" },
  { href: "/review", label: "Revisión", eyebrow: "Tu aprobación", icon: "review" },
  { href: "/history", label: "Resultados", eyebrow: "Aprendizaje", icon: "results" },
  { href: "/pilot", label: "Piloto", eyebrow: "Salida real", icon: "check" },
  { href: "/settings/organizations", label: "Configuración", eyebrow: "Organización", icon: "settings" },
  { href: "/tools/logo-studio", label: "Logo Studio", eyebrow: "Herramientas", icon: "image" },
] satisfies Array<{ href: string; label: string; eyebrow: string; icon: IconName }>;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Navigation({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-1" aria-label="Navegación principal">
      {navigation.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`group flex items-center gap-3 rounded-xl border px-3 py-3 transition ${
              active
                ? "border-[#FF4D00]/35 bg-[#FF4D00]/10 text-white shadow-[inset_3px_0_0_#FF4D00]"
                : "border-transparent text-slate-400 hover:border-white/10 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition ${active ? "bg-[#FF4D00] text-white" : "bg-white/[0.04] text-slate-500 group-hover:bg-[#1748D2]/40 group-hover:text-[#A8C7FF]"}`}>
              <AppIcon name={item.icon} size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className={`block text-[0.62rem] uppercase tracking-[0.16em] ${active ? "text-orange-200/75" : "text-slate-600"}`}>
                {item.eyebrow}
              </span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#07112E] text-[#F4F7FC]">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 flex-col border-r border-white/[0.08] bg-[#091735] px-6 py-7 lg:flex">
        <Link href="/" className="group block shrink-0" aria-label="Ir al inicio de SnapGad Content OS">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.28em] text-[#FF4D00]">SnapGad</p>
          <p className="mt-1 text-xl font-semibold tracking-[-0.03em] text-white group-hover:text-[#A8C7FF]">Content OS</p>
          <p className="mt-2 max-w-[13rem] text-xs leading-5 text-slate-500">Convierte creativos en campañas que puedes controlar.</p>
        </Link>

        <div className="mt-12 shrink-0 rounded-2xl border border-[#2C5ED8]/30 bg-[#12327A]/25 p-4">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-[#A8C7FF]">Workspace</p>
          <p className="mt-2 text-sm font-semibold text-white">SnapGad Technology</p>
          <p className="mt-1 text-xs text-slate-500">1 organización activa</p>
        </div>

        <div className="mt-7 min-h-0 flex-1 overflow-y-auto"><Navigation pathname={pathname} /></div>

        <details className="mt-4 shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <summary className="cursor-pointer list-none text-xs font-semibold text-slate-300">Estado del sistema</summary>
          <div className="mt-3 border-t border-white/10 pt-3">
            <RuntimeMode />
            <p className="mt-1 text-xs leading-5 text-slate-500">Publicamos automático cuando el diagnóstico no marca riesgo; si lo marca, pedimos tu aprobación.</p>
          </div>
        </details>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#07112E]/90 px-5 py-4 backdrop-blur-xl sm:px-8 lg:hidden">
          <div className="flex items-center justify-between gap-4">
            <Link href="/" className="min-w-0" onClick={() => setMenuOpen(false)}>
              <p className="text-[0.6rem] font-bold uppercase tracking-[0.2em] text-[#FF4D00]">SnapGad</p>
              <p className="truncate text-lg font-semibold text-white">Content OS</p>
            </Link>
            <button
              type="button"
              aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
              className="flex size-10 items-center justify-center rounded-xl border border-white/15 text-lg text-white transition hover:border-[#FF4D00]/60 hover:text-[#FFB39B]"
            >
              <AppIcon name={menuOpen ? "close" : "menu"} size={18} />
            </button>
          </div>
          {menuOpen ? <div className="mt-5 border-t border-white/10 pt-4"><Navigation pathname={pathname} onNavigate={() => setMenuOpen(false)} /></div> : null}
        </header>
        <main className="min-h-screen px-5 py-8 sm:px-8 sm:py-10">
          {hasSupabaseBrowserConfig() &&
          pathname !== "/onboarding" &&
          !pathname.startsWith("/onboarding/") &&
          !pathname.startsWith("/settings/organizations") &&
          !pathname.startsWith("/tools/logo-studio") ? (
            <div className="mx-auto mb-8 w-full max-w-7xl">
              <OrganizationSwitcher />
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
