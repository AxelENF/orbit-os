import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseAiasOrganizationProfile,
  type AiasOrganizationProfile,
} from "@/lib/aias/contracts";
import {
  AiasProfileAccessError,
  AiasProfileConfigurationError,
  AiasProfileVersionConflictError,
  type AiasJsonValue,
  type AiasProfileAuditEvent,
  type AiasProfileAuditMetadata,
  type AiasOrganizationProfileRecord,
  type AiasProfileRepository,
  type SaveAiasOrganizationProfileInput,
} from "@/lib/organizations/profile-repository";

type AiasProfileRow = {
  organization_id: string;
  aias_profile: unknown | null;
  profile_version: number;
  profile_hash: string | null;
  updated_by: string | null;
  updated_at: string;
  profile_metadata: unknown;
};

type AiasHistoryRow = {
  organization_id: string;
  profile_version: number;
  aias_profile: unknown;
  profile_hash: string;
  changed_by: string;
  profile_metadata: unknown;
  created_at: string;
};

type SupabaseError = { code?: string; message?: string };

function requireOrganizationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AiasProfileConfigurationError(
      "An explicit organizationId is required for an AIAS profile operation.",
    );
  }
}

function requireActorId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AiasProfileAccessError();
  }
}

function validateExpectedVersion(value: unknown): asserts value is number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) {
    throw new AiasProfileConfigurationError(
      "expectedVersion must be a positive integer when supplied.",
    );
  }
}

function clone<T>(value: T): T {
  const structuredCloneFunction = (
    globalThis as typeof globalThis & {
      structuredClone?: <Value>(input: Value) => Value;
    }
  ).structuredClone;
  if (structuredCloneFunction) return structuredCloneFunction(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`)
    .join(",")}}`;
}

function hashProfile(profile: AiasOrganizationProfile): string {
  return createHash("sha256").update(stableSerialize(profile)).digest("hex");
}

function isPlainJsonObject(value: unknown): value is AiasProfileAuditMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): value is AiasJsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return value.every((item) => isJsonValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (!isPlainJsonObject(value)) return false;
  seen.add(value);
  try {
    return Object.values(value).every((item) => isJsonValue(item, seen));
  } finally {
    seen.delete(value);
  }
}

function parseMetadata(value: unknown): AiasProfileAuditMetadata {
  if (!isPlainJsonObject(value) || !isJsonValue(value)) {
    throw new AiasProfileConfigurationError(
      "Supabase returned invalid AIAS profile metadata.",
    );
  }
  return clone(value);
}

function parseRow(value: unknown): AiasProfileRow {
  if (!value || typeof value !== "object") {
    throw new AiasProfileConfigurationError(
      "Supabase returned an invalid AIAS profile row.",
    );
  }
  const row = value as Partial<AiasProfileRow>;
  const profileVersion = row.profile_version;
  if (
    typeof row.organization_id !== "string" ||
    (row.aias_profile !== null && row.aias_profile === undefined) ||
    typeof profileVersion !== "number" ||
    !Number.isInteger(profileVersion) ||
    profileVersion < 1 ||
    (row.profile_hash !== null && typeof row.profile_hash !== "string") ||
    (row.updated_by !== null && typeof row.updated_by !== "string") ||
    typeof row.updated_at !== "string"
  ) {
    throw new AiasProfileConfigurationError(
      "Supabase returned an invalid AIAS profile row.",
    );
  }
  return {
    organization_id: row.organization_id,
    aias_profile: row.aias_profile ?? null,
    profile_version: profileVersion,
    profile_hash: row.profile_hash ?? null,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at,
    profile_metadata: row.profile_metadata ?? {},
  };
}

function toRecord(row: unknown): AiasOrganizationProfileRecord | null {
  const parsed = parseRow(row);
  if (parsed.aias_profile === null) return null;
  if (!parsed.profile_hash || !parsed.updated_by) {
    throw new AiasProfileConfigurationError(
      "Supabase returned an AIAS profile without hash or actor metadata.",
    );
  }

  let profile: AiasOrganizationProfile;
  try {
    profile = parseAiasOrganizationProfile(parsed.aias_profile);
  } catch (cause) {
    throw new AiasProfileConfigurationError(
      "Supabase returned an invalid AIAS organization profile.",
      cause,
    );
  }

  return {
    organizationId: parsed.organization_id,
    version: parsed.profile_version,
    profile: clone(profile),
    updatedAt: parsed.updated_at,
    updatedBy: parsed.updated_by,
    profileHash: parsed.profile_hash,
    auditMetadata: parseMetadata(parsed.profile_metadata),
  };
}

function errorMessage(error: SupabaseError | null | undefined): string {
  return error?.message ?? "";
}

