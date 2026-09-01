"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";

import { AssetDropzone } from "@/components/content/asset-dropzone";
import {
  BUSINESS_LINES,
  CONTENT_OBJECTIVES,
  CONTENT_TYPES,
  NICHES,
  SERVICES,
} from "@/lib/content/constants";
import {
  contentBriefSchema,
  type ContentBrief,
} from "@/lib/content/contracts";
import type { ContentRepository } from "@/lib/content/repository";
import { persistDemoAsset } from "@/lib/demo/browser-assets";
import { persistDemoDraft } from "@/lib/demo/draft-store";
import { createDemoRepository } from "@/lib/demo/repository";

type FormState = Omit<ContentBrief, "allowedFacts"> & {
  allowedFactsText: string;
};

type ContentFormProps = {
  onSubmit?: (brief: ContentBrief, file: File) => void | Promise<void>;
  repository?: Pick<ContentRepository, "createContentItem">;
};

const BUSINESS_LINE_LABELS: Record<(typeof BUSINESS_LINES)[number], string> = {
  CONTROLAR: "Controlar",
  CAPTAR: "Captar",
  AUTOMATIZAR: "Automatizar",
};

const SERVICE_LABELS: Record<(typeof SERVICES)[number], string> = {
  pos: "POS",
  web_conversion: "Web de conversión",
  bot_whatsapp: "Bot de WhatsApp",
  crm: "CRM",
  erp_operaciones: "ERP / operaciones",
  infraestructura: "Infraestructura",
};

const NICHE_LABELS: Record<(typeof NICHES)[number], string> = {
  clinicas: "Clínicas",
  esteticas: "Estéticas",
  spas: "Spas",
  salones: "Salones",
  barberias: "Barberías",
  comercio_inventario: "Comercio con inventario",
  servicios_locales: "Servicios locales",
  general: "General",
};

const CONTENT_TYPE_LABELS: Record<(typeof CONTENT_TYPES)[number], string> = {
  educativo: "Educativo",
  prueba: "Prueba / demostración",
  venta_directa: "Venta directa",
};

const OBJECTIVE_LABELS: Record<(typeof CONTENT_OBJECTIVES)[number], string> = {
  conversaciones_whatsapp: "Conversaciones por WhatsApp",
  agenda_demo: "Agendar una demo",
  trafico_web: "Tráfico web",
  autoridad: "Autoridad",
};

const initialState: FormState = {
  businessLine: BUSINESS_LINES[0],
  service: SERVICES[0],
  niche: NICHES[0],
  contentType: CONTENT_TYPES[0],
  objective: CONTENT_OBJECTIVES[0],
  format: "feed_4_5",
  cta: "",
  humanDescription: "",
  allowedFactsText: "",
};

function splitAllowedFacts(value: string): string[] {
  return value
    .split("\n")
    .map((fact) => fact.trim())
    .filter(Boolean);
}

function inputClasses(): string {
  return "mt-2 w-full rounded-xl border border-slate-700 bg-[#0c1427] px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-300/80 focus:ring-2 focus:ring-cyan-300/20";
}

