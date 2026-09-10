import { z } from "zod";

import { parseAiasOrganizationProfile } from "@/lib/aias/contracts";
import {
  AiasProfileAccessError,
  AiasProfileConfigurationError,
  AiasProfileVersionConflictError,
  type AiasJsonValue,
  type AiasProfileRepository,
} from "@/lib/organizations/profile-repository";
import { createSupabaseAiasProfileRepository } from "@/lib/organizations/supabase-profile-repository";
import {
  canEditCampaign,
  ORGANIZATION_ROLES,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const organizationIdSchema = z.string().uuid();
const MAX_REQUEST_BYTES = 256_000;
const MAX_JSON_DEPTH = 32;

const noStoreHeaders = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};

type ProfileSession = { userId: string };
type ProfileMembership = { role: OrganizationRole };

type OrganizationProfileHandlerDependencies = {
  getSession: () => Promise<ProfileSession | null>;
  getMembership: (input: {
    organizationId: string;
    userId: string;
  }) => Promise<ProfileMembership | null>;
  getRepository: () => Promise<Pick<AiasProfileRepository, "getProfile" | "saveProfile">>;
};

type OrganizationProfileContext = { params: Promise<{ id: string }> };

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStoreHeaders });
}

function parseOrganizationId(params: { id: string }): string | null {
  const parsed = organizationIdSchema.safeParse(params.id);
  return parsed.success ? parsed.data : null;
}

function isJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): value is AiasJsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (depth >= MAX_JSON_DEPTH) return false;
  if (seen.has(value)) return false;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, seen, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((item) => isJsonValue(item, seen, depth + 1))
    );
  } finally {
    seen.delete(value);
  }
}

function isJsonObject(value: unknown): value is Record<string, AiasJsonValue> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    isJsonValue(value)
  );
}

async function readJson(request: Request): Promise<unknown | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyError("REQUEST_TOO_LARGE");
  }

  const rawPayload = await request.text();
  if (new TextEncoder().encode(rawPayload).byteLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyError("REQUEST_TOO_LARGE");
  }
  try {
    return JSON.parse(rawPayload) as unknown;
  } catch {
    return null;
  }
}

class RequestBodyError extends Error {
  constructor(readonly code: "REQUEST_TOO_LARGE") {
    super(code);
    this.name = "RequestBodyError";
  }
}

function mapRepositoryError(error: unknown, fallback: string): Response {
  if (error instanceof AiasProfileVersionConflictError) {
    return jsonError("PROFILE_VERSION_CONFLICT", 409);
  }
  if (error instanceof AiasProfileAccessError) {
    return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
  }
  if (error instanceof AiasProfileConfigurationError) {
    return jsonError("PROFILE_INTEGRATION_NOT_CONFIGURED", 503);
  }
  return jsonError(fallback, 503);
}

async function resolveMembership(
  dependencies: OrganizationProfileHandlerDependencies,
  organizationId: string,
  session: ProfileSession,
): Promise<ProfileMembership | null> {
  try {
    return await dependencies.getMembership({ organizationId, userId: session.userId });
  } catch {
    throw new MembershipLookupError();
  }
}

class MembershipLookupError extends Error {
  constructor() {
    super("Unable to resolve organization membership.");
    this.name = "MembershipLookupError";
  }
}

export function createOrganizationProfileGetHandler(
  dependencies: OrganizationProfileHandlerDependencies,
): (request: Request, context: OrganizationProfileContext) => Promise<Response> {
  return async function handleGet(_request, context): Promise<Response> {
    let params: { id: string };
    try {
      params = await context.params;
    } catch {
      return jsonError("PROFILE_INTEGRATION_NOT_CONFIGURED", 503);
    }
    const organizationId = parseOrganizationId(params);
    if (!organizationId) return jsonError("INVALID_ORGANIZATION_ID", 400);

    let session: ProfileSession | null;
    try {
      session = await dependencies.getSession();
    } catch {
      return jsonError("PROFILE_INTEGRATION_NOT_CONFIGURED", 503);
    }
    if (!session) return jsonError("AUTHENTICATION_REQUIRED", 401);

    let membership: ProfileMembership | null;
    try {
      membership = await resolveMembership(dependencies, organizationId, session);
    } catch (error) {
      if (error instanceof MembershipLookupError) {
        return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
      }
      throw error;
    }
    if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);

    try {
      const profile = await (await dependencies.getRepository()).getProfile(organizationId);
      if (!profile) return jsonError("PROFILE_NOT_CONFIGURED", 404);
      return jsonOk({ profile });
    } catch (error) {
      return mapRepositoryError(error, "PROFILE_LOOKUP_FAILED");
    }
  };
}

