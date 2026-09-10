import type {
  ContentRepository,
  CopyResultRepository,
  PublishResultRepository,
} from "@/lib/content/repository";
import { createDemoRepository } from "@/lib/demo/repository";
import {
  OrganizationAccessError,
  type OrganizationContext,
  requireOrganizationContext,
} from "@/lib/organizations/context";
import {
  ACTIVE_ORGANIZATION_COOKIE,
  resolveActiveOrganization,
} from "@/lib/organizations/active-organization";
import { verifyActiveOrganizationCookieValue } from "@/lib/organizations/active-organization-cookie";
import type { OrganizationRole } from "@/lib/organizations/permissions";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";
import type { CopyJobWorkerRepository } from "@/lib/automation/jobs";

type SupabaseRepositoryEnvironment = Record<string, string | undefined>;

type CreateContentRepositoryOptions = {
  environment?: SupabaseRepositoryEnvironment;
  /**
   * Optional active organization hint. It is accepted only after matching
   * the authenticated user's memberships below.
   */
  activeOrganizationId?: string | null;
};

export type ContentRepositoryMode = "demo" | "supabase" | "misconfigured";

export class ContentAuthenticationError extends Error {
  constructor() {
    super("An authenticated Supabase user is required.");
    this.name = "ContentAuthenticationError";
  }
}

export class ContentConfigurationError extends Error {
  constructor() {
    super("Supabase server configuration is incomplete.");
    this.name = "ContentConfigurationError";
  }
}

export { OrganizationSelectionRequiredError } from "@/lib/organizations/active-organization";

type OrganizationMembershipRow = {
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
};

async function resolveActiveOrganizationHint(
  explicitOrganizationId: string | null | undefined,
  userId: string,
): Promise<string | null | undefined> {
  if (explicitOrganizationId !== undefined) return explicitOrganizationId;

  const secret = process.env.SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET;
  if (!secret) return null;

  try {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    return verifyActiveOrganizationCookieValue(
      cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value,
      userId,
      secret,
    );
  } catch {
    // Tests and non-request server contexts have no cookie store; fail closed.
    return null;
  }
}

/**
 * Resolve a membership after an optional active-organization selection.
 *
 * The selected id is only a hint: it is accepted after matching it against
 * the memberships returned for the authenticated session. Without a hint we
 * fail closed for multi-organization users instead of silently choosing one.
 */
export function selectOrganizationMembership(
  memberships: readonly OrganizationMembershipRow[],
  activeOrganizationId?: string | null,
): OrganizationContext {
  return resolveActiveOrganization(
    memberships.map(({ organization_id, user_id, role }) => ({
      organizationId: organization_id,
      userId: user_id,
      role,
    })),
    activeOrganizationId,
  );
}

export function selectSingleOrganizationMembership(
  memberships: readonly OrganizationMembershipRow[],
): OrganizationContext {
  return selectOrganizationMembership(memberships);
}

let demoRepository:
  | (ContentRepository &
      Pick<CopyResultRepository, "ingestCopyResult"> &
      Pick<PublishResultRepository, "ingestPublishResult">)
  | undefined;

export function getContentRepositoryMode(
  environment: SupabaseRepositoryEnvironment = process.env,
): ContentRepositoryMode {
  const hasAnySupabaseSetting = Boolean(
    environment.NEXT_PUBLIC_SUPABASE_URL ||
      environment.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      environment.SUPABASE_SERVICE_ROLE_KEY,
  );
  if (!hasAnySupabaseSetting) return "demo";
  if (!hasSupabaseBrowserConfig(environment) || !environment.SUPABASE_SERVICE_ROLE_KEY) {
    return "misconfigured";
  }
  return "supabase";
}

function hasSupabaseServiceRoleConfig(
  environment: SupabaseRepositoryEnvironment,
): boolean {
  return Boolean(
    environment.NEXT_PUBLIC_SUPABASE_URL &&
      environment.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * Resolves persistence only on the server. No configuration means an isolated,
 * no-network demo repository.
 */
export async function createContentRepository(
  options: CreateContentRepositoryOptions = {},
): Promise<ContentRepository> {
  const environment = options.environment ?? process.env;

  const mode = getContentRepositoryMode(environment);
  if (mode === "demo") {
    demoRepository ??= createDemoRepository();
    return demoRepository;
  }
  if (mode === "misconfigured") throw new ContentConfigurationError();

  const [{ createSupabaseServerClient, createSupabaseServiceRoleClient }, { createSupabaseRepository }] =
    await Promise.all([
      import("@/lib/supabase/server"),
      import("@/lib/supabase/repository"),
    ]);
  const sessionClient = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await sessionClient.auth.getUser();

  if (error || !user) {
    throw new ContentAuthenticationError();
  }

  const { data: memberships, error: membershipError } = await sessionClient
    .from("organization_members")
    .select("organization_id, user_id, role")
    .eq("user_id", user.id);
  if (membershipError) throw new OrganizationAccessError();

  const activeOrganizationId = await resolveActiveOrganizationHint(
    options.activeOrganizationId,
    user.id,
  );
  const candidate = selectOrganizationMembership(
    (memberships ?? []) as OrganizationMembershipRow[],
    activeOrganizationId,
  );
  const organization = await requireOrganizationContext(candidate.organizationId, {
    getSession: async () => ({ userId: user.id }),
    getMembership: async ({ organizationId, userId }) =>
      candidate.organizationId === organizationId && candidate.userId === userId
        ? {
            organizationId: candidate.organizationId,
            userId: candidate.userId,
            role: candidate.role,
          }
        : null,
  });

  return createSupabaseRepository(createSupabaseServiceRoleClient(), organization);
}

/**
 * Resolves the HMAC-authenticated machine-to-machine callback boundary.
 * Supabase callbacks use only the service-role client; owner identity is
 * derived from the locked content item inside the database RPC.
 */
export async function createN8nCallbackRepository(
  options: CreateContentRepositoryOptions = {},
): Promise<
  Pick<CopyResultRepository, "ingestCopyResult"> &
    Pick<PublishResultRepository, "ingestPublishResult"> &
    CopyJobWorkerRepository
> {
  const environment = options.environment ?? process.env;

  const hasAnySupabaseSetting = Boolean(
    environment.NEXT_PUBLIC_SUPABASE_URL ||
      environment.SUPABASE_SERVICE_ROLE_KEY,
  );
  if (!hasAnySupabaseSetting) {
    demoRepository ??= createDemoRepository();
    return demoRepository;
  }
  if (!hasSupabaseServiceRoleConfig(environment)) {
    throw new ContentConfigurationError();
  }

  const [{ createSupabaseServiceRoleClient }, { createSupabaseCallbackRepository }] =
    await Promise.all([
      import("@/lib/supabase/server"),
      import("@/lib/supabase/repository"),
    ]);

  return createSupabaseCallbackRepository(createSupabaseServiceRoleClient());
}

/** Test support only; production code never resets process-local demo state. */
export function resetDemoRepositoryForTests(): void {
  demoRepository = undefined;
}