export function ContentForm({ onSubmit, repository }: ContentFormProps) {
  const [state, setState] = useState<FormState>(initialState);
  const [asset, setAsset] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [createdItemId, setCreatedItemId] = useState<string | null>(null);
  const [demoRepository] = useState(() => createDemoRepository());

  const parsedBrief = useMemo(
    () =>
      contentBriefSchema.safeParse({
        businessLine: state.businessLine,
        service: state.service,
        niche: state.niche,
        contentType: state.contentType,
        objective: state.objective,
        format: state.format,
        cta: state.cta,
        humanDescription: state.humanDescription,
        allowedFacts: splitAllowedFacts(state.allowedFactsText),
      }),
    [state],
  );

  const isComplete = parsedBrief.success && Boolean(asset);

  function updateField<Key extends keyof FormState>(
    field: Key,
    value: FormState[Key],
  ) {
    setState((current) => ({ ...current, [field]: value }));
    setSuccess(false);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setHasAttemptedSubmit(true);

    if (!parsedBrief.success || !asset) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      let createdItemIdForLink: string | null = null;
      if (onSubmit) {
        await onSubmit(parsedBrief.data, asset);
      } else {
        const createdItem = await (repository ?? demoRepository).createContentItem(parsedBrief.data);
        createdItemIdForLink = createdItem.id;
        if (!repository) {
          await persistDemoAsset(createdItem, asset);
          persistDemoDraft(createdItem);
        }
      }
      setCreatedItemId(createdItemIdForLink);
      setSuccess(true);
    } catch {
      setSubmitError(
        "No se pudo guardar el borrador local. Revisa los datos e inténtalo de nuevo.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit} noValidate>
      <section className="rounded-3xl border border-slate-800 bg-[#0b1325]/90 p-5 shadow-2xl shadow-black/10 sm:p-7">
        <div className="mb-6 flex flex-col gap-2 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-cyan-200/80">
              Contexto comercial
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">
              Clasifica antes de redactar
            </h2>
          </div>
          <p className="max-w-xs text-xs leading-5 text-slate-500 sm:text-right">
            Estos datos son la fuente de verdad del contenido y pasan a revisión humana.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <SelectField
            id="business-line"
            label="Línea"
            value={state.businessLine}
            onChange={(value) => updateField("businessLine", value as FormState["businessLine"])}
            options={BUSINESS_LINES.map((value) => ({
              value,
              label: BUSINESS_LINE_LABELS[value],
            }))}
          />
          <SelectField
            id="service"
            label="Servicio"
            value={state.service}
            onChange={(value) => updateField("service", value as FormState["service"])}
            options={SERVICES.map((value) => ({
              value,
              label: SERVICE_LABELS[value],
            }))}
          />
          <SelectField
            id="niche"
            label="Nicho"
            value={state.niche}
            onChange={(value) => updateField("niche", value as FormState["niche"])}
            options={NICHES.map((value) => ({
              value,
              label: NICHE_LABELS[value],
            }))}
          />
          <SelectField
            id="content-type"
            label="Tipo de contenido"
            value={state.contentType}
            onChange={(value) => updateField("contentType", value as FormState["contentType"])}
            options={CONTENT_TYPES.map((value) => ({
              value,
              label: CONTENT_TYPE_LABELS[value],
            }))}
          />
          <SelectField
            id="objective"
            label="Objetivo"
            value={state.objective}
            onChange={(value) => updateField("objective", value as FormState["objective"])}
            options={CONTENT_OBJECTIVES.map((value) => ({
              value,
              label: OBJECTIVE_LABELS[value],
            }))}
          />
          <div>
            <p className="text-sm font-semibold text-slate-100">
              Formato
            </p>
            <div className={`${inputClasses()} flex items-center justify-between text-slate-300`} aria-label="Formato">
              <span>Feed 4:5</span>
              <span className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-cyan-200/80">
                1080 × 1350
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 rounded-3xl border border-slate-800 bg-[#0b1325]/90 p-5 shadow-2xl shadow-black/10 sm:p-7 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-6">
          <AssetDropzone value={asset} onChange={(file) => {
            setAsset(file);
            setSuccess(false);
            setSubmitError(null);
          }} />

          <div>
            <label className="text-sm font-semibold text-slate-100" htmlFor="cta">
              CTA <span className="text-orange-300" aria-hidden="true">*</span>
            </label>
            <input
              aria-label="CTA"
              aria-required="true"
              aria-invalid={hasAttemptedSubmit && !state.cta.trim()}
              aria-describedby="cta-help"
              className={inputClasses()}
              id="cta"
              required
              value={state.cta}
              onChange={(event) => updateField("cta", event.target.value)}
              placeholder="Ej. Escribe AGENDA por WhatsApp"
            />
            <p className="mt-2 text-xs leading-5 text-slate-500" id="cta-help">
              Una sola acción clara para la persona que verá el creativo.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <label className="text-sm font-semibold text-slate-100" htmlFor="human-description">
              Descripción humana <span className="text-orange-300" aria-hidden="true">*</span>
            </label>
            <textarea
              aria-label="Descripción humana"
              aria-required="true"
              aria-invalid={hasAttemptedSubmit && !state.humanDescription.trim()}
              aria-describedby="description-help"
              className={`${inputClasses()} min-h-32 resize-y`}
              id="human-description"
              required
              value={state.humanDescription}
              onChange={(event) => updateField("humanDescription", event.target.value)}
              placeholder="Qué debe comunicar el creativo y para quién."
            />
            <p className="mt-2 text-xs leading-5 text-slate-500" id="description-help">
              Describe el dolor, el resultado y el tipo de negocio al que va dirigido.
            </p>
          </div>

          <div>
            <label className="text-sm font-semibold text-slate-100" htmlFor="allowed-facts">
              Hechos permitidos <span className="text-orange-300" aria-hidden="true">*</span>
            </label>
            <textarea
              aria-label="Hechos permitidos"
              aria-required="true"
              aria-invalid={hasAttemptedSubmit && splitAllowedFacts(state.allowedFactsText).length === 0}
              aria-describedby="facts-help"
              className={`${inputClasses()} min-h-32 resize-y`}
              id="allowed-facts"
              required
              value={state.allowedFactsText}
              onChange={(event) => updateField("allowedFactsText", event.target.value)}
              placeholder={"Un hecho por línea.\nEj. Atiende solicitudes.\nEj. Agenda citas."}
            />
            <p className="mt-2 text-xs leading-5 text-slate-500" id="facts-help">
              Solo se usarán hechos escritos aquí; no agregues promesas, precios o métricas sin respaldo.
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-4 rounded-2xl border border-orange-200/15 bg-orange-200/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-orange-200" aria-hidden="true">◎</span>
          <p className="max-w-2xl text-xs leading-5 text-slate-300">
            El creativo debe llegar terminado desde Canva. Este flujo genera borradores de texto; no genera ni edita imágenes con IA.
          </p>
        </div>
        <button
          className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl bg-orange-300 px-5 text-sm font-bold text-[#17110a] shadow-lg shadow-orange-300/10 transition hover:bg-orange-200 focus:outline-none focus:ring-2 focus:ring-orange-200 focus:ring-offset-2 focus:ring-offset-[#0a1020] disabled:cursor-not-allowed disabled:opacity-40"
          type="submit"
          disabled={!isComplete || isSubmitting || success}
          aria-busy={isSubmitting}
        >
          Generar borradores
        </button>
      </div>

      {hasAttemptedSubmit && !isComplete ? (
        <p className="text-sm text-orange-200" role="alert">
          Completa el creativo, la CTA, la descripción humana y al menos un hecho permitido para continuar.
        </p>
      ) : null}

      {submitError ? (
        <p className="text-sm text-orange-200" role="alert">
          {submitError}
        </p>
      ) : null}

      {success ? (
        <div className="rounded-2xl border border-cyan-200/25 bg-cyan-200/[0.06] p-5" role="status" aria-live="polite">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-cyan-200">
            Borrador guardado en modo local
          </p>
          <p className="mt-2 text-sm font-semibold text-white">
            Siguiente paso: revisar los borradores antes de publicar.
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            No se envió ninguna solicitud a servicios externos.
          </p>
          <a
            className="mt-4 inline-flex rounded-lg border border-cyan-200/25 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-200/10"
            href={createdItemId ? `/drafts/${createdItemId}` : "/drafts"}
          >
            Revisar borradores →
          </a>
        </div>
      ) : null}
    </form>
  );
}

type SelectFieldProps = {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
};

function SelectField({ id, label, value, options, onChange }: SelectFieldProps) {
  return (
    <div>
      <label className="text-sm font-semibold text-slate-100" htmlFor={id}>
        {label}
      </label>
      <select
        aria-required="true"
        className={inputClasses()}
        id={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
