"use client";

import { useMemo, useState } from "react";

import type { PublicationResult, PublicationTarget } from "@/lib/content/repository";

type ResultInput = Omit<PublicationResult, "id" | "contentItemId" | "publicationTargetId" | "createdAt">;

type PublicationResultsProps = {
  targets: PublicationTarget[];
  results: PublicationResult[];
  onRecord: (targetId: string, input: ResultInput) => Promise<PublicationResult>;
};

const numberFields: Array<{ key: keyof Pick<ResultInput, "reach" | "impressions" | "conversations" | "qualifiedLeads" | "appointments" | "spendMxn" | "revenueMxn">; label: string; optional?: boolean }> = [
  { key: "reach", label: "Alcance" },
  { key: "impressions", label: "Impresiones" },
  { key: "conversations", label: "Conversaciones" },
  { key: "qualifiedLeads", label: "Leads calificados" },
  { key: "appointments", label: "Citas" },
  { key: "spendMxn", label: "Inversión MXN" },
  { key: "revenueMxn", label: "Ingreso MXN", optional: true },
];

function label(platform: PublicationTarget["platform"]): string {
  return platform === "FACEBOOK" ? "Facebook" : "Instagram";
}

function baseMetricValues(): Record<string, string> {
  return {
    reach: "0",
    impressions: "0",
    conversations: "0",
    qualifiedLeads: "0",
    appointments: "0",
    spendMxn: "0",
    revenueMxn: "",
  };
}

export function PublicationResults({ targets, results, onRecord }: PublicationResultsProps) {
  const publishedTargets = targets.filter((target) => target.status === "PUBLISHED");
  const [targetId, setTargetId] = useState("");
  const [values, setValues] = useState<Record<string, string>>(baseMetricValues);
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latestByTarget = useMemo(() => {
    const latest = new Map<string, PublicationResult>();
    for (const result of results) {
      if (!latest.has(result.publicationTargetId)) latest.set(result.publicationTargetId, result);
    }
    return latest;
  }, [results]);

  if (publishedTargets.length === 0) return null;

  async function submit() {
    const selectedTarget = publishedTargets.find((target) => target.id === targetId);
    if (!selectedTarget) {
      setError("Elige la red que estás reportando.");
      return;
    }
    const parsed = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === "" ? undefined : Number(value)]));
    const requiredKeys = ["reach", "impressions", "conversations", "qualifiedLeads", "appointments", "spendMxn"];
    if (requiredKeys.some((key) => !Number.isFinite(parsed[key]) || (parsed[key] as number) < 0) || (parsed.revenueMxn !== undefined && (!Number.isFinite(parsed.revenueMxn) || (parsed.revenueMxn as number) < 0))) {
      setError("Los resultados deben ser números iguales o mayores a cero.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onRecord(selectedTarget.id, {
        observedAt: new Date().toISOString(),
        reach: parsed.reach as number,
        impressions: parsed.impressions as number,
        conversations: parsed.conversations as number,
        qualifiedLeads: parsed.qualifiedLeads as number,
        appointments: parsed.appointments as number,
        spendMxn: parsed.spendMxn as number,
        ...(parsed.revenueMxn === undefined ? {} : { revenueMxn: parsed.revenueMxn as number }),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setTargetId("");
      setValues(baseMetricValues());
      setNote("");
    } catch {
      setError("No se pudo registrar el resultado. Revisa los datos e inténtalo de nuevo.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="rounded-3xl border border-emerald-200/15 bg-emerald-200/[0.025] p-5 sm:p-6" aria-labelledby="publication-results-title">
      <div className="border-b border-emerald-200/10 pb-4">
        <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-emerald-100/70">Cierre comercial manual</p>
        <h2 id="publication-results-title" className="mt-2 text-xl font-semibold text-white">Registra lo que pasó, no lo que suponemos.</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">Guarda una foto de desempeño por red. La plataforma no atribuye ventas ni calcula ROI por ti.</p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {publishedTargets.map((target) => {
          const latest = latestByTarget.get(target.id);
          return <div key={target.id} className="rounded-xl border border-white/[0.08] bg-[#081127] p-4">
            <p className="text-sm font-semibold text-white">{label(target.platform)}</p>
            {latest ? <p className="mt-2 text-xs leading-5 text-slate-400">Último registro: {latest.conversations} conversaciones · {latest.appointments} citas · ${latest.spendMxn.toLocaleString("es-MX")} MXN invertidos.</p> : <p className="mt-2 text-xs leading-5 text-slate-500">Aún no hay resultado registrado.</p>}
          </div>;
        })}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-semibold text-slate-100" htmlFor="publication-result-target">Red publicada
          <select id="publication-result-target" value={targetId} onChange={(event) => setTargetId(event.target.value)} className="mt-2 w-full rounded-xl border border-white/[0.1] bg-[#081127] px-3 py-3 text-sm text-white outline-none focus:border-emerald-200/60">
            <option value="">Selecciona una red</option>
            {publishedTargets.map((target) => <option key={target.id} value={target.id}>{label(target.platform)}</option>)}
          </select>
        </label>
        <label className="block text-sm font-semibold text-slate-100" htmlFor="publication-result-note">Nota opcional
          <input id="publication-result-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} placeholder="Ej. pauta activada durante 24 h" className="mt-2 w-full rounded-xl border border-white/[0.1] bg-[#081127] px-3 py-3 text-sm text-white outline-none focus:border-emerald-200/60" />
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {numberFields.map((field) => <label key={field.key} className="block text-sm font-semibold text-slate-100" htmlFor={`publication-result-${field.key}`}>{field.label}
          <input id={`publication-result-${field.key}`} type="number" inputMode="decimal" min="0" step="0.01" value={values[field.key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.optional ? "Opcional" : "0"} className="mt-2 w-full rounded-xl border border-white/[0.1] bg-[#081127] px-3 py-3 text-sm text-white outline-none focus:border-emerald-200/60" />
        </label>)}
      </div>
      <button type="button" disabled={isSaving} onClick={() => void submit()} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-emerald-200 px-5 text-sm font-bold text-[#07140f] transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-45">{isSaving ? "Guardando resultado…" : "Guardar resultado observado"}</button>
      {error ? <p className="mt-3 text-xs leading-5 text-orange-100" role="alert">{error}</p> : null}
    </section>
  );
}
