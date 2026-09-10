import { describe, expect, it } from "vitest";

import {
  createOrganizationProfileGetHandler,
  createOrganizationProfileSaveHandler,
} from "@/app/api/organizations/[id]/profile/route";
import { createInMemoryAiasProfileRepository } from "@/lib/organizations/profile-repository";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000001";

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

function context(id = organizationId) {
  return { params: Promise.resolve({ id }) };
}

function request(body: unknown, method = "PUT") {
  return new Request("http://localhost/api/organizations/profile", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/organizations/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function deeplyNestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: "value" };
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

function dependencies(options: {
  session?: { userId: string } | null;
  membership?: { role: "owner" | "editor" | "reviewer" | "viewer" } | null;
  repository?: ReturnType<typeof createInMemoryAiasProfileRepository>;
} = {}) {
  return {
    getSession: async () =>
      options.session === undefined ? { userId } : options.session,
    getMembership: async ({ organizationId: requestedOrganizationId, userId: requestedUserId }: {
      organizationId: string;
      userId: string;
    }) => {
      void requestedUserId;
      return requestedOrganizationId === organizationId
        ? options.membership ?? { role: "owner" as const }
        : null;
    },
    getRepository: async () =>
      options.repository ?? createInMemoryAiasProfileRepository(),
  };
}

describe("AIAS organization profile API handlers", () => {
  it("returns 401 without an authenticated session and does not inspect membership", async () => {
    let membershipLookups = 0;
    const deps = dependencies({ session: null });
    const response = await createOrganizationProfileGetHandler({
      ...deps,
      getMembership: async () => {
        membershipLookups += 1;
        return null;
      },
    })(new Request("http://localhost"), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "AUTHENTICATION_REQUIRED" });
    expect(membershipLookups).toBe(0);
  });

  it("maps session and route-context failures to a configuration response", async () => {
    const sessionFailure = await createOrganizationProfileGetHandler({
      ...dependencies(),
      getSession: async () => {
        throw new Error("session unavailable");
      },
    })(new Request("http://localhost"), context());
    expect(sessionFailure.status).toBe(503);

    const paramsFailure = await createOrganizationProfileGetHandler(dependencies())(
      new Request("http://localhost"),
      { params: Promise.reject(new Error("params unavailable")) },
    );
    expect(paramsFailure.status).toBe(503);
  });

  it("hides an organization from a user without membership", async () => {
    const deps = dependencies();
    const response = await createOrganizationProfileGetHandler({
      ...deps,
      getMembership: async () => null,
    })(new Request("http://localhost"), context(otherOrganizationId));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "ORGANIZATION_NOT_FOUND" });
  });

  it("returns a no-store 404 when onboarding has not configured a profile", async () => {
    const response = await createOrganizationProfileGetHandler(dependencies())(
      new Request("http://localhost"),
      context(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    await expect(response.json()).resolves.toEqual({ error: "PROFILE_NOT_CONFIGURED" });
  });

  it("returns a configured profile only after membership authorization", async () => {
    const repository = createInMemoryAiasProfileRepository();
    await repository.saveProfile({
      organizationId,
      actorId: userId,
      profile: validProfile(),
    });

    const response = await createOrganizationProfileGetHandler(
      dependencies({ repository }),
    )(new Request("http://localhost"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profile: { organizationId, version: 1, updatedBy: userId },
    });
  });

  it("creates a profile with the authenticated actor and returns its version", async () => {
    const repository = createInMemoryAiasProfileRepository();
    const response = await createOrganizationProfileSaveHandler(
      dependencies({ repository }),
    )(request({ profile: validProfile(), metadata: { source: "onboarding" } }), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      profile: {
        organizationId,
        version: 1,
        updatedBy: userId,
        auditMetadata: { source: "onboarding" },
      },
    });
  });

  it("requires expectedVersion for updates and maps a stale version to 409", async () => {
    const repository = createInMemoryAiasProfileRepository();
    const save = createOrganizationProfileSaveHandler(dependencies({ repository }));
    const created = await save(request({ profile: validProfile() }), context());
    expect(created.status).toBe(201);

    const missingExpectedVersion = await save(
      request({ profile: validProfile({ tone: "Directo" }) }),
      context(),
    );
    expect(missingExpectedVersion.status).toBe(400);
    await expect(missingExpectedVersion.json()).resolves.toEqual({
      error: "EXPECTED_VERSION_REQUIRED",
    });

    const stale = await save(
      request({ profile: validProfile({ tone: "Directo" }), expectedVersion: 7 }),
      context(),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "PROFILE_VERSION_CONFLICT" });
  });

  it("rejects profile edits by a reviewer and invalid metadata before repository writes", async () => {
    let writes = 0;
    const repository = createInMemoryAiasProfileRepository();
    const deps = dependencies({ repository, membership: { role: "reviewer" } });
    const denied = await createOrganizationProfileSaveHandler(deps)(
      request({ profile: validProfile() }),
      context(),
    );
    expect(denied.status).toBe(403);

    const ownerDeps = dependencies({ repository });
    const originalSave = repository.saveProfile;
    repository.saveProfile = async (input) => {
      writes += 1;
      return originalSave(input);
    };
    const invalidMetadata = await createOrganizationProfileSaveHandler(ownerDeps)(
      request({ profile: validProfile(), metadata: "not-an-object" }),
      context(),
    );
    expect(invalidMetadata.status).toBe(400);
    expect(writes).toBe(0);
  });

  it("fails closed for invalid JSON, excessive JSON depth, and oversized payloads", async () => {
    const save = createOrganizationProfileSaveHandler(dependencies());

    const invalidJson = await save(rawRequest("{\"profile\":"), context());
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({ error: "INVALID_REQUEST" });

    const tooDeep = await save(
      request({ profile: validProfile(), metadata: deeplyNestedObject(40) }),
      context(),
    );
    expect(tooDeep.status).toBe(400);
    await expect(tooDeep.json()).resolves.toEqual({ error: "INVALID_REQUEST" });

    const tooLarge = await save(
      rawRequest(JSON.stringify({ profile: validProfile() }), {
        "content-length": "256001",
      }),
      context(),
    );
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({ error: "REQUEST_TOO_LARGE" });
  });
});
