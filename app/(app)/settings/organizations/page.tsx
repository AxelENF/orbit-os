"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  OrganizationSwitcher,
  parseOrganizationsResponse,
  type OrganizationOption,
} from "@/components/aias/organization-switcher";
import { AiasProfileForm } from "@/components/aias/profile-form";
import { canManageConnections } from "@/lib/organizations/permissions";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

type OrganizationsResponse = {
  organizations: OrganizationOption[];
  activeOrganizationId: string | null;
};

type MetaConnectionStatusCode = "NOT_CONNECTED" | "ACTIVE" | "REVOKED" | "ERROR";

type MetaConnectionStatus = {
  status: MetaConnectionStatusCode;
  facebookPageName?: string;
  hasInstagram: boolean;
};

type MetaConnectionState = {
  status: MetaConnectionStatus;
  isLoading?: boolean;
  isDisconnecting?: boolean;
  error?: boolean;
};

const disconnectedMetaStatus: MetaConnectionStatus = {
  status: "NOT_CONNECTED",
  hasInstagram: false,
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

function parseMetaConnectionStatus(value: unknown): MetaConnectionStatus | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    status?: unknown;
    facebookPageName?: unknown;
    hasInstagram?: unknown;
  };
  if (
    candidate.status !== "NOT_CONNECTED" &&
    candidate.status !== "ACTIVE" &&
    candidate.status !== "REVOKED" &&
    candidate.status !== "ERROR"
  ) return null;
  return {
    status: candidate.status,
    ...(typeof candidate.facebookPageName === "string" ? { facebookPageName: candidate.facebookPageName } : {}),
    hasInstagram: candidate.hasInstagram === true,
  };
}

async function loadMetaConnectionStatus(organizationId: string): Promise<MetaConnectionStatus> {
  const response = await fetch(
    `/api/integrations/meta/status?organizationId=${encodeURIComponent(organizationId)}`,
    { cache: "no-store", credentials: "same-origin" },
  );
  if (!response.ok) throw new Error("META_STATUS_LOOKUP_FAILED");
  const status = parseMetaConnectionStatus(await response.json());
  if (!status) throw new Error("INVALID_META_STATUS_RESPONSE");
  return status;
}

