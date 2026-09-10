"use client";

import { useEffect, useState } from "react";

import type { OrganizationRole } from "@/lib/organizations/permissions";

export type OrganizationOption = {
  id: string;
  name: string;
  role: OrganizationRole;
};

export type OrganizationsResponse = {
  organizations: OrganizationOption[];
  activeOrganizationId: string | null;
};

type OrganizationSwitcherProps = {
  organizations?: readonly OrganizationOption[];
  activeOrganizationId?: string | null;
  onOrganizationChange?: (organizationId: string) => void;
};

const roleLabels: Record<OrganizationRole, string> = {
  owner: "Propietario",
  editor: "Editor",
  reviewer: "Revisor",
  viewer: "Consulta",
};

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return value === "owner" || value === "editor" || value === "reviewer" || value === "viewer";
}

export function parseOrganizationsResponse(value: unknown): OrganizationsResponse | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as { organizations?: unknown; activeOrganizationId?: unknown };
  if (!Array.isArray(payload.organizations)) return null;

  const organizations = payload.organizations.filter((organization): organization is OrganizationOption => {
    if (!organization || typeof organization !== "object") return false;
    const candidate = organization as Partial<OrganizationOption>;
    return typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      typeof candidate.name === "string" &&
      candidate.name.length > 0 &&
      isOrganizationRole(candidate.role);
  });
  if (organizations.length !== payload.organizations.length) return null;

  const activeOrganizationId = payload.activeOrganizationId === null || payload.activeOrganizationId === undefined
    ? null
    : typeof payload.activeOrganizationId === "string"
      ? payload.activeOrganizationId
      : null;
  if (
    activeOrganizationId === "" ||
    (activeOrganizationId !== null && !organizations.some(({ id }) => id === activeOrganizationId))
  ) return null;
  return { organizations, activeOrganizationId };
}

function errorMessage(code: string | undefined): string {
  if (code === "ORGANIZATION_ACCESS_DENIED") return "No tienes acceso a esa organización.";
  if (code === "AUTHENTICATION_REQUIRED") return "Tu sesión ya no está activa.";
  if (code === "ACTIVE_ORGANIZATION_NOT_CONFIGURED") {
    return "El selector de organización no está configurado todavía.";
  }
  return "No se pudo cambiar de organización. Inténtalo de nuevo.";
}

async function readError(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : undefined;
  } catch {
    return undefined;
  }
}

export function OrganizationSwitcher({
  organizations: initialOrganizations,
  activeOrganizationId: initialActiveOrganizationId,
  onOrganizationChange,
}: OrganizationSwitcherProps) {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>(
    () => [...(initialOrganizations ?? [])],
  );
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(
    initialActiveOrganizationId ?? null,
  );
  const [isLoading, setIsLoading] = useState(initialOrganizations === undefined);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (initialOrganizations !== undefined) {
      return;
    }

    let cancelled = false;
    fetch("/api/organizations", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        const payload = parseOrganizationsResponse(await response.json());
        if (!payload) throw new Error("INVALID_ORGANIZATIONS_RESPONSE");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setOrganizations(payload.organizations);
        setActiveOrganizationId(payload.activeOrganizationId);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason instanceof Error ? reason.message : undefined));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialActiveOrganizationId, initialOrganizations]);

  async function selectOrganization(organizationId: string) {
    if (!organizationId || organizationId === activeOrganizationId || isSaving) return;

    const previousOrganizationId = activeOrganizationId;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    setActiveOrganizationId(organizationId);

    try {
      const response = await fetch("/api/organizations/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) throw new Error(await readError(response));

      const payload = (await response.json()) as { organizationId?: unknown };
      const confirmedOrganizationId =
        typeof payload.organizationId === "string" ? payload.organizationId : organizationId;
      const selectedOrganization = organizations.find(({ id }) => id === confirmedOrganizationId);
      if (!selectedOrganization) throw new Error("ORGANIZATION_ACCESS_DENIED");
      setActiveOrganizationId(confirmedOrganizationId);
      setNotice(`${selectedOrganization?.name ?? "La organización"} está activa.`);
      onOrganizationChange?.(confirmedOrganizationId);
    } catch (reason: unknown) {
      setActiveOrganizationId(previousOrganizationId);
      setError(errorMessage(reason instanceof Error ? reason.message : undefined));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[#315bd6]/35 bg-[#12327A]/20 p-4 shadow-[0_14px_32px_rgba(3,10,35,0.18)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-[#A8C7FF]/75">
            Organización activa
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Tus campañas y decisiones se guardan dentro de este espacio.
          </p>
        </div>
        <label className="block min-w-0 sm:min-w-64">
          <span className="sr-only">Organización activa</span>
          <select
            aria-label="Organización activa"
            value={activeOrganizationId ?? ""}
            onChange={(event) => void selectOrganization(event.target.value)}
            disabled={isLoading || isSaving || organizations.length === 0}
            className="min-h-11 w-full rounded-xl border border-white/15 bg-[#07112E] px-3 text-sm font-semibold text-white outline-none transition hover:border-[#A8C7FF]/50 focus:border-[#FF4D00] focus:ring-2 focus:ring-[#FF4D00]/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="" disabled>
              {isLoading ? "Cargando organizaciones…" : "Selecciona una organización"}
            </option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name} · {roleLabels[organization.role]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {organizations.length === 0 && !isLoading ? (
        <p className="mt-4 rounded-xl border border-dashed border-white/15 px-3 py-3 text-xs leading-5 text-slate-400">
          No hay organizaciones accesibles todavía.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-xl border border-red-200/20 bg-red-200/[0.05] px-3 py-3 text-xs leading-5 text-red-100" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-xl border border-emerald-200/20 bg-emerald-200/[0.05] px-3 py-3 text-xs leading-5 text-emerald-100" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
