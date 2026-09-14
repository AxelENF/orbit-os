"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { PublicationTargets } from "@/components/content/publication-targets";
import { AppIcon } from "@/components/layout/app-icon";
import { hasActionableTarget } from "@/lib/content/actionable-target";
import { listContentSummaries } from "@/lib/content/client";
import { CAMPAIGN_STATUS_LABELS, campaignNextAction } from "@/lib/content/campaign-view";
import type { ContentSummary } from "@/lib/content/repository";
import type { ContentState } from "@/lib/content/state-machine";
import { approveDemoTarget, readDemoDrafts, type DemoDraftRecord } from "@/lib/demo/draft-store";
import { useAttentionTargets } from "@/lib/content/use-attention-targets";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

type CampaignFilter = "ALL" | "ATTENTION" | "SCHEDULED" | "PUBLISHED";

const filters: Array<{ id: CampaignFilter; label: string }> = [
  { id: "ALL", label: "Todas" },
  { id: "ATTENTION", label: "Por revisar" },
  { id: "SCHEDULED", label: "Programadas" },
  { id: "PUBLISHED", label: "Publicadas" },
];

function matchesFilter(item: ContentSummary | DemoDraftRecord["content"], filter: CampaignFilter): boolean {
  if (filter === "ATTENTION") return "hasActionableTarget" in item && item.hasActionableTarget === true;
  if (filter === "SCHEDULED") return item.state === "SCHEDULED";
  if (filter === "PUBLISHED") return item.state === "PUBLISHED";
  return true;
}

function statusTone(state: ContentState): string {
  if (state === "PUBLISHED") return "border-emerald-300/25 bg-emerald-300/10 text-emerald-200";
  if (state === "SCHEDULED" || state === "APPROVED") return "border-[#A8C7FF]/25 bg-[#A8C7FF]/10 text-[#A8C7FF]";
  if (state === "ERROR" || state === "REJECTED") return "border-red-300/25 bg-red-300/10 text-red-200";
  return "border-[#FF4D00]/30 bg-[#FF4D00]/10 text-orange-200";
}

function campaignDescription(item: ContentSummary | DemoDraftRecord["content"]): string {
  return item.campaign?.offer || `${item.niche.replaceAll("_", " ")} · ${item.contentType.replaceAll("_", " ")}`;
}

function campaignTitle(item: ContentSummary | DemoDraftRecord["content"]): string {
  return item.campaign?.campaignName || `${item.service.replaceAll("_", " ")} · ${item.niche.replaceAll("_", " ")}`;
}

function demoHasActionableTarget(record: DemoDraftRecord): boolean {
  return hasActionableTarget(record.content.state, record.targets);
}

function matchesDemoFilter(draft: DemoDraftRecord, filter: CampaignFilter): boolean {
  if (filter === "ATTENTION") return demoHasActionableTarget(draft);
  if (filter === "SCHEDULED") return draft.content.state === "SCHEDULED";
  if (filter === "PUBLISHED") return draft.content.state === "PUBLISHED";
  return true;
}

function toDemoSummary(draft: DemoDraftRecord): ContentSummary {
  return { ...draft.content, hasActionableTarget: demoHasActionableTarget(draft) };
}

function FilterFromSearchParams({ onFilter }: { onFilter: (filter: CampaignFilter) => void }) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const param = searchParams?.get("filter");
    if (param === "attention") onFilter("ATTENTION");
    else if (param === "scheduled") onFilter("SCHEDULED");
    else if (param === "published") onFilter("PUBLISHED");
  }, [searchParams, onFilter]);
  return null;
}

function Stat({ value, label, tone = "text-white" }: { value: number; label: string; tone?: string }) {
  return <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.08] py-3 last:border-0"><span className={`text-2xl font-semibold tracking-[-0.05em] ${tone}`}>{value}</span><span className="text-right text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</span></div>;
}

