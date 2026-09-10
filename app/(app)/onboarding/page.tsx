"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  OrganizationSwitcher,
  parseOrganizationsResponse,
  type OrganizationOption,
} from "@/components/aias/organization-switcher";
import { AiasProfileForm } from "@/components/aias/profile-form";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

type OrganizationsResponse = {
  organizations: OrganizationOption[];
  activeOrganizationId: string | null;
};

const roleLabels: Record<OrganizationOption["role"], string> = {
  owner: "Propietario",
  editor: "Editor",
  reviewer: "Revisor",
  viewer: "Consulta",
};

async function loadOrganizations(): Promise<OrganizationsResponse> {
  const response = await fetch("/api/organizations", { cache: "no-store" });
  if (!response.ok) throw new Error("ORGANIZATION_LOOKUP_FAILED");
  const payload = parseOrganizationsResponse(await response.json());
  if (!payload) throw new Error("INVALID_ORGANIZATIONS_RESPONSE");
  return payload;
}

export default function OnboardingPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadOrganizations()
      .then((payload) => {
        if (cancelled) return;
        setOrganizations(payload.organizations);
        setActiveOrganizationId(payload.activeOrganizationId);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudieron cargar tus organizaciones.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="border-b border-white/[0.08] pb-8">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.24em] text-[#A8C7FF]/75">
          AIAS / primer paso
        </p>
        <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.045em] text-white sm:text-4xl">
              Pon tu operación en contexto
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-400">
              Empieza por elegir el espacio de trabajo que representa tu negocio. Después podrás
              completar su perfil y mantener cada campaña dentro de su propia operación.
            </p>
          </div>
          <Link
            href="/settings/organizations"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#A8C7FF]/25 px-4 text-sm font-semibold text-[#A8C7FF] transition hover:border-[#A8C7FF]/55 hover:bg-[#A8C7FF]/10"
          >
            Abrir gestión de organizaciones
          </Link>
        </div>
      </header>

      {!isLoading && !error ? (
        <section className="mt-7">
          <OrganizationSwitcher
            key={organizations.map(({ id }) => id).join(",")}
            organizations={organizations}
            activeOrganizationId={activeOrganizationId}
            onOrganizationChange={setActiveOrganizationId}
          />
        </section>
      ) : null}

      {!isLoading && !error && activeOrganizationId ? (
        <AiasProfileForm
          organizationId={activeOrganizationId}
          enabled={hasSupabaseBrowserConfig()}
        />
      ) : null}

      {error ? (
        <p className="mt-5 rounded-2xl border border-red-200/20 bg-red-200/[0.05] p-4 text-sm text-red-100" role="alert">
          {error}
        </p>
      ) : null}

      {isLoading ? <p className="mt-8 text-sm text-slate-500">Cargando tus organizaciones…</p> : null}

      {!isLoading && organizations.length === 0 ? (
        <section className="mt-8 grid gap-6 rounded-3xl border border-dashed border-[#315bd6]/40 bg-[#091735] p-6 sm:grid-cols-[1fr_auto] sm:items-center sm:p-8">
          <div>
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-[#FF8B68]">
              Espacio pendiente
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-white">
              Todavía no tienes una organización.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">
              {hasSupabaseBrowserConfig()
                ? "La creación persistente requiere el flujo de administración correspondiente. Puedes revisar la gestión disponible mientras ese paso se habilita."
                : "Estás en demo local. Conecta Supabase para cargar organizaciones reales y completar el perfil AIAS."}
            </p>
          </div>
          <button
            type="button"
            disabled
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 px-4 text-sm font-semibold text-slate-500"
          >
            Crear organización (próximamente)
          </button>
        </section>
      ) : null}

      {!isLoading && organizations.length > 0 ? (
        <section className="mt-8">
          <div className="flex flex-col gap-2 border-b border-white/[0.08] pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-[#A8C7FF]/65">
                Espacios disponibles
              </p>
              <h2 className="mt-1 text-xl font-semibold text-white">Elige dónde trabajar</h2>
            </div>
            <span className="text-xs text-slate-500">{organizations.length} organización(es)</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {organizations.map((organization) => {
              const isActive = organization.id === activeOrganizationId;
              return (
                <article
                  key={organization.id}
                  className={`rounded-2xl border p-5 transition ${
                    isActive
                      ? "border-[#FF4D00]/45 bg-[#FF4D00]/[0.07]"
                      : "border-white/[0.08] bg-[#091735]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-white">{organization.name}</h3>
                      <p className="mt-1 text-xs text-slate-500">{roleLabels[organization.role]}</p>
                    </div>
                    {isActive ? (
                      <span className="rounded-full border border-[#FF4D00]/30 bg-[#FF4D00]/10 px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-[0.12em] text-orange-100">
                        Activa
                      </span>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