export default function OrganizationsSettingsPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metaConnectionStates, setMetaConnectionStates] = useState<Record<string, MetaConnectionState>>({});
  const isProductionMode = hasSupabaseBrowserConfig();

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

  useEffect(() => {
    let cancelled = false;

    if (!isProductionMode || organizations.length === 0) return () => {
      cancelled = true;
    };

    Promise.all(
      organizations.map(async (organization): Promise<[string, MetaConnectionState]> => {
        try {
          return [organization.id, { status: await loadMetaConnectionStatus(organization.id) }];
        } catch {
          return [organization.id, { status: disconnectedMetaStatus, error: true }];
        }
      }),
    ).then((entries) => {
      if (!cancelled) setMetaConnectionStates(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [isProductionMode, organizations]);

  async function handleDisconnect(organizationId: string) {
    setMetaConnectionStates((current) => ({
      ...current,
      [organizationId]: {
        ...(current[organizationId] ?? { status: disconnectedMetaStatus }),
        isDisconnecting: true,
        error: undefined,
      },
    }));

    try {
      const response = await fetch("/api/integrations/meta/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) throw new Error("META_DISCONNECT_FAILED");
      const status = await loadMetaConnectionStatus(organizationId);
      setMetaConnectionStates((current) => ({
        ...current,
        [organizationId]: { status },
      }));
    } catch {
      setMetaConnectionStates((current) => ({
        ...current,
        [organizationId]: {
          ...(current[organizationId] ?? { status: disconnectedMetaStatus }),
          isDisconnecting: false,
          error: true,
        },
      }));
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="flex flex-col gap-5 border-b border-white/[0.08] pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.24em] text-[#A8C7FF]/75">
            Configuración / AIAS
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.045em] text-white">Organizaciones</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Cambia el espacio activo y revisa quién puede trabajar en cada operación. Los perfiles
            AIAS se mantienen separados por organización.
          </p>
        </div>
        <Link
          href="/onboarding"
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 px-4 text-sm font-semibold text-slate-300 transition hover:border-[#A8C7FF]/45 hover:text-white"
        >
          Ver onboarding
        </Link>
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

      {isLoading ? <p className="mt-8 text-sm text-slate-500">Cargando organizaciones…</p> : null}

      {!isLoading && organizations.length === 0 ? (
        <section className="mt-8 rounded-3xl border border-dashed border-[#315bd6]/40 bg-[#091735] px-6 py-12 text-center sm:px-10">
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-[#FF8B68]">Sin espacios todavía</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.035em] text-white">No hay organizaciones accesibles todavía.</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-400">
            {hasSupabaseBrowserConfig()
              ? "La creación persistente se habilitará cuando esté disponible el contrato de administración."
              : "Estás en demo local. Conecta Supabase para administrar organizaciones reales."}
          </p>
          <button
            type="button"
            disabled
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 px-4 text-sm font-semibold text-slate-500"
          >
            Crear organización (próximamente)
          </button>
        </section>
      ) : null}

      {!isLoading && organizations.length > 0 ? (
        <section className="mt-8">
          <div className="flex items-end justify-between gap-4 border-b border-white/[0.08] pb-4">
            <div>
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-[#A8C7FF]/65">Acceso actual</p>
              <h2 className="mt-1 text-xl font-semibold text-white">Tus organizaciones</h2>
            </div>
            <button
              type="button"
              disabled
              className="hidden min-h-10 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-500 sm:inline-flex sm:items-center"
            >
              Crear organización (próximamente)
            </button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {organizations.map((organization) => {
              const isActive = organization.id === activeOrganizationId;
              const connection = metaConnectionStates[organization.id] ?? {
                status: disconnectedMetaStatus,
                isLoading: isProductionMode,
              };
              const isConnected = connection.status.status === "ACTIVE";
              const isConnectionError = connection.status.status === "ERROR";
              return (
                <article
                  key={organization.id}
                  className={`rounded-2xl border p-5 transition ${
                    isActive
                      ? "border-[#FF4D00]/45 bg-[#FF4D00]/[0.07]"
                      : "border-white/[0.08] bg-[#091735]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-base font-semibold text-white">{organization.name}</h3>
                      <p className="mt-1 text-xs text-slate-500">{roleLabels[organization.role]}</p>
                    </div>
                    <span
                      className={`rounded-full border px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-[0.12em] ${
                        isActive
                          ? "border-[#FF4D00]/30 bg-[#FF4D00]/10 text-orange-100"
                          : "border-white/10 text-slate-500"
                      }`}
                    >
                      {isActive ? "Activa" : "Disponible"}
                    </span>
                  </div>
                  <p className="mt-5 border-t border-white/[0.08] pt-4 text-xs leading-5 text-slate-500">
                    Los cambios de perfil y publicación respetan este espacio de trabajo.
                  </p>
                  <div className="mt-4 border-t border-white/[0.08] pt-4" aria-label={`Conexión Meta de ${organization.name}`}>
                    <p className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-[#A8C7FF]/70">Meta</p>
                    {connection.isLoading ? <p className="mt-2 text-sm text-slate-400">Consultando conexión…</p> : null}
                    {!connection.isLoading && connection.error ? <p className="mt-2 text-sm text-orange-100">No se pudo consultar la conexión.</p> : null}
                    {!connection.isLoading && !connection.error && isConnectionError ? <p className="mt-2 text-sm text-orange-100">Conexión con error</p> : null}
                    {!connection.isLoading && !connection.error && isConnected ? <p className="mt-2 text-sm text-emerald-100">Conectado como {connection.status.facebookPageName ?? "página de Facebook"}</p> : null}
                    {!connection.isLoading && !connection.error && !isConnected && !isConnectionError ? <p className="mt-2 text-sm text-slate-300">No conectado</p> : null}
                    {!connection.isLoading && !connection.error ? <p className="mt-2 flex items-center gap-2 text-xs text-slate-400"><span className={`size-2 rounded-full ${connection.status.hasInstagram ? "bg-emerald-300" : "bg-slate-600"}`} aria-hidden="true" /> <span aria-label={connection.status.hasInstagram ? "Instagram conectado" : "Instagram no conectado"}>Instagram: {connection.status.hasInstagram ? "conectado" : "no conectado"}</span></p> : null}
                    {canManageConnections(organization.role) ? <div className="mt-4 flex flex-wrap gap-2">
                      {isConnectionError ? <Link href={`/api/integrations/meta/connect?organizationId=${organization.id}`} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-orange-300 px-3 py-2 text-xs font-bold text-[#17110a]">Reconectar</Link> : null}
                      {!isConnected && !isConnectionError ? <Link href={`/api/integrations/meta/connect?organizationId=${organization.id}`} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-orange-300 px-3 py-2 text-xs font-bold text-[#17110a]">Conectar Facebook</Link> : null}
                      {isConnected || isConnectionError ? <button type="button" onClick={() => void handleDisconnect(organization.id)} disabled={connection.isDisconnecting} className="inline-flex min-h-10 items-center justify-center rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-300 disabled:cursor-not-allowed disabled:opacity-50">{connection.isDisconnecting ? "Desconectando…" : "Desconectar"}</button> : null}
                    </div> : null}
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
