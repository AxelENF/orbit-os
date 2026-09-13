"use client";

import { useState } from "react";

import type {
  ManualPublicationDeliveryInput,
  PublicationTarget,
  PublicationTargetStatus,
} from "@/lib/content/repository";

type PublicationTargetsProps = {
  targets: PublicationTarget[];
  onApprove: (targetId: string) => Promise<PublicationTarget & { status: "APPROVED" }>;
  onRetry?: (targetId: string) => Promise<PublicationTarget & { status: "APPROVED" }>;
  onRecordManualDelivery?: (
    targetId: string,
    input: Pick<ManualPublicationDeliveryInput, "remoteUrl" | "publishedAt" | "note" | "idempotencyKey">,
  ) => Promise<PublicationTarget & { status: "PUBLISHED" }>;
  disabled?: boolean;
  retryDisabled?: boolean;
};

function statusText(platform: PublicationTarget["platform"], status: PublicationTargetStatus): string {
  const label = platform === "FACEBOOK" ? "Facebook" : "Instagram";
  const statusLabel: Record<PublicationTargetStatus, string> = {
    PENDING_REVIEW: "pendiente de revisión",
    APPROVED: "aprobado",
    REJECTED: "rechazado",
    SCHEDULED: "programado",
    PUBLISHED: "publicado",
    ERROR: "con error",
  };
  return `${label}: ${statusLabel[status]}`;
}

function platformLabel(platform: PublicationTarget["platform"]): string {
  return platform === "FACEBOOK" ? "Facebook" : "Instagram";
}