export default function LibraryPage() {
  const [drafts, setDrafts] = useState<DemoDraftRecord[]>([]);
  const [items, setItems] = useState<ContentSummary[]>([]);
  const [filter, setFilter] = useState<CampaignFilter>("ALL");
  const [isLoading, setIsLoading] = useState(true);
  const isProductionMode = hasSupabaseBrowserConfig();

  function loadSummaries() {
    return listContentSummaries().then(setItems).catch(() => setItems([]));
  }

  function refreshDemo() {
    setDrafts(readDemoDrafts());
  }

  useEffect(() => {
    if (!isProductionMode) {
      const timer = window.setTimeout(() => { refreshDemo(); setIsLoading(false); }, 0);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      const next = await listContentSummaries().catch(() => []);
      if (cancelled) return;
      setItems(next);
      setIsLoading(false);
      if (next.some((item) => item.state === "GENERATING")) {
        pollTimer = setTimeout(load, 4000);
      }
    }

    load();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [isProductionMode]);

  const filteredItems = useMemo(() => items.filter((item) => matchesFilter(item, filter)), [filter, items]);
  const filteredDrafts = useMemo(() => drafts.filter((draft) => matchesDemoFilter(draft, filter)), [drafts, filter]);
  const visibleItems = isProductionMode ? items : drafts.map((draft) => draft.content);
  const attentionCount = isProductionMode
    ? items.filter((item) => item.hasActionableTarget).length
    : drafts.filter(demoHasActionableTarget).length;
  const publishedCount = visibleItems.filter((item) => item.state === "PUBLISHED").length;
  const attentionItems = useMemo(() => items.filter((item) => item.hasActionableTarget), [items]);
  const attention = useAttentionTargets(
    filter === "ATTENTION" ? attentionItems.map((item) => item.id) : [],
    () => { void loadSummaries(); },
  );

  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={null}>
        <FilterFromSearchParams onFilter={setFilter} />
      </Suspense>

      <header className="flex flex-col gap-5 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-[#1748D2]/35 text-[#A8C7FF] ring-1 ring-[#A8C7FF]/15"><AppIcon name="campaigns" size={23} /></span>
          <div><p className="font-mono text-[0.62rem] uppercase tracking-[0.24em] text-[#A8C7FF]/65">SnapGad / workspace</p><h1 className="mt-1 text-3xl font-semibold tracking-[-0.045em] text-white">Campañas</h1></div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-white/10 px-3 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.13em] text-slate-500">{isProductionMode ? "Conectado" : "Modo demo"}</span>
          <Link href="/library/new" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#FF4D00] px-4 text-sm font-bold text-white shadow-[0_10px_25px_rgba(255,77,0,0.18)] transition hover:bg-[#ff6a2f]"><AppIcon name="plus" size={16} /> Nueva campaña</Link>
        </div>
      </header>

      <section className="mt-6 grid gap-3 rounded-2xl border border-white/[0.08] bg-[#091735] p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3"><div><p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-slate-600">Actividad</p><p className="mt-1 text-sm font-semibold text-white">Tu operación está lista para recibir campañas.</p></div><div className="hidden h-9 w-px bg-white/10 sm:block" aria-hidden="true" /><div className="flex gap-5"><Stat value={visibleItems.length} label="campañas" /><Stat value={attentionCount} label="por revisar" tone="text-[#FF8B68]" /><Stat value={publishedCount} label="publicadas" tone="text-[#A8C7FF]" /></div></div>
        <Link href="/library/new" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[#FF4D00]/35 bg-[#FF4D00]/10 px-4 text-xs font-bold text-orange-100 transition hover:bg-[#FF4D00]/20"><AppIcon name="plus" size={15} /> Crear campaña</Link>
      </section>

      <section className="mt-10"><div className="flex flex-col gap-4 border-b border-white/[0.08] pb-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-mono text-[0.62rem] uppercase tracking-[0.22em] text-[#A8C7FF]/65">Workspace</p><h2 className="mt-1 text-xl font-semibold text-white">Campañas recientes</h2></div><div className="flex flex-wrap gap-2" role="tablist" aria-label="Filtrar campañas">{filters.map((option) => { const selected = filter === option.id; return <button key={option.id} type="button" role="tab" aria-selected={selected} onClick={() => setFilter(option.id)} className={`rounded-lg border px-3.5 py-2 text-xs font-semibold transition ${selected ? "border-[#FF4D00]/50 bg-[#FF4D00]/15 text-orange-100" : "border-white/10 text-slate-500 hover:border-white/25 hover:text-white"}`}>{option.label}</button>; })}</div></div></section>

      {isLoading && filter !== "ATTENTION" ? <p className="mt-8 text-sm text-slate-500">Cargando campañas…</p> : null}

      {isProductionMode && !isLoading && filter !== "ATTENTION" && filteredItems.length > 0 ? <section className="mt-5 grid gap-3 sm:grid-cols-2">{filteredItems.map((item) => <article key={item.id} className="group flex min-h-44 flex-col rounded-2xl border border-white/[0.08] bg-[#091735] p-5 transition hover:border-[#315bd6]/60"><div className="flex items-start justify-between gap-3"><span className={`rounded-full border px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-[0.11em] ${statusTone(item.state)}`}>{CAMPAIGN_STATUS_LABELS[item.state]}</span><span className="font-mono text-[0.6rem] text-slate-600">{new Date(item.createdAt).toLocaleDateString("es-MX")}</span></div><h3 className="mt-5 text-base font-semibold tracking-[-0.02em] text-white">{campaignTitle(item)}</h3><p className="mt-1 line-clamp-1 text-xs text-slate-500">{campaignDescription(item)}</p><div className="mt-auto flex items-center justify-between gap-3 pt-5"><span className="flex items-center gap-2 text-xs font-semibold text-[#A8C7FF]"><span className="size-1.5 rounded-full bg-[#FF4D00]" />{campaignNextAction(item)}</span><Link href={`/drafts/${item.id}`} className="inline-flex items-center gap-1.5 text-xs font-semibold text-white transition group-hover:text-[#FF8B68]">Abrir <AppIcon name="arrow" size={14} /></Link></div></article>)}</section> : null}

      {!isProductionMode && filteredDrafts.length > 0 ? <section className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{filteredDrafts.map((draft) => {
        const demoSummary = toDemoSummary(draft);
        return <article key={draft.content.id} className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#091735]"><div className="relative aspect-[4/5] overflow-hidden bg-[#081127]"><Image src={draft.previewDataUrl} alt={`Creativo ${draft.filename}`} fill sizes="(min-width: 1280px) 30vw, (min-width: 640px) 45vw, 100vw" unoptimized className="object-cover" /></div><div className="space-y-3 p-4"><div className="flex items-center justify-between gap-3"><span className={`rounded-full border px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-[0.11em] ${statusTone(draft.content.state)}`}>{CAMPAIGN_STATUS_LABELS[draft.content.state]}</span><span className="text-[0.65rem] text-slate-500">Demo local</span></div><h3 className="truncate text-sm font-semibold text-white">{campaignTitle(demoSummary)}</h3><p className="text-xs text-slate-500">{campaignDescription(demoSummary)}</p><div className="flex items-center justify-between gap-3"><Link href={`/drafts/${draft.content.id}`} className="inline-flex items-center gap-1.5 text-xs font-semibold text-white transition hover:text-[#FF8B68]">Abrir <AppIcon name="arrow" size={14} /></Link></div>{filter === "ATTENTION" ? <PublicationTargets
          targets={draft.targets}
          disabled={draft.content.state !== "REVIEW"}
          onApprove={(targetId) => {
            const next = approveDemoTarget(draft.content.id, targetId);
            const approved = next?.targets.find((target) => target.id === targetId);
            if (!next || !approved || approved.status !== "APPROVED") {
              return Promise.reject(new Error("DEMO_TARGET_NOT_APPROVED"));
            }
            refreshDemo();
            return Promise.resolve({ ...approved, status: "APPROVED" as const });
          }}
        /> : null}</div></article>;
      })}</section> : null}

      {filter === "ATTENTION" && attention.isLoading ? (
        <p className="mt-8 text-sm text-slate-500">Cargando campañas por revisar…</p>
      ) : null}

      {filter === "ATTENTION" && !attention.isLoading && (attention.records.length > 0 || attention.failedIds.length > 0) ? (
        <section className="mt-8 space-y-5">
          {attention.records.map((record) => {
            const latestDraft = record.drafts.at(-1);
            return (
              <article key={record.content.id} className="rounded-3xl border border-white/[0.08] bg-[#0b1429] p-5 sm:p-6">
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.17em] text-orange-200/75">Copy recibido · {record.content.service.replaceAll("_", " ")} · {record.content.niche.replaceAll("_", " ")}</p>
                <h2 className="mt-2 text-xl font-semibold text-white">{latestDraft?.headline ?? "Copy todavía no recibido"}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{latestDraft?.body ?? "Solicita el análisis a n8n desde el borrador antes de aprobar un destino."}</p>
                {latestDraft ? <p className="mt-3 text-xs text-cyan-100/75">CTA: {latestDraft.cta}</p> : null}
                <div className="mt-5">
                  <PublicationTargets
                    targets={record.targets}
                    disabled={!latestDraft || record.content.state !== "REVIEW"}
                    retryDisabled={!latestDraft}
                    onApprove={(targetId) => {
                      const target = record.targets.find((candidate) => candidate.id === targetId);
                      if (!target) return Promise.reject(new Error("PUBLICATION_TARGET_NOT_FOUND"));
                      return attention.handleApprove(record.content.id, target);
                    }}
                    onRetry={(targetId) => attention.handleRetry(record.content.id, targetId)}
                  />
                </div>
              </article>
            );
          })}
          {attention.failedIds.map((id) => (
            <article key={id} role="alert" className="rounded-3xl border border-red-300/25 bg-red-300/[0.05] p-5 text-sm text-red-200">
              No se pudo cargar el detalle de esta campaña. Actualiza la página para reintentar.
            </article>
          ))}
        </section>
      ) : null}

      {filter === "ATTENTION" && !attention.isLoading && attention.records.length === 0 && attention.failedIds.length === 0 ? (
        <section className="mt-5 rounded-2xl border border-dashed border-[#315bd6]/35 bg-[#091735] p-5 text-center">
          <p className="text-sm text-slate-400">Nada pendiente de revisión.</p>
        </section>
      ) : null}

      {filter !== "ATTENTION" && !isLoading && ((isProductionMode && filteredItems.length === 0) || (!isProductionMode && filteredDrafts.length === 0)) ? <section className="mt-5 grid gap-6 rounded-2xl border border-dashed border-[#315bd6]/35 bg-[#091735] p-5 sm:grid-cols-[180px_1fr] sm:items-center sm:p-7"><div className="flex aspect-[4/3] items-center justify-center rounded-xl border border-white/10 bg-[radial-gradient(circle_at_50%_0%,rgba(255,77,0,0.14),transparent_70%),#07112E] text-[#FF8B68]"><AppIcon name="spark" size={30} /></div><div><p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-[#FF8B68]">{filter === "ALL" ? "Tu espacio de trabajo" : "Sin coincidencias"}</p><h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-white">{filter === "ALL" ? "Tu primera campaña empieza aquí." : "Cambia el filtro para ver otras campañas."}</h2><p className="mt-2 max-w-lg text-sm leading-6 text-slate-400">{filter === "ALL" ? "Carga el creativo final de Canva, añade la oferta y deja que el sistema prepare la conversación correcta." : "No hay campañas en este estado todavía."}</p>{filter === "ALL" ? <Link href="/library/new" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#FF4D00] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#ff6a2f]">Crear campaña <AppIcon name="arrow" size={15} /></Link> : null}</div></section> : null}
    </div>
  );
}
