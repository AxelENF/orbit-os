import { describe, expect, it } from "vitest";

import {
  AiasProfileAccessError,
  AiasProfileConfigurationError,
  AiasProfileVersionConflictError,
  createInMemoryAiasProfileRepository,
} from "@/lib/organizations/profile-repository";
import type { AiasProfileAuditMetadata } from "@/lib/organizations/profile-repository";

const organizationA = "org-a";
const organizationB = "org-b";
const actorA = "actor-a";
const actorB = "actor-b";

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

describe("in-memory AIAS profile repository", () => {
  it("keeps profiles isolated by organization and returns null when absent", async () => {
    const repository = createInMemoryAiasProfileRepository();

    await expect(repository.getProfile(organizationA)).resolves.toBeNull();

    const savedA = await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      profile: validProfile({ businessName: "Organización A" }),
    });
    const savedB = await repository.saveProfile({
      organizationId: organizationB,
      actorId: actorB,
      profile: validProfile({ businessName: "Organización B" }),
    });

    expect(savedA.version).toBe(1);
    expect(savedB.version).toBe(1);
    await expect(repository.getProfile(organizationA)).resolves.toMatchObject({
      organizationId: organizationA,
      version: 1,
      updatedBy: actorA,
    });
    await expect(repository.getProfile("org-missing")).resolves.toBeNull();
  });

  it("starts at version one, increments updates, and changes the profile hash", async () => {
    const repository = createInMemoryAiasProfileRepository();
    const first = await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      profile: validProfile(),
    });
    const second = await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorB,
      expectedVersion: first.version,
      profile: validProfile({ offerings: ["Consulta general", "Consulta de seguimiento"] }),
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.profileHash).toBeTruthy();
    expect(second.profileHash).not.toBe(first.profileHash);
    expect(second.updatedBy).toBe(actorB);
  });

  it("rejects stale expected versions without changing the current record", async () => {
    const repository = createInMemoryAiasProfileRepository();
    const first = await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      profile: validProfile(),
    });

    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorB,
        expectedVersion: first.version + 1,
        profile: validProfile({ businessName: "No debe guardarse" }),
      }),
    ).rejects.toMatchObject({
      name: "AiasProfileVersionConflictError",
      organizationId: organizationA,
      expectedVersion: 2,
      actualVersion: 1,
    });

    await expect(repository.getProfile(organizationA)).resolves.toMatchObject({
      version: 1,
      profile: { businessName: "Clínica Norte" },
    });
  });

  it("requires expectedVersion for every update after the initial create", async () => {
    const repository = createInMemoryAiasProfileRepository();
    await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      profile: validProfile(),
    });

    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorB,
        profile: validProfile({ tone: "No debe guardarse" }),
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);

    await expect(repository.getProfile(organizationA)).resolves.toMatchObject({
      version: 1,
      profile: { tone: "Claro y humano" },
    });
  });

  it("requires an explicit organization and actor", async () => {
    const repository = createInMemoryAiasProfileRepository();

    await expect(repository.getProfile(" ")).rejects.toBeInstanceOf(
      AiasProfileConfigurationError,
    );
    await expect(
      repository.saveProfile({
        organizationId: " ",
        actorId: actorA,
        profile: validProfile(),
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);
    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: "",
        profile: validProfile(),
      }),
    ).rejects.toBeInstanceOf(AiasProfileAccessError);
  });

  it("rejects an invalid profile through the AIAS parser", async () => {
    const repository = createInMemoryAiasProfileRepository();

    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorA,
        profile: validProfile({ businessName: "" }),
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);
  });

  it("rejects non-JSON audit metadata", async () => {
    const repository = createInMemoryAiasProfileRepository();

    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorA,
        profile: validProfile(),
        auditMetadata: new Date() as unknown as AiasProfileAuditMetadata,
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);
  });

  it("rejects circular audit metadata without overflowing the stack", async () => {
    const repository = createInMemoryAiasProfileRepository();
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;

    await expect(
      repository.saveProfile({
        organizationId: organizationA,
        actorId: actorA,
        profile: validProfile(),
        auditMetadata: metadata as AiasProfileAuditMetadata,
      }),
    ).rejects.toBeInstanceOf(AiasProfileConfigurationError);
  });

  it("clones profiles and metadata at write and read boundaries", async () => {
    const repository = createInMemoryAiasProfileRepository();
    const input = validProfile({ offerings: ["Consulta general"] });
    const metadata = { source: "human-review", labels: ["approved"] };
    const saved = await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      profile: input,
      auditMetadata: metadata,
    });

    input.offerings.push("Mutación externa");
    metadata.labels.push("mutación externa");
    saved.profile.offerings.push("Mutación del resultado");
    (saved.auditMetadata!.labels as string[]).push("mutación del resultado");

    const current = await repository.getProfile(organizationA);
    expect(current?.profile.offerings).toEqual(["Consulta general"]);
    expect(current?.auditMetadata).toEqual({
      source: "human-review",
      labels: ["approved"],
    });

    current!.profile.offerings.push("Mutación de lectura");
    await expect(repository.getProfile(organizationA)).resolves.toMatchObject({
      profile: { offerings: ["Consulta general"] },
    });
  });

  it("records create and update audit events per organization", async () => {
    const repository = createInMemoryAiasProfileRepository();
    const first = await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorA,
      profile: validProfile(),
    });
    await repository.saveProfile({
      organizationId: organizationA,
      actorId: actorB,
      expectedVersion: first.version,
      profile: validProfile({ tone: "Directo" }),
    });
    await repository.saveProfile({
      organizationId: organizationB,
      actorId: actorB,
      profile: validProfile({ businessName: "Organización B" }),
    });

    await expect(repository.listAuditEvents(organizationA)).resolves.toMatchObject([
      {
        organizationId: organizationA,
        actorId: actorA,
        fromVersion: null,
        toVersion: 1,
      },
      {
        organizationId: organizationA,
        actorId: actorB,
        fromVersion: 1,
        toVersion: 2,
      },
    ]);
    await expect(repository.listAuditEvents(organizationB)).resolves.toHaveLength(1);
    await expect(repository.listAuditEvents("org-missing")).resolves.toEqual([]);
  });

  it("exposes typed errors for version conflicts", () => {
    const error = new AiasProfileVersionConflictError(organizationA, 3, 2);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AiasProfileVersionConflictError");
    expect(error.organizationId).toBe(organizationA);
    expect(error.expectedVersion).toBe(3);
    expect(error.actualVersion).toBe(2);
  });
});
