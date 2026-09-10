import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AiasProfileConfigurationError,
  AiasProfileVersionConflictError,
} from "@/lib/organizations/profile-repository";
import { parseAiasOrganizationProfile } from "@/lib/aias/contracts";
import { SupabaseAiasProfileRepository } from "@/lib/organizations/supabase-profile-repository";

const organizationA = "00000000-0000-0000-0000-000000000001";
const organizationB = "00000000-0000-0000-0000-000000000002";
const actorA = "10000000-0000-0000-0000-000000000001";

function validProfile(overrides: Record<string, unknown> = {}) {
  return {
    businessName: "Clínica Norte",
    industry: "Salud",
    offerings: ["Consulta general"],
    idealCustomer: "Personas que necesitan atención médica",
    tone: "Claro y humano",
    defaultCta: "Escribe AGENDA",
    timezone: "America/Mexico_City",
    ...overrides,
  };
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`)
    .join(",")}}`;
}

function profileHash(profile: unknown) {
  return createHash("sha256").update(stableSerialize(profile)).digest("hex");
}

function profileRow(
  organizationId: string,
  profile: unknown | null,
  version = 1,
  metadata: Record<string, unknown> = {},
) {
  return {
    organization_id: organizationId,
    aias_profile: profile,
    profile_version: version,
    profile_hash: profile ? profileHash(profile) : null,
    updated_by: profile ? actorA : null,
    updated_at: "2026-09-09T10:00:00.000Z",
    profile_metadata: metadata,
  };
}

function queryBuilder(data: unknown, error: null | { message: string } = null) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => Promise.resolve({ data, error })),
    maybeSingle: vi.fn(() => Promise.resolve({ data, error })),
  };
  return builder;
}

function clientWith(options: {
  queryData?: unknown;
  rpcData?: unknown;
  rpcError?: { message: string } | null;
  historyData?: unknown;
}) {
  const query = queryBuilder(options.queryData ?? null);
  const history = queryBuilder(options.historyData ?? []);
  const rpc = vi.fn(async () => ({
    data: options.rpcData ?? null,
    error: options.rpcError ?? null,
  }));
  const client = {
    from: vi.fn((table: string) =>
      table === "organization_brand_profile_history" ? history : query,
    ),
    rpc,
  };
  return {
    client,
    query,
    history,
    rpc,
  };
}

function repositoryFor(client: ReturnType<typeof clientWith>["client"]) {
  return new SupabaseAiasProfileRepository(
    client as unknown as SupabaseClient,
  );
}

describe("Supabase AIAS profile repository", () => {
  it("reads no configured profile without inventing a tenant profile", async () => {
    const mock = clientWith({ queryData: profileRow(organizationA, null) });
    const repository = repositoryFor(mock.client);

    await expect(repository.getProfile(organizationA)).resolves.toBeNull();
    expect(mock.client.from).toHaveBeenCalledWith("organization_brand_profiles");
    expect(mock.query.eq).toHaveBeenCalledWith("organization_id", organizationA);
  });

  it("maps a configured profile and preserves its version/hash/audit metadata", async () => {
    const profile = parseAiasOrganizationProfile(validProfile());
    const mock = clientWith({
      queryData: profileRow(organizationA, profile, 3, { source: "onboarding" }),
    });
    const repository = repositoryFor(mock.client);

    await expect(repository.getProfile(organizationA)).resolves.toEqual({
      organizationId: organizationA,
      version: 3,
      profile,
      updatedAt: "2026-09-09T10:00:00.000Z",
      updatedBy: actorA,
      profileHash: profileHash(profile),
      auditMetadata: { source: "onboarding" },
    });
  });

  it("saves through the version-checked RPC with a canonical SHA-256 hash", async () => {
    const profile = parseAiasOrganizationProfile(validProfile());
    const mock = clientWith({
      rpcData: profileRow(organizationA, profile, 1, { source: "human" }),
    });
    const repository = repositoryFor(mock.client);

    const saved = await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      profile,
      auditMetadata: { source: "human" },
    });

    expect(saved.version).toBe(1);
    expect(mock.rpc).toHaveBeenCalledWith("save_aias_organization_profile", {
      p_organization_id: organizationA,
      p_actor_id: actorA,
      p_profile: profile,
      p_profile_canonical: stableSerialize(profile),
      p_profile_hash: profileHash(profile),
      p_expected_version: null,
      p_profile_metadata: { source: "human" },
    });
  });

  it("passes an expected version for updates and exposes version conflicts", async () => {
    const profile = parseAiasOrganizationProfile(validProfile({ tone: "Directo" }));
    const mock = clientWith({
      rpcData: profileRow(organizationA, profile, 2),
    });
    const repository = repositoryFor(mock.client);

    await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      expectedVersion: 1,
      profile,
    });
    expect(mock.rpc).toHaveBeenCalledWith(
      "save_aias_organization_profile",
      expect.objectContaining({ p_expected_version: 1 }),
    );

    const conflict = clientWith({
      rpcError: { message: "AIAS_PROFILE_VERSION_CONFLICT" },
    });
    await expect(
      repositoryFor(conflict.client).saveProfile({
        organizationId: organizationA,
        actorId: actorA,
        expectedVersion: 1,
        profile,
      }),
    ).rejects.toBeInstanceOf(AiasProfileVersionConflictError);
  });

  it("keeps reads and audit history scoped to the requested organization", async () => {
    const mock = clientWith({
      queryData: profileRow(organizationA, validProfile()),
      historyData: [
        {
          organization_id: organizationA,
          profile_version: 1,
          profile_hash: "a".repeat(64),
          changed_by: actorA,
          profile_metadata: { source: "onboarding" },
          created_at: "2026-09-09T10:00:00.000Z",
        },
      ],
    });
    const repository = repositoryFor(mock.client);

    await repository.getProfile(organizationB);
    await repository.listAuditEvents(organizationB);
    expect(mock.query.eq).toHaveBeenCalledWith("organization_id", organizationB);
    expect(mock.history.eq).toHaveBeenCalledWith("organization_id", organizationB);
  });

  it("maps history versions to append-only audit events", async () => {
    const mock = clientWith({
      historyData: [
        {
          organization_id: organizationA,
          profile_version: 1,
          profile_hash: "a".repeat(64),
          changed_by: actorA,
          profile_metadata: {},
          created_at: "2026-09-09T10:00:00.000Z",
        },
        {
          organization_id: organizationA,
          profile_version: 2,
          profile_hash: "b".repeat(64),
          changed_by: actorA,
          profile_metadata: { reason: "updated" },
          created_at: "2026-09-09T11:00:00.000Z",
        },
      ],
    });
    const repository = repositoryFor(mock.client);

    await expect(repository.listAuditEvents(organizationA)).resolves.toEqual([
      expect.objectContaining({ fromVersion: null, toVersion: 1 }),
      expect.objectContaining({ fromVersion: 1, toVersion: 2 }),
    ]);
    expect(mock.history.order).toHaveBeenCalledWith("profile_version", {
      ascending: true,
    });
  });

  it("fails closed on invalid profiles, metadata, and missing organization ids", async () => {
    const mock = clientWith({ rpcData: profileRow(organizationA, validProfile()) });
    const repository = repositoryFor(mock.client);

    await expect(repository.getProfile(" ")).rejects.toBeInstanceOf(
      AiasProfileConfigurationError,
    );
    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorA,
        profile: validProfile({ businessName: "" }),
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);
    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorA,
        profile: validProfile(),
        auditMetadata: new Date() as never,
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorA,
        profile: validProfile(),
        auditMetadata: circular as never,
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);
  });
});
