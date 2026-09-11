import { transitionContentState } from "@/lib/content/state-machine";
import type {
  ContentItem,
  PublicationTarget,
} from "@/lib/content/repository";
import { readDemoAssets, type DemoBrowserAsset } from "@/lib/demo/browser-assets";

const STORAGE_KEY = "snapgad-content-os:demo-drafts";

export type DemoCopyOption = {
  id: string;
  headline: string;
  body: string;
  cta: string;
  hashtags: string[];
  source: "local-demo";
};

export type DemoFinalCopy = Pick<DemoCopyOption, "headline" | "body" | "cta" | "hashtags">;

export type DemoAuditEvent = {
  id: string;
  contentItemId: string;
  type:
    | "CONTENT_CREATED"
    | "LOCAL_DRAFTS_CREATED"
    | "SENT_TO_REVIEW"
    | "TARGET_APPROVED";
  status: "info" | "success" | "warning";
  message: string;
  createdAt: string;
};

export type DemoDraftRecord = {
  content: ContentItem;
  filename: string;
  mimeType: string;
  previewDataUrl: string;
  visualAnalysis: {
    source: "local-demo";
    summary: string;
    detectedClaims: string[];
  };
  drafts: DemoCopyOption[];
  selectedDraftId: string;
  finalCopy: DemoFinalCopy;
  warnings: string[];
  targets: PublicationTarget[];
  auditEvents: DemoAuditEvent[];
  updatedAt: string;
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStoredDrafts(): DemoDraftRecord[] {
  if (!isBrowser()) return [];

  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as DemoDraftRecord[]) : [];
  } catch {
    return [];
  }
}

