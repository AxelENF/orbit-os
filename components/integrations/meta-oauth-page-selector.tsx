"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type MetaOAuthPage = {
  id: string;
  name: string;
  hasInstagram: boolean;
};

type MetaOAuthPagesResponse = {
  organizationId: string;
  pages: MetaOAuthPage[];
};

type MetaOAuthPageSelectorProps = {
  nonce: string;
  onConnected: (organizationId: string) => void | Promise<void>;
};

type MetaOAuthApiError = Error & {
  organizationId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePagesResponse(value: unknown): MetaOAuthPagesResponse | null {
  if (!isRecord(value) || typeof value.organizationId !== "string" || !Array.isArray(value.pages)) {
    return null;
  }

  const pages = value.pages.filter((page): page is MetaOAuthPage => {
    if (!isRecord(page)) return false;
    return typeof page.id === "string" && page.id.length > 0 &&
      typeof page.name === "string" && page.name.length > 0 &&
      typeof page.hasInstagram === "boolean";
  });
  if (pages.length !== value.pages.length) return null;

  return { organizationId: value.organizationId, pages };
}

async function readApiError(response: Response, fallback: string): Promise<MetaOAuthApiError> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      const error = new Error(payload.error) as MetaOAuthApiError;
      if (typeof payload.organizationId === "string") error.organizationId = payload.organizationId;
      return error;
    }
  } catch {
    // Fall through to the stable client-side error.
  }
  return new Error(fallback);
}

function errorMessage(code: string): string {
  if (code === "META_OAUTH_SESSION_EXPIRED") {
    return "La sesión de conexión con Meta expiró. Reiníciala para volver a elegir una página.";
  }
  if (code === "AUTHENTICATION_REQUIRED") return "Tu sesión ya no está activa.";
  if (code === "ORGANIZATION_ACCESS_DENIED") return "No tienes acceso a esa organización.";
  if (code === "META_OAUTH_SELECTION_FAILED" || code === "META_CONNECTION_PERSIST_FAILED") {
    return "No se pudo conectar esa página de Meta. Inténtalo de nuevo.";
  }
  return "No se pudieron cargar las páginas de Meta. Inténtalo de nuevo.";
}

function asApiError(reason: unknown, fallback: string): MetaOAuthApiError {
  return reason instanceof Error ? reason as MetaOAuthApiError : new Error(fallback);
}

function restartHref(organizationId: string | null): string {
  return organizationId
    ? `/api/integrations/meta/connect?organizationId=${encodeURIComponent(organizationId)}`
    : "/settings/organizations";
}

export function MetaOAuthPageSelector({ nonce, onConnected }: MetaOAuthPageSelectorProps) {
  const [pages, setPages] = useState<MetaOAuthPage[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const isMountedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    isMountedRef.current = true;

    fetch(`/api/integrations/meta/connect/select?nonce=${encodeURIComponent(nonce)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) throw await readApiError(response, "META_OAUTH_PAGE_LOOKUP_FAILED");
        const payload = parsePagesResponse(await response.json());
        if (!payload) throw new Error("INVALID_META_OAUTH_PAGES_RESPONSE");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setOrganizationId(payload.organizationId);
        setPages(payload.pages);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const apiError = asApiError(reason, "META_OAUTH_PAGE_LOOKUP_FAILED");
        if (apiError.organizationId) setOrganizationId(apiError.organizationId);
        setError(apiError.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      isMountedRef.current = false;
    };
  }, [nonce]);

  async function handleSelect(pageId: string) {
    if (!organizationId || selectedPageId || isComplete) return;

    setSelectedPageId(pageId);
    setError(null);
    try {
      const response = await fetch("/api/integrations/meta/connect/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ organizationId, nonce, pageId }),
      });
      if (!response.ok) throw await readApiError(response, "META_OAUTH_SELECTION_FAILED");
      await onConnected(organizationId);
      if (!isMountedRef.current) return;
      setIsComplete(true);
    } catch (reason: unknown) {
      if (!isMountedRef.current) return;
      const apiError = asApiError(reason, "META_OAUTH_SELECTION_FAILED");
      if (apiError.organizationId) setOrganizationId(apiError.organizationId);
      setSelectedPageId(null);
      setError(apiError.message);
    }
  }

  return (
    <section
      aria-labelledby="meta-oauth-page-selector-heading"
      className="mt-8 rounded-3xl border border-[#FF4D00]/35 bg-[#091735] p-6 shadow-[0_18px_45px_rgba(2,8,30,0.18)] sm:p-8"
    >
      <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-[#FF8B68]">Conexión Meta</p>
      <h2 id="meta-oauth-page-selector-heading" className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-white">
        Selecciona la página de Facebook
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
        Meta encontró más de una página que puedes administrar. Elige cuál conectar a esta organización.
      </p>

      {isLoading ? <p className="mt-6 text-sm text-slate-400">Cargando páginas de Facebook…</p> : null}

      {error ? (
        <div className="mt-6 space-y-4">
          <p className="rounded-2xl border border-red-200/20 bg-red-200/[0.05] p-4 text-sm leading-6 text-red-100" role="alert">
            {errorMessage(error)}
          </p>
          {error === "META_OAUTH_SESSION_EXPIRED" ? (
            <Link
              href={restartHref(organizationId)}
              className="inline-flex min-h-10 items-center justify-center rounded-lg bg-orange-300 px-3 py-2 text-xs font-bold text-[#17110a]"
            >
              Reiniciar conexión de Meta
            </Link>
          ) : null}
        </div>
      ) : null}

      {!isLoading && !error && pages.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">No se encontraron páginas administrables.</p>
      ) : null}

      {!error && pages.length > 0 ? (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {pages.map((page) => (
            <li key={page.id} className="rounded-2xl border border-white/[0.08] bg-[#07112E] p-4">
              <button
                type="button"
                aria-label={page.name}
                onClick={() => void handleSelect(page.id)}
                disabled={isLoading || selectedPageId !== null || isComplete}
                className="flex min-h-10 w-full items-center justify-between gap-3 text-left text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span>{page.name}</span>
                {selectedPageId === page.id ? <span className="text-xs text-orange-200">Conectando…</span> : null}
              </button>
              <p className="mt-2 text-xs text-slate-400">
                Instagram: {page.hasInstagram ? "conectado" : "no conectado"}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {isComplete ? <p className="mt-5 text-sm text-emerald-100" role="status">Conexión con Meta completada.</p> : null}
    </section>
  );
}

type MetaOAuthSelectionProps = {
  onConnected: (organizationId: string) => void | Promise<void>;
};

export function MetaOAuthSelection({ onConnected }: MetaOAuthSelectionProps) {
  const searchParams = useSearchParams();
  const metaOAuth = searchParams?.get("metaOAuth");
  const nonce = searchParams?.get("nonce")?.trim();

  if (metaOAuth !== "select" || !nonce) return null;
  return <MetaOAuthPageSelector key={nonce} nonce={nonce} onConnected={onConnected} />;
}