function throwRpcError(error: SupabaseError): never {
  const message = errorMessage(error);
  if (message === "AIAS_PROFILE_VERSION_CONFLICT") {
    throw new AiasProfileVersionConflictError("unknown", 0, null);
  }
  if (
    message === "AIAS_PROFILE_ACTOR_FORBIDDEN" ||
    message === "ORGANIZATION_ACTOR_FORBIDDEN"
  ) {
    throw new AiasProfileAccessError("The actor cannot edit this organization AIAS profile.");
  }
  if (message.startsWith("AIAS_PROFILE_")) {
    throw new AiasProfileConfigurationError(`Unable to save AIAS profile: ${message}.`);
  }
  throw new Error("Unable to save the AIAS organization profile.");
}

/**
 * Durable AIAS profile adapter. It only uses the injected Supabase client;
 * callers choose an anon/authenticated client and RLS remains authoritative.
 * No service-role client is constructed or imported here.
 */
export class SupabaseAiasProfileRepository implements AiasProfileRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getProfile(organizationId: string): Promise<AiasOrganizationProfileRecord | null> {
    requireOrganizationId(organizationId);
    const { data, error } = await this.client
      .from("organization_brand_profiles")
      .select(
        "organization_id, aias_profile, profile_version, profile_hash, updated_by, updated_at, profile_metadata",
      )
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) throw new Error("Unable to read the AIAS organization profile.");
    return data ? toRecord(data) : null;
  }

  async saveProfile(
    input: SaveAiasOrganizationProfileInput,
  ): Promise<AiasOrganizationProfileRecord> {
    if (!input || typeof input !== "object") {
      throw new AiasProfileConfigurationError("An AIAS profile save input is required.");
    }
    requireOrganizationId(input.organizationId);
    requireActorId(input.actorId);
    validateExpectedVersion(input.expectedVersion);

    let profile: AiasOrganizationProfile;
    try {
      profile = parseAiasOrganizationProfile(input.profile);
    } catch (cause) {
      throw new AiasProfileConfigurationError(
        "The AIAS organization profile is invalid.",
        cause,
      );
    }
    const metadata = input.auditMetadata ?? {};
    if (!isPlainJsonObject(metadata) || !isJsonValue(metadata)) {
      throw new AiasProfileConfigurationError(
        "auditMetadata must be a plain JSON object when supplied.",
      );
    }

    const { data, error } = await this.client.rpc(
      "save_aias_organization_profile",
      {
        p_organization_id: input.organizationId,
        p_actor_id: input.actorId,
        p_profile: profile,
        p_profile_canonical: stableSerialize(profile),
        p_profile_hash: hashProfile(profile),
        p_expected_version: input.expectedVersion ?? null,
        p_profile_metadata: metadata,
      },
    );
    if (error) {
      if (errorMessage(error) === "AIAS_PROFILE_VERSION_CONFLICT") {
        throw new AiasProfileVersionConflictError(
          input.organizationId,
          input.expectedVersion ?? 1,
          null,
        );
      }
      throwRpcError(error);
    }
    const record = toRecord(data);
    if (!record) {
      throw new AiasProfileConfigurationError(
        "Supabase did not return the saved AIAS organization profile.",
      );
    }
    return record;
  }

  async listAuditEvents(organizationId: string): Promise<AiasProfileAuditEvent[]> {
    requireOrganizationId(organizationId);
    const { data, error } = await this.client
      .from("organization_brand_profile_history")
      .select(
        "organization_id, profile_version, profile_hash, changed_by, profile_metadata, created_at",
      )
      .eq("organization_id", organizationId)
      .order("profile_version", { ascending: true });
    if (error) throw new Error("Unable to read AIAS profile audit history.");
    if (!Array.isArray(data)) {
      throw new AiasProfileConfigurationError(
        "Supabase returned invalid AIAS profile audit history.",
      );
    }

    return data.map((value) => {
      const row = value as Partial<AiasHistoryRow>;
      const profileVersion = row.profile_version;
      if (
        typeof row.organization_id !== "string" ||
        typeof profileVersion !== "number" ||
        !Number.isInteger(profileVersion) ||
        profileVersion < 1 ||
        typeof row.changed_by !== "string" ||
        typeof row.created_at !== "string" ||
        typeof row.profile_hash !== "string"
      ) {
        throw new AiasProfileConfigurationError(
          "Supabase returned an invalid AIAS profile audit event.",
        );
      }
      return {
        organizationId: row.organization_id,
        actorId: row.changed_by,
        fromVersion: profileVersion === 1 ? null : profileVersion - 1,
        toVersion: profileVersion,
        changedAt: row.created_at,
        metadata: parseMetadata(row.profile_metadata ?? {}),
      };
    });
  }
}

export function createSupabaseAiasProfileRepository(
  client: SupabaseClient,
): AiasProfileRepository {
  return new SupabaseAiasProfileRepository(client);
}
