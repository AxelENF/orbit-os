import type {
  ContentRepository,
  CopyResultRepository,
  PublishResultRepository,
} from "@/lib/content/repository";
import { createDemoRepository } from "@/lib/demo/repository";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

type SupabaseRepositoryEnvironment = Record<string, string | undefined>;

type CreateContentRepositoryOptions = {
  environment?: SupabaseRepositoryEnvironment;
};

export type ContentRepositoryMode = "demo" | "supabase";

let demoRepository:
  | (ContentRepository &
      Pick<CopyResultRepository, "ingestCopyResult"> &
      Pick<PublishResultRepository, "ingestPublishResult">)
  | undefined;

export function getContentRepositoryMode(
  environment: SupabaseRepositoryEnvironment = process.env,
): ContentRepositoryMode {
  return hasSupabaseBrowserConfig(environment) &&
    Boolean(environment.SUPABASE_SERVICE_ROLE_KEY)
    ? "supabase"
    : "demo";
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

  if (getContentRepositoryMode(environment) === "demo") {
    demoRepository ??= createDemoRepository();
    return demoRepository;
  }

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
    throw new Error("An authenticated Supabase user is required.");
  }

  return createSupabaseRepository(createSupabaseServiceRoleClient(), user.id);
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
    Pick<PublishResultRepository, "ingestPublishResult">
> {
  const environment = options.environment ?? process.env;

  if (!hasSupabaseServiceRoleConfig(environment)) {
    demoRepository ??= createDemoRepository();
    return demoRepository;
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
