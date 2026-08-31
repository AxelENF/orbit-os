import type { ContentRepository } from "@/lib/content/repository";
import { createDemoRepository } from "@/lib/demo/repository";
import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

type SupabaseRepositoryEnvironment = Record<string, string | undefined>;

type CreateContentRepositoryOptions = {
  environment?: SupabaseRepositoryEnvironment;
};

export type ContentRepositoryMode = "demo" | "supabase";

let demoRepository: ContentRepository | undefined;

export function getContentRepositoryMode(
  environment: SupabaseRepositoryEnvironment = process.env,
): ContentRepositoryMode {
  return hasSupabaseBrowserConfig(environment) &&
    Boolean(environment.SUPABASE_SERVICE_ROLE_KEY)
    ? "supabase"
    : "demo";
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

/** Test support only; production code never resets process-local demo state. */
export function resetDemoRepositoryForTests(): void {
  demoRepository = undefined;
}
