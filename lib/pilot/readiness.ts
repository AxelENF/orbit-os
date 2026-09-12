import { getContentRepositoryMode, type ContentRepositoryMode } from "@/lib/content/repository-factory";

type Environment = Record<string, string | undefined>;

export type PilotCheckStatus = "READY" | "ACTION_REQUIRED" | "BLOCKED";

export type PilotCheck = {
  id: "persistence" | "session" | "copyWorker" | "manualDelivery";
  title: string;
  status: PilotCheckStatus;
  detail: string;
};

export type PilotReadiness = {
  mode: ContentRepositoryMode;
  checks: PilotCheck[];
  nextAction: string;
};

function hasWorkerConfiguration(environment: Environment): boolean {
  return Boolean(
    environment.SNAPGAD_COPY_WORKER_MODULE &&
    environment.OPENROUTER_API_KEY &&
    environment.SNAPGAD_COPY_OPENROUTER_MODEL &&
    environment.SNAPGAD_COPY_MODEL_INPUT_PRICE_PER_1M_USD &&
    environment.SNAPGAD_COPY_MODEL_OUTPUT_PRICE_PER_1M_USD &&
    environment.SNAPGAD_COPY_MAX_REQUEST_COST_USD,
  );
}

/**
 * Reports configuration posture only. It never returns secret values, probes
 * providers, publishes a post, or treats a configured worker as a running one.
 */
export function getPilotReadiness(environment: Environment = process.env): PilotReadiness {
  const mode = getContentRepositoryMode(environment);
  const persistence: PilotCheck = mode === "supabase"
    ? {
        id: "persistence",
        title: "Persistencia Supabase",
        status: "READY",
        detail: "La configuración pública y server-side está presente. Falta validar Storage y RLS con un usuario real.",
      }
    : mode === "demo"
      ? {
          id: "persistence",
          title: "Persistencia Supabase",
          status: "ACTION_REQUIRED",
          detail: "Estás en demo local: nada se guarda en la organización ni se envía a proveedores.",
        }
      : {
          id: "persistence",
          title: "Persistencia Supabase",
          status: "BLOCKED",
          detail: "La configuración de Supabase está incompleta; el portal falla cerrado y no cambia a demo silenciosamente.",
        };

  const workerConfigured = mode === "supabase" && hasWorkerConfiguration(environment);
  const checks: PilotCheck[] = [
    persistence,
    {
      id: "session",
      title: "Sesión y organización",
      status: mode === "supabase" ? "ACTION_REQUIRED" : "BLOCKED",
      detail: mode === "supabase"
        ? "Inicia sesión, selecciona una organización y ejecuta el smoke de aislamiento antes de una campaña real."
        : "Requiere configuración Supabase antes de que una sesión y organización puedan validarse.",
    },
    {
      id: "copyWorker",
      title: "Worker de copy supervisado",
      status: workerConfigured ? "ACTION_REQUIRED" : "BLOCKED",
      detail: workerConfigured
        ? "La configuración necesaria está presente. Inicia el proceso worker y prueba un único job de bajo costo; este panel no confirma que esté corriendo."
        : "Faltan parámetros server-side del worker o proveedor. No se intentará una llamada de IA.",
    },
    {
      id: "manualDelivery",
      title: "Entrega y resultados manuales",
      status: "READY",
      detail: "La operación puede registrar aprobación, URL publicada y resultados observados sin conectar ni publicar mediante Meta.",
    },
  ];

  const nextAction = mode === "demo"
    ? "Configura Supabase en .env.local y reinicia el portal para salir de demo local."
    : mode === "misconfigured"
      ? "Completa la configuración pública y server-side de Supabase; no continúes con campañas reales hasta que el modo sea conectado."
      : !workerConfigured
        ? "Configura el worker de copy con un límite de costo y ejecuta un único smoke supervisado."
        : "Inicia sesión con tu organización de prueba y completa una campaña real de punta a punta antes de sumar OAuth de Meta.";

  return { mode, checks, nextAction };
}
