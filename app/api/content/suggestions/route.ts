import { AssetValidationError, validateAsset } from "@/lib/content/asset-validation";
import { fetchIntakeSuggestions } from "@/lib/content/intake-suggestions";
import { hasIntakeSuggestionBudget, recordIntakeSuggestionUsage } from "@/lib/content/intake-suggestion-budget";

const MAX_REQUEST_COST_USD = Number(process.env.SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD ?? "0.01");

class SuggestionAuthenticationError extends Error {}
class SuggestionConfigurationError extends Error {}

type ResolvedOrganization = { organizationId: string };

type SuggestionsHandlerDependencies = {
  resolveOrganization?: () => Promise<ResolvedOrganization>;
  hasBudget?: (organizationId: string) => Promise<boolean>;
  fetchSuggestions?: typeof fetchIntakeSuggestions;
  recordUsage?: (organizationId: string, usage: NonNullable<Awaited<ReturnType<typeof fetchIntakeSuggestions>>["usage"]>) => Promise<void>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * No demo/anonymous path — deliberately does not reuse
 * createContentRepository(), which falls back to an unauthenticated demo
 * repository when Supabase isn't configured. This route spends real
 * OpenRouter budget and must always resolve a real organization or fail.
 *
 * Corrección tras revisión de Codex CLI: la primera versión de este
 * helper no leía la cookie de organización activa
 * (resolveActiveOrganizationHint en repository-factory.ts) — un usuario
 * con más de una organización habría recibido OrganizationSelectionRequiredError
 * (que este código convertía en 401) incluso teniendo una organización
 * activa válida. Se replica el mismo mecanismo de cookie que ya usa
 * createContentRepository.
 */
async function defaultResolveOrganization(): Promise<ResolvedOrganization> {
  const { getContentRepositoryMode } = await import("@/lib/content/repository-factory");
  const mode = getContentRepositoryMode();
  if (mode !== "supabase") throw new SuggestionConfigurationError();

  const { createSupabaseServerClient } = await import("@/lib/supabase/server");
  const sessionClient = await createSupabaseServerClient();
  const { data: { user }, error } = await sessionClient.auth.getUser();
  if (error || !user) throw new SuggestionAuthenticationError();

  const { data: memberships, error: membershipError } = await sessionClient
    .from("organization_members")
    .select("organization_id, user_id, role")
    .eq("user_id", user.id);
  if (membershipError) throw new SuggestionConfigurationError();

  // Mismo mecanismo de cookie de organización activa que
  // createContentRepository (repository-factory.ts:56-77) — sin esto, un
  // usuario con más de una organización cae siempre en
  // OrganizationSelectionRequiredError.
  const activeOrganizationCookieSecret = process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET;
  let activeOrganizationId: string | null = null;
  if (activeOrganizationCookieSecret) {
    try {
      const { cookies } = await import("next/headers");
      const { ACTIVE_ORGANIZATION_COOKIE } = await import("@/lib/organizations/active-organization");
      const { verifyActiveOrganizationCookieValue } = await import("@/lib/organizations/active-organization-cookie");
      const cookieStore = await cookies();
      activeOrganizationId = verifyActiveOrganizationCookieValue(
        cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value,
        user.id,
        activeOrganizationCookieSecret,
      ) ?? null;
    } catch {
      activeOrganizationId = null;
    }
  }

  const { selectOrganizationMembership } = await import("@/lib/content/repository-factory");
  const { requireOrganizationContext } = await import("@/lib/organizations/context");
  const candidate = selectOrganizationMembership((memberships ?? []) as never, activeOrganizationId);
  const organization = await requireOrganizationContext(candidate.organizationId, {
    getSession: async () => ({ userId: user.id }),
    getMembership: async ({ organizationId, userId }) =>
      candidate.organizationId === organizationId && candidate.userId === userId
        ? { organizationId: candidate.organizationId, userId: candidate.userId, role: candidate.role }
        : null,
  });
  return { organizationId: organization.organizationId };
}

async function defaultHasBudget(organizationId: string): Promise<boolean> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server");
  return hasIntakeSuggestionBudget(createSupabaseServiceRoleClient(), organizationId, MAX_REQUEST_COST_USD);
}

async function defaultRecordUsage(
  organizationId: string,
  usage: NonNullable<Awaited<ReturnType<typeof fetchIntakeSuggestions>>["usage"]>,
): Promise<void> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server");
  await recordIntakeSuggestionUsage(createSupabaseServiceRoleClient(), organizationId, usage);
}

function isFilePart(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value !== "string" && typeof value.arrayBuffer === "function");
}

async function toDataUrl(file: File, mimeType: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export function createSuggestionsHandler(
  dependencies: SuggestionsHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const resolveOrganization = dependencies.resolveOrganization ?? defaultResolveOrganization;
  const hasBudget = dependencies.hasBudget ?? defaultHasBudget;
  const fetchSuggestions = dependencies.fetchSuggestions ?? fetchIntakeSuggestions;
  const recordUsage = dependencies.recordUsage ?? defaultRecordUsage;

  return async function handleSuggestions(request: Request): Promise<Response> {
    let organizationId: string;
    try {
      ({ organizationId } = await resolveOrganization());
    } catch (error) {
      if (error instanceof SuggestionConfigurationError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      return jsonError("AUTHENTICATION_REQUIRED", 401);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("INVALID_MULTIPART_REQUEST", 400);
    }
    const assetFile = formData.get("asset");
    if (!isFilePart(assetFile)) return jsonError("ASSET_REQUIRED", 400);

    let validatedAsset: Awaited<ReturnType<typeof validateAsset>>;
    try {
      validatedAsset = await validateAsset(assetFile);
    } catch (error) {
      if (error instanceof AssetValidationError) return jsonError("INVALID_ASSET", 400);
      return jsonError("ASSET_VALIDATION_FAILED", 400);
    }

    if (!(await hasBudget(organizationId))) {
      return Response.json({ suggestions: null });
    }

    try {
      const imageDataUrl = await toDataUrl(assetFile, validatedAsset.mimeType);
      const result = await fetchSuggestions({ imageDataUrl, environment: process.env });
      if (result.usage) {
        await recordUsage(organizationId, result.usage);
      }
      return Response.json({ suggestions: result.suggestions });
    } catch {
      // fetchIntakeSuggestions only throws for missing required
      // configuration (model/API key/prices) — a real deployment problem,
      // not something the client can retry past.
      return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    }
  };
}

export const POST = createSuggestionsHandler();
