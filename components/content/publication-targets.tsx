"use client";

import { useState } from "react";

import type {
  PublicationTarget,
  PublicationTargetStatus,
} from "@/lib/content/repository";

type PublicationTargetsProps = {
  targets: PublicationTarget[];
  onApprove: (targetId: string) => void | Promise<void>;
  disabled?: boolean;
};

function statusText(platform: PublicationTarget["platform"], status: PublicationTargetStatus): string {
  const label = platform === "FACEBOOK" ? "Facebook" : "Instagram";
  return `${label}: ${status === "APPROVED" ? "aprobado" : "pendiente de revisión"}`;
}

function platformLabel(platform: PublicationTarget["platform"]): string {
  return platform === "FACEBOOK" ? "Facebook" : "Instagram";
}

export function PublicationTargets({ targets, onApprove, disabled = false }: PublicationTargetsProps) {
  const [optimisticallyApproved, setOptimisticallyApproved] = useState<Set<string>>(
    () => new Set(targets.filter((target) => target.status === "APPROVED").map((target) => target.id)),
  );

  const localTargets = targets.map((target) =>
    optimisticallyApproved.has(target.id) ? { ...target, status: "APPROVED" as const } : target,
  );

  function handleApprove(target: PublicationTarget) {
    if (disabled || target.status === "APPROVED") return;
    setOptimisticallyApproved((current) => new Set(current).add(target.id));
    void onApprove(target.id);
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

      {localTargets.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {localTargets.map((target) => {
            const isApproved = target.status === "APPROVED";
            return (
              <div key={target.id} className="rounded-xl border border-white/[0.08] bg-[#081127] p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-white">{statusText(target.platform, target.status)}</p>
                  <span className={`size-2 rounded-full ${isApproved ? "bg-emerald-300" : "bg-orange-300"}`} aria-hidden="true" />
                </div>
                <button
                  className="mt-4 inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-orange-200/25 px-3 py-2 text-sm font-semibold text-orange-100 transition hover:bg-orange-200/10 focus:outline-none focus:ring-2 focus:ring-orange-200/50 disabled:cursor-not-allowed disabled:border-emerald-200/20 disabled:text-emerald-200/80"
                  type="button"
                  disabled={isApproved || disabled}
                  onClick={() => handleApprove(target)}
                >
                  {`Aprobar ${platformLabel(target.platform)}`}
                </button>
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
