"use client";

import { useEffect, useMemo, useState } from "react";

import type { AiasOrganizationProfile } from "@/lib/aias/contracts";

type ProfileRecord = {
  organizationId: string;
  version: number;
  profile: AiasOrganizationProfile;
};

type ProfileFormProps = {
  organizationId: string | null;
  enabled: boolean;
};

const emptyProfile: AiasOrganizationProfile = {
  businessName: "",
  industry: "",
  subIndustry: "",
  locations: [],
  offerings: [""],
  idealCustomer: "",
  painPoints: [],
  proofPoints: [],
  tone: "Claro, directo y profesional",
  forbiddenClaims: [],
  defaultCta: "Escribe para comenzar",
  timezone: "America/Mexico_City",
  workflowPreferences: {
    enabledWorkflows: ["copy_generation"],
    approvalRequired: true,
    defaultPlatforms: ["facebook"],
    publishingWindows: [],
  },
};

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinLines(value: readonly string[]): string {
  return value.join("\n");
}

function fieldClassName(): string {
  return "mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-[#07112E] px-3 py-2 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#FF4D00] focus:ring-2 focus:ring-[#FF4D00]/25";
}

export function AiasProfileForm({ organizationId, enabled }: ProfileFormProps) {
  const [record, setRecord] = useState<ProfileRecord | null>(null);
  const [profile, setProfile] = useState<AiasOrganizationProfile>(emptyProfile);
  const [isLoading, setIsLoading] = useState(Boolean(enabled && organizationId));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !organizationId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      setNotice(null);
    });
    fetch(`/api/organizations/${organizationId}/profile`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("PROFILE_LOOKUP_FAILED");
        return (await response.json()) as { profile?: ProfileRecord };
      })
      .then((payload) => {
        if (cancelled) return;
        if (!payload) {
          setRecord(null);
          setProfile(emptyProfile);
          return;
        }
        const nextRecord = payload.profile;
        if (!nextRecord?.profile) throw new Error("INVALID_PROFILE_RESPONSE");
        setRecord(nextRecord);
        setProfile(nextRecord.profile);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudo cargar el perfil AIAS.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, organizationId]);

  const offeringsText = useMemo(() => joinLines(profile.offerings), [profile.offerings]);
  const painPointsText = useMemo(() => joinLines(profile.painPoints), [profile.painPoints]);
  const proofPointsText = useMemo(() => joinLines(profile.proofPoints), [profile.proofPoints]);
  const locationsText = useMemo(() => joinLines(profile.locations), [profile.locations]);
  const forbiddenClaimsText = useMemo(() => joinLines(profile.forbiddenClaims), [profile.forbiddenClaims]);

  function updateProfile<K extends keyof AiasOrganizationProfile>(key: K, value: AiasOrganizationProfile[K]) {
    setProfile((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || isSaving) return;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    const response = await fetch(`/api/organizations/${organizationId}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        profile: {
          ...profile,
          locations: splitLines(locationsText),
          offerings: splitLines(offeringsText),
          painPoints: splitLines(painPointsText),
          proofPoints: splitLines(proofPointsText),
          forbiddenClaims: splitLines(forbiddenClaimsText),
        },
        ...(record ? { expectedVersion: record.version } : {}),
        metadata: { source: "aias-onboarding" },
      }),
    }).catch(() => null);

    if (!response) {
      setError("No se pudo guardar el perfil. Revisa tu conexión.");
    } else if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      setError(
        payload?.error === "PROFILE_VERSION_CONFLICT"
          ? "El perfil cambió en otra sesión. Recarga antes de guardar de nuevo."
          : "No se pudo guardar el perfil AIAS.",
      );
    } else {
      const payload = (await response.json()) as { profile: ProfileRecord };
      setRecord(payload.profile);
      setProfile(payload.profile.profile);
      setNotice("Perfil AIAS guardado. Tus próximos copys usarán este contexto.");
    }
    setIsSaving(false);
  }

  if (!organizationId) return null;

  return (
    <section className="mt-8 rounded-3xl border border-white/[0.08] bg-[#091735] p-6 shadow-[0_18px_45px_rgba(2,8,30,0.18)] sm:p-8">
      <div className="flex flex-col gap-3 border-b border-white/[0.08] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-[#FF8B68]">Perfil AIAS</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-white">Enséñale a la IA cómo opera tu negocio</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">Este contexto controla el tono, la audiencia y los límites de tus publicaciones. Se guarda por organización.</p>
        </div>
        {record ? <span className="rounded-full border border-emerald-200/20 bg-emerald-200/[0.06] px-3 py-1.5 text-xs font-semibold text-emerald-100">Versión {record.version}</span> : null}
      </div>

      {!enabled ? (
        <div className="mt-6 rounded-2xl border border-dashed border-[#315bd6]/40 bg-[#07112E] p-5 text-sm leading-6 text-slate-400">
          El formulario está listo. Conecta Supabase para guardar el perfil AIAS y mantenerlo separado por organización; el modo demo no inventa datos ni intenta escribir fuera de red.
        </div>
      ) : isLoading ? (
        <p className="mt-6 text-sm text-slate-500">Cargando perfil AIAS…</p>
      ) : (
        <form className="mt-6 space-y-6" onSubmit={saveProfile}>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="text-sm font-semibold text-slate-200">Nombre del negocio<input required className={fieldClassName()} value={profile.businessName} onChange={(event) => updateProfile("businessName", event.target.value)} placeholder="Clínica Norte" /></label>
            <label className="text-sm font-semibold text-slate-200">Rubro principal<input required className={fieldClassName()} value={profile.industry} onChange={(event) => updateProfile("industry", event.target.value)} placeholder="Salud, belleza, comercio…" /></label>
            <label className="text-sm font-semibold text-slate-200">Subrubro<input className={fieldClassName()} value={profile.subIndustry ?? ""} onChange={(event) => updateProfile("subIndustry", event.target.value)} placeholder="Spa, clínica dental, restaurante…" /></label>
            <label className="text-sm font-semibold text-slate-200">Zona o ciudades<textarea className={`${fieldClassName()} min-h-20`} value={locationsText} onChange={(event) => updateProfile("locations", splitLines(event.target.value))} placeholder="Puebla\nCDMX" /></label>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="text-sm font-semibold text-slate-200">Servicios u ofertas<textarea required className={`${fieldClassName()} min-h-24`} value={offeringsText} onChange={(event) => updateProfile("offerings", splitLines(event.target.value))} placeholder="Una oferta por línea" /></label>
            <label className="text-sm font-semibold text-slate-200">Cliente ideal<textarea required className={`${fieldClassName()} min-h-24`} value={profile.idealCustomer} onChange={(event) => updateProfile("idealCustomer", event.target.value)} placeholder="Quién compra y qué necesita" /></label>
            <label className="text-sm font-semibold text-slate-200">Problemas que resuelves<textarea className={`${fieldClassName()} min-h-24`} value={painPointsText} onChange={(event) => updateProfile("painPoints", splitLines(event.target.value))} placeholder="Una situación por línea" /></label>
            <label className="text-sm font-semibold text-slate-200">Pruebas permitidas<textarea className={`${fieldClassName()} min-h-24`} value={proofPointsText} onChange={(event) => updateProfile("proofPoints", splitLines(event.target.value))} placeholder="Datos o hechos que sí podemos afirmar" /></label>
          </div>
          <div className="grid gap-5 sm:grid-cols-3">
            <label className="text-sm font-semibold text-slate-200">Tono<input required className={fieldClassName()} value={profile.tone} onChange={(event) => updateProfile("tone", event.target.value)} /></label>
            <label className="text-sm font-semibold text-slate-200">CTA predeterminado<input required className={fieldClassName()} value={profile.defaultCta} onChange={(event) => updateProfile("defaultCta", event.target.value)} /></label>
            <label className="text-sm font-semibold text-slate-200">Claims prohibidos<textarea className={`${fieldClassName()} min-h-20`} value={forbiddenClaimsText} onChange={(event) => updateProfile("forbiddenClaims", splitLines(event.target.value))} placeholder="Lo que nunca debemos prometer" /></label>
          </div>
          {error ? <p className="rounded-xl border border-red-200/20 bg-red-200/[0.05] p-3 text-sm text-red-100" role="alert">{error}</p> : null}
          {notice ? <p className="rounded-xl border border-emerald-200/20 bg-emerald-200/[0.05] p-3 text-sm text-emerald-100" role="status">{notice}</p> : null}
          <div className="flex flex-col gap-3 border-t border-white/[0.08] pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-slate-500">El guardado crea una nueva versión y conserva el historial de cambios.</p>
            <button type="submit" disabled={isSaving} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#FF4D00] px-5 text-sm font-bold text-white shadow-[0_8px_22px_rgba(255,77,0,0.2)] transition hover:bg-[#ff6426] disabled:cursor-wait disabled:opacity-60">{isSaving ? "Guardando…" : record ? "Guardar cambios" : "Guardar perfil AIAS"}</button>
          </div>
        </form>
      )}
    </section>
  );
}