function writeStoredDrafts(records: DemoDraftRecord[]): void {
  if (isBrowser()) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function createAuditEvent(
  contentItemId: string,
  type: DemoAuditEvent["type"],
  status: DemoAuditEvent["status"],
  message: string,
): DemoAuditEvent {
  return {
    id: createId("audit"),
    contentItemId,
    type,
    status,
    message,
    createdAt: new Date().toISOString(),
  };
}

function createDraftRecord(asset: DemoBrowserAsset): DemoDraftRecord {
  const { content } = asset;
  const firstFact = content.allowedFacts[0] ?? "El brief define los hechos permitidos.";
  const secondFact = content.allowedFacts[1] ?? firstFact;
  const baseHashtags = [
    `#${content.niche.replaceAll("_", "")}`,
    `#${content.service.replaceAll("_", "")}`,
    "#SnapGad",
  ];
  const firstDraft: DemoCopyOption = {
    id: createId("copy"),
    headline: "Más control para la operación diaria",
    body: `${firstFact} ${content.humanDescription} ${content.cta}.`,
    cta: content.cta,
    hashtags: baseHashtags,
    source: "local-demo",
  };
  const secondDraft: DemoCopyOption = {
    id: createId("copy"),
    headline: "Una atención que sí avanza",
    body: `${secondFact} ${content.humanDescription} Da el siguiente paso: ${content.cta}.`,
    cta: content.cta,
    hashtags: baseHashtags,
    source: "local-demo",
  };
  const now = new Date().toISOString();

  return {
    content,
    filename: asset.filename,
    mimeType: asset.mimeType,
    previewDataUrl: asset.previewDataUrl,
    visualAnalysis: {
      source: "local-demo",
      summary: "Análisis visual pendiente de conexión. Esta vista usa un marcador local.",
      detectedClaims: [],
    },
    drafts: [firstDraft, secondDraft],
    selectedDraftId: firstDraft.id,
    finalCopy: {
      headline: firstDraft.headline,
      body: firstDraft.body,
      cta: firstDraft.cta,
      hashtags: firstDraft.hashtags,
    },
    warnings: [
      "Demo local: estas dos alternativas son ejemplos de interfaz; no se ejecutó IA.",
      "Revisa cada hecho, promesa y CTA antes de enviar a revisión.",
    ],
    targets: [
      {
        id: createId("facebook-target"),
        contentItemId: content.id,
        platform: "FACEBOOK",
        status: "PENDING_REVIEW",
      },
      {
        id: createId("instagram-target"),
        contentItemId: content.id,
        platform: "INSTAGRAM",
        status: "PENDING_REVIEW",
      },
    ],
    auditEvents: [
      createAuditEvent(
        content.id,
        "CONTENT_CREATED",
        "info",
        "Creativo y brief guardados en almacenamiento demo local.",
      ),
      createAuditEvent(
        content.id,
        "LOCAL_DRAFTS_CREATED",
        "warning",
        "Dos alternativas locales disponibles; no se llamó a ningún proveedor externo.",
      ),
    ],
    updatedAt: now,
  };
}

function materializeDrafts(): DemoDraftRecord[] {
  const records = readStoredDrafts();
  const knownIds = new Set(records.map((record) => record.content.id));
  const missing = readDemoAssets()
    .filter((asset) => !knownIds.has(asset.contentItemId))
    .map(createDraftRecord);

  if (missing.length > 0) writeStoredDrafts([...missing, ...records]);
  return [...missing, ...records];
}

export function readDemoDrafts(): DemoDraftRecord[] {
  return materializeDrafts();
}

export function readDemoDraft(contentItemId: string): DemoDraftRecord | null {
  return materializeDrafts().find((record) => record.content.id === contentItemId) ?? null;
}

/** Creates deterministic local copy options for a previously persisted demo asset. */
export function persistDemoDraft(contentItem: ContentItem): DemoDraftRecord | null {
  if (!isBrowser()) return null;
  const asset = readDemoAssets().find((candidate) => candidate.contentItemId === contentItem.id);
  if (!asset) return null;

  const records = readStoredDrafts().filter((record) => record.content.id !== contentItem.id);
  const record = createDraftRecord(asset);
  writeStoredDrafts([record, ...records]);
  return record;
}

export function saveDemoDraft(record: DemoDraftRecord): void {
  const records = readStoredDrafts().filter((candidate) => candidate.content.id !== record.content.id);
  writeStoredDrafts([{ ...record, updatedAt: new Date().toISOString() }, ...records]);
}

export function submitDemoDraftForReview(contentItemId: string, finalCopy: DemoFinalCopy, selectedDraftId: string): DemoDraftRecord | null {
  const record = readDemoDraft(contentItemId);
  if (!record) return null;

  const nextState = record.content.state === "DRAFT"
    ? transitionContentState(record.content.state, "REVIEW")
    : record.content.state;
  const nextRecord: DemoDraftRecord = {
    ...record,
    content: { ...record.content, state: nextState },
    selectedDraftId,
    finalCopy,
    auditEvents: record.auditEvents.some((event) => event.type === "SENT_TO_REVIEW")
      ? record.auditEvents
      : [
          ...record.auditEvents,
          createAuditEvent(
            contentItemId,
            "SENT_TO_REVIEW",
            "success",
            "Copy final enviado a revisión humana; los destinos siguen separados.",
          ),
        ],
    updatedAt: new Date().toISOString(),
  };

  saveDemoDraft(nextRecord);
  return nextRecord;
}

export function approveDemoTarget(contentItemId: string, targetId: string): DemoDraftRecord | null {
  const record = readDemoDraft(contentItemId);
  if (!record || record.content.state !== "REVIEW") return null;

  const target = record.targets.find((candidate) => candidate.id === targetId);
  if (!target || target.status === "APPROVED") return record;

  const targets = record.targets.map((candidate) =>
    candidate.id === targetId ? { ...candidate, status: "APPROVED" as const } : candidate,
  );
  const allTargetsApproved = targets.every((candidate) => candidate.status === "APPROVED");
  const nextState = allTargetsApproved
    ? transitionContentState(record.content.state, "APPROVED")
    : record.content.state;
  const nextRecord: DemoDraftRecord = {
    ...record,
    content: { ...record.content, state: nextState },
    targets,
    auditEvents: [
      ...record.auditEvents,
      createAuditEvent(
        contentItemId,
        "TARGET_APPROVED",
        "success",
        `${target.platform === "FACEBOOK" ? "Facebook" : "Instagram"} aprobado de forma independiente en modo demo local.`,
      ),
    ],
    updatedAt: new Date().toISOString(),
  };

  saveDemoDraft(nextRecord);
  return nextRecord;
}

export function clearDemoDrafts(): void {
  if (isBrowser()) window.localStorage.removeItem(STORAGE_KEY);
}