export function PublicationTargets({ targets, onApprove, onRetry, onRecordManualDelivery, disabled = false, retryDisabled = false }: PublicationTargetsProps) {
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [confirmedTargetIds, setConfirmedTargetIds] = useState<Set<string>>(
    () => new Set(targets.filter((target) => target.status === "APPROVED").map((target) => target.id)),
  );
  const [approvalErrorTargetId, setApprovalErrorTargetId] = useState<string | null>(null);
  const [deliveryTargetId, setDeliveryTargetId] = useState<string | null>(null);
  const [deliveryUrl, setDeliveryUrl] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveredTargetIds, setDeliveredTargetIds] = useState<Set<string>>(
    () => new Set(targets.filter((target) => target.status === "PUBLISHED").map((target) => target.id)),
  );
  const [deliveryRetryKey, setDeliveryRetryKey] = useState<string | null>(null);
  const [retriedTargetIds, setRetriedTargetIds] = useState<Set<string>>(new Set());
  const [retryErrorTargetId, setRetryErrorTargetId] = useState<string | null>(null);

  async function handleApprove(target: PublicationTarget) {
    if (disabled || target.status === "APPROVED") return;
    setPendingTargetId(target.id);
    setApprovalErrorTargetId(null);
    try {
      const result = await onApprove(target.id);
      if (result.status !== "APPROVED") throw new Error("APPROVAL_NOT_CONFIRMED");
      setConfirmedTargetIds((current) => new Set(current).add(target.id));
    } catch {
      setApprovalErrorTargetId(target.id);
    } finally {
      setPendingTargetId(null);
    }
  }

  async function handleManualDelivery(target: PublicationTarget) {
    if (!onRecordManualDelivery || !deliveryUrl.trim()) return;
    const idempotencyKey = deliveryRetryKey ?? crypto.randomUUID();
    setPendingTargetId(target.id);
    setDeliveryError(null);
    try {
      const result = await onRecordManualDelivery(target.id, {
        remoteUrl: deliveryUrl.trim(),
        publishedAt: new Date().toISOString(),
        ...(deliveryNote.trim() ? { note: deliveryNote.trim() } : {}),
        idempotencyKey,
      });
      if (result.status !== "PUBLISHED") throw new Error("DELIVERY_NOT_CONFIRMED");
      setDeliveredTargetIds((current) => new Set(current).add(target.id));
      setDeliveryTargetId(null);
      setDeliveryUrl("");
      setDeliveryNote("");
      setDeliveryRetryKey(null);
    } catch {
      setDeliveryRetryKey(idempotencyKey);
      setDeliveryError(target.id);
    } finally {
      setPendingTargetId(null);
    }
  }

  async function handleRetry(target: PublicationTarget) {
    if (!onRetry || retryDisabled || target.status !== "ERROR") return;
    setPendingTargetId(target.id);
    setRetryErrorTargetId(null);
    try {
      const result = await onRetry(target.id);
      if (result.status !== "APPROVED") throw new Error("RETRY_NOT_CONFIRMED");
      setRetriedTargetIds((current) => new Set(current).add(target.id));
    } catch {
      setRetryErrorTargetId(target.id);
    } finally {
      setPendingTargetId(null);
    }
  }

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-[#0b1429] p-5" aria-labelledby="publication-targets-title">
      <div className="flex flex-col gap-2 border-b border-white/[0.08] pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-orange-200/80">Destinos separados</p>
          <h2 id="publication-targets-title" className="mt-2 text-lg font-semibold text-white">Aprobación por red</h2>
        </div>
        <p className="max-w-xs text-xs leading-5 text-slate-500 sm:text-right">Aprobar una red no habilita la otra.</p>
      </div>

      {targets.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {targets.map((target) => {
            const isDelivered = target.status === "PUBLISHED" || deliveredTargetIds.has(target.id);
            const isApproved = !isDelivered && (target.status === "APPROVED" || confirmedTargetIds.has(target.id) || retriedTargetIds.has(target.id));
            const isPending = pendingTargetId === target.id;
            return (
              <div key={target.id} className="rounded-xl border border-white/[0.08] bg-[#081127] p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-white">{statusText(target.platform, isApproved ? "APPROVED" : target.status)}</p>
                  <span className={`size-2 rounded-full ${isDelivered || isApproved ? "bg-emerald-300" : "bg-orange-300"}`} aria-hidden="true" />
                </div>
                {!isApproved && !isDelivered && target.status !== "ERROR" ? <button
                  className="mt-4 inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-orange-200/25 px-3 py-2 text-sm font-semibold text-orange-100 transition hover:bg-orange-200/10 focus:outline-none focus:ring-2 focus:ring-orange-200/50 disabled:cursor-not-allowed disabled:border-emerald-200/20 disabled:text-emerald-200/80"
                  type="button"
                  disabled={disabled || isPending}
                  onClick={() => void handleApprove(target)}
                >
                  {isPending ? "Registrando aprobación…" : `Aprobar ${platformLabel(target.platform)}`}
                </button> : null}
                {!isApproved && !isDelivered && target.status === "ERROR" && onRetry ? <button
                  className="mt-4 inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-orange-200/25 px-3 py-2 text-sm font-semibold text-orange-100 transition hover:bg-orange-200/10 focus:outline-none focus:ring-2 focus:ring-orange-200/50 disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  disabled={retryDisabled || isPending}
                  onClick={() => void handleRetry(target)}
                >
                  {isPending ? "Reintentando publicación…" : "Reintentar"}
                </button> : null}
                {approvalErrorTargetId === target.id ? <p className="mt-3 text-xs leading-5 text-orange-100" role="alert">No se pudo registrar la aprobación de {platformLabel(target.platform)}. Inténtalo de nuevo.</p> : null}
                {retryErrorTargetId === target.id ? <p className="mt-3 text-xs leading-5 text-orange-100" role="alert">No se pudo reintentar la publicación de {platformLabel(target.platform)}. Inténtalo de nuevo.</p> : null}
                {isApproved && onRecordManualDelivery ? <div className="mt-4 border-t border-white/[0.08] pt-4">
                  {deliveryTargetId === target.id ? <>
                    <label className="block text-xs font-semibold text-slate-200" htmlFor={`delivery-url-${target.id}`}>URL publicada
                      <input id={`delivery-url-${target.id}`} className="mt-2 w-full rounded-lg border border-white/[0.1] bg-[#071024] px-3 py-2 text-sm text-white outline-none focus:border-cyan-200/60" value={deliveryUrl} onChange={(event) => setDeliveryUrl(event.target.value)} placeholder="https://facebook.com/..." />
                    </label>
                    <label className="mt-3 block text-xs font-semibold text-slate-200" htmlFor={`delivery-note-${target.id}`}>Nota opcional
                      <input id={`delivery-note-${target.id}`} className="mt-2 w-full rounded-lg border border-white/[0.1] bg-[#071024] px-3 py-2 text-sm text-white outline-none focus:border-cyan-200/60" value={deliveryNote} onChange={(event) => setDeliveryNote(event.target.value)} placeholder="Ej. pauta activada a las 10:00" maxLength={1000} />
                    </label>
                    <button type="button" disabled={isPending || !deliveryUrl.trim()} onClick={() => void handleManualDelivery(target)} className="mt-3 inline-flex min-h-10 w-full items-center justify-center rounded-lg bg-orange-300 px-3 py-2 text-sm font-bold text-[#17110a] disabled:cursor-not-allowed disabled:opacity-45">{isPending ? "Guardando evidencia…" : "Confirmar publicación manual"}</button>
                    <button type="button" disabled={isPending} onClick={() => { setDeliveryTargetId(null); setDeliveryError(null); }} className="mt-2 w-full text-xs text-slate-400 hover:text-slate-200">Cancelar</button>
                    {deliveryError === target.id ? <p className="mt-3 text-xs leading-5 text-orange-100" role="alert">No se pudo guardar la evidencia. Reintenta sin duplicar el registro.</p> : null}
                  </> : <button type="button" onClick={() => { setDeliveryTargetId(target.id); setDeliveryUrl(target.remoteUrl ?? ""); setDeliveryNote(""); setDeliveryError(null); }} className="inline-flex min-h-10 w-full items-center justify-center rounded-lg bg-cyan-200/10 px-3 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-200/15">Registrar publicación manual</button>}
                </div> : null}
                {isDelivered && target.remoteUrl ? <a className="mt-4 block truncate text-xs text-cyan-100 underline decoration-cyan-100/30 underline-offset-4 hover:text-white" href={target.remoteUrl} target="_blank" rel="noreferrer">Ver publicación registrada ↗</a> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-white/[0.12] p-4 text-sm text-slate-500">No hay destinos para revisar.</p>
      )}
    </section>
  );
}
