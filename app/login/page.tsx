"use client";

import { FormEvent, useState } from "react";

import { createSupabaseBrowserClient, hasSupabaseBrowserConfig } from "@/lib/supabase/client";

function safeNextPath(): string {
  if (typeof window === "undefined") return "/library";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/library";
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) {
        setError("No se pudo iniciar sesión. Verifica tus credenciales.");
        return;
      }
      window.location.assign(safeNextPath());
    } catch {
      setError("La autenticación no está configurada en este entorno.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!hasSupabaseBrowserConfig()) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#060c1b] px-6 text-slate-100">
        <section className="w-full max-w-md rounded-3xl border border-white/[0.08] bg-[#0b1429] p-7">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-orange-300/85">SnapGad · Content OS</p>
          <h1 className="mt-4 text-2xl font-semibold text-white">Modo demo local</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">Configura Supabase público para habilitar el inicio de sesión y el portal real.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#060c1b] px-6 text-slate-100">
      <form className="w-full max-w-md rounded-3xl border border-white/[0.08] bg-[#0b1429] p-7 shadow-2xl shadow-black/20" onSubmit={handleSubmit}>
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-orange-300/85">SnapGad · Content OS</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">Inicia sesión</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">Acceso interno para cargar creativos y aprobar destinos.</p>
        <label className="mt-7 block text-sm font-semibold text-slate-100" htmlFor="email">Correo
          <input id="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-[#0c1427] px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/80" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="mt-4 block text-sm font-semibold text-slate-100" htmlFor="password">Contraseña
          <input id="password" className="mt-2 w-full rounded-xl border border-slate-700 bg-[#0c1427] px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/80" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Validando…" : "Entrar"}
        </button>
        {error ? <p className="mt-4 text-sm text-orange-200" role="alert">{error}</p> : null}
      </form>
    </main>
  );
}