export function createOrganizationProfileSaveHandler(
  dependencies: OrganizationProfileHandlerDependencies,
): (request: Request, context: OrganizationProfileContext) => Promise<Response> {
  return async function handleSave(request, context): Promise<Response> {
    let params: { id: string };
    try {
      params = await context.params;
    } catch {
      return jsonError("PROFILE_INTEGRATION_NOT_CONFIGURED", 503);
    }
    const organizationId = parseOrganizationId(params);
    if (!organizationId) return jsonError("INVALID_ORGANIZATION_ID", 400);

    let session: ProfileSession | null;
    try {
      session = await dependencies.getSession();
    } catch {
      return jsonError("PROFILE_INTEGRATION_NOT_CONFIGURED", 503);
    }
    if (!session) return jsonError("AUTHENTICATION_REQUIRED", 401);

    let membership: ProfileMembership | null;
    try {
      membership = await resolveMembership(dependencies, organizationId, session);
    } catch (error) {
      if (error instanceof MembershipLookupError) {
        return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
      }
      throw error;
    }
    if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);
    if (!canEditCampaign(membership.role)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch (error) {
      if (error instanceof RequestBodyError) return jsonError(error.code, 413);
      return jsonError("INVALID_REQUEST", 400);
    }

    if (!isJsonObject(payload)) return jsonError("INVALID_REQUEST", 400);

    const expectedVersion = payload.expectedVersion;
    if (
      expectedVersion !== undefined &&
      (typeof expectedVersion !== "number" ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 1)
    ) {
      return jsonError("INVALID_EXPECTED_VERSION", 400);
    }

    let profile;
    try {
      profile = parseAiasOrganizationProfile(payload.profile);
    } catch (error) {
      void error;
      return jsonError("INVALID_PROFILE", 400);
    }

    const metadata = payload.metadata;
    if (metadata !== undefined && !isJsonObject(metadata)) {
      return jsonError("INVALID_METADATA", 400);
    }

    let repository: Pick<AiasProfileRepository, "getProfile" | "saveProfile">;
    let currentProfile;
    try {
      repository = await dependencies.getRepository();
      currentProfile = await repository.getProfile(organizationId);
    } catch (error) {
      return mapRepositoryError(error, "PROFILE_LOOKUP_FAILED");
    }

    if (currentProfile && expectedVersion === undefined) {
      return jsonError("EXPECTED_VERSION_REQUIRED", 400);
    }
    if (!currentProfile && expectedVersion !== undefined) {
      return jsonError("PROFILE_VERSION_CONFLICT", 409);
    }

    try {
      const saved = await repository.saveProfile({
        organizationId,
        actorId: session.userId,
        profile,
        expectedVersion,
        auditMetadata: metadata,
      });
      return jsonOk({ profile: saved }, currentProfile ? 200 : 201);
    } catch (error) {
      return mapRepositoryError(error, "PROFILE_SAVE_FAILED");
    }
  };
}

type SupabaseProfileRouteDependencies = {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
};

function createRouteDependencies({
  supabase,
}: SupabaseProfileRouteDependencies): OrganizationProfileHandlerDependencies {
  return {
    getSession: async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();
      return error || !user ? null : { userId: user.id };
    },
    getMembership: async ({ organizationId, userId }) => {
      const { data, error } = await supabase
        .from("organization_members")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      if (
        typeof data.role !== "string" ||
        !ORGANIZATION_ROLES.includes(data.role as OrganizationRole)
      ) {
        throw new Error("Invalid organization role returned by Supabase.");
      }
      return { role: data.role as OrganizationRole };
    },
    getRepository: async () => createSupabaseAiasProfileRepository(supabase),
  };
}

async function withRouteDependencies(
  handler: (
    request: Request,
    context: OrganizationProfileContext,
    dependencies: OrganizationProfileHandlerDependencies,
  ) => Promise<Response>,
  request: Request,
  context: OrganizationProfileContext,
): Promise<Response> {
  try {
    const supabase = await createSupabaseServerClient();
    return await handler(request, context, createRouteDependencies({ supabase }));
  } catch {
    return jsonError("PROFILE_INTEGRATION_NOT_CONFIGURED", 503);
  }
}

export async function GET(request: Request, context: OrganizationProfileContext): Promise<Response> {
  return withRouteDependencies(
    (innerRequest, innerContext, dependencies) =>
      createOrganizationProfileGetHandler(dependencies)(innerRequest, innerContext),
    request,
    context,
  );
}

export async function PUT(request: Request, context: OrganizationProfileContext): Promise<Response> {
  return withRouteDependencies(
    (innerRequest, innerContext, dependencies) =>
      createOrganizationProfileSaveHandler(dependencies)(innerRequest, innerContext),
    request,
    context,
  );
}

export const PATCH = PUT;
