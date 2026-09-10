import { createHash } from "node:crypto";

import {
  parseAiasOrganizationProfile,
  type AiasOrganizationProfile,
} from "@/lib/aias/contracts";

export type AiasJsonPrimitive = string | number | boolean | null;
export type AiasJsonValue =
  | AiasJsonPrimitive
  | AiasProfileAuditMetadata
  | AiasJsonValue[];
export type AiasProfileAuditMetadata = {
  [key: string]: AiasJsonValue;
};

export type AiasOrganizationProfileRecord = {
  organizationId: string;
  version: number;
  profile: AiasOrganizationProfile;
  updatedAt: string;
  updatedBy: string;
  profileHash: string;
  auditMetadata?: AiasProfileAuditMetadata;
};

export type AiasProfileAuditEvent = {
  organizationId: string;
  actorId: string;
  fromVersion: number | null;
  toVersion: number;
  changedAt: string;
  metadata?: AiasProfileAuditMetadata;
};

export type SaveAiasOrganizationProfileInput = {
  organizationId: string;
  actorId: string;
  profile: unknown;
  expectedVersion?: number;
  auditMetadata?: AiasProfileAuditMetadata;
};

export interface AiasProfileRepository {
  getProfile(
    organizationId: string,
  ): Promise<AiasOrganizationProfileRecord | null>;
  saveProfile(
    input: SaveAiasOrganizationProfileInput,
  ): Promise<AiasOrganizationProfileRecord>;
  listAuditEvents(organizationId: string): Promise<AiasProfileAuditEvent[]>;
}

export class AiasProfileConfigurationError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AiasProfileConfigurationError";
    this.cause = cause;
  }
}

export class AiasProfileAccessError extends Error {
  constructor(message = "An actor is required to change an AIAS profile.") {
    super(message);
    this.name = "AiasProfileAccessError";
  }
}

export class AiasProfileVersionConflictError extends Error {
  readonly organizationId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(
    organizationId: string,
    expectedVersion: number,
    actualVersion: number | null,
  ) {
    super(
      `The AIAS profile for organization ${organizationId} changed before version ${expectedVersion} could be saved.`,
    );
    this.name = "AiasProfileVersionConflictError";
    this.organizationId = organizationId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export type InMemoryAiasProfileRepositoryOptions = {
  now?: () => Date;
};

export type InMemoryAiasProfileRepository = AiasProfileRepository & {
  /** Short aliases are kept on the test/demo adapter, not required by the durable contract. */
  get(organizationId: string): Promise<AiasOrganizationProfileRecord | null>;
  save(input: SaveAiasOrganizationProfileInput): Promise<AiasOrganizationProfileRecord>;
  updateProfile(
    input: SaveAiasOrganizationProfileInput,
  ): Promise<AiasOrganizationProfileRecord>;
  getAuditEvents(organizationId: string): Promise<AiasProfileAuditEvent[]>;
};

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
  if (
    value !== undefined &&
    (!Number.isInteger(value) || (value as number) < 1)
  ) {
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

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

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

function parseProfile(input: unknown): AiasOrganizationProfile {
  try {
    return parseAiasOrganizationProfile(input);
  } catch (error) {
    throw new AiasProfileConfigurationError(
      "The AIAS organization profile is invalid.",
      error,
    );
  }
}

function parseAuditMetadata(
  value: unknown,
): AiasProfileAuditMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isPlainJsonObject(value)) {
    throw new AiasProfileConfigurationError(
      "auditMetadata must be a plain JSON object when supplied.",
    );
  }
  return clone(value);
}

function isPlainJsonObject(
  value: unknown,
  seen = new WeakSet<object>(),
): value is AiasProfileAuditMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  if (seen.has(value)) return false;
  seen.add(value);
  try {
    return Object.values(value).every((item) => isPlainJsonValue(item, seen));
  } finally {
    seen.delete(value);
  }
}

function isPlainJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): value is AiasJsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    try {
      return value.every((item) => isPlainJsonValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  return isPlainJsonObject(value, seen);
}

function changedAt(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AiasProfileConfigurationError(
      "The AIAS profile repository clock must return a valid Date.",
    );
  }
  return value.toISOString();
}

/**
 * Explicit test/demo adapter for the profile persistence boundary.
 *
 * This adapter is intentionally process-local. It has no default tenant,
 * no SnapGad seed profile, no network client, and no database behavior.
 */
export function createInMemoryAiasProfileRepository(
  options: InMemoryAiasProfileRepositoryOptions = {},
): InMemoryAiasProfileRepository {
  const records = new Map<string, AiasOrganizationProfileRecord>();
  const auditEvents: AiasProfileAuditEvent[] = [];
  const now = options.now ?? (() => new Date());

  const repository: InMemoryAiasProfileRepository = {
    async getProfile(organizationId) {
      requireOrganizationId(organizationId);
      const record = records.get(organizationId);
      return record ? clone(record) : null;
    },

    async saveProfile(input) {
      if (!input || typeof input !== "object") {
        throw new AiasProfileConfigurationError(
          "An explicit AIAS profile save input is required.",
        );
      }

      requireOrganizationId(input.organizationId);
      requireActorId(input.actorId);
      validateExpectedVersion(input.expectedVersion);

      const profile = parseProfile(input.profile);
      const metadata = parseAuditMetadata(input.auditMetadata);

      const current = records.get(input.organizationId);
      if (current && input.expectedVersion === undefined) {
        throw new AiasProfileConfigurationError(
          "expectedVersion is required when updating an existing AIAS profile.",
        );
      }
      const actualVersion = current?.version ?? null;
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== actualVersion
      ) {
        throw new AiasProfileVersionConflictError(
          input.organizationId,
          input.expectedVersion,
          actualVersion,
        );
      }

      const version = (current?.version ?? 0) + 1;
      const timestamp = changedAt(now);
      const record: AiasOrganizationProfileRecord = {
        organizationId: input.organizationId,
        version,
        profile: clone(profile),
        updatedAt: timestamp,
        updatedBy: input.actorId,
        profileHash: hashProfile(profile),
      };

      if (metadata !== undefined) record.auditMetadata = clone(metadata);
      records.set(input.organizationId, record);

      const event: AiasProfileAuditEvent = {
        organizationId: input.organizationId,
        actorId: input.actorId,
        fromVersion: actualVersion,
        toVersion: version,
        changedAt: timestamp,
      };
      if (metadata !== undefined) event.metadata = clone(metadata);
      auditEvents.push(event);

      return clone(record);
    },

    async listAuditEvents(organizationId) {
      requireOrganizationId(organizationId);
      return clone(
        auditEvents.filter((event) => event.organizationId === organizationId),
      );
    },

    async get(organizationId) {
      return repository.getProfile(organizationId);
    },

    async save(input) {
      return repository.saveProfile(input);
    },

    async updateProfile(input) {
      return repository.saveProfile(input);
    },

    async getAuditEvents(organizationId) {
      return repository.listAuditEvents(organizationId);
    },
  };

  return repository;
}
