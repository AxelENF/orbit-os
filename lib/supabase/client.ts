import { createBrowserClient } from "@supabase/ssr";

type PublicSupabaseEnvironment = Record<string, string | undefined>;

function getPublicSupabaseConfig(environment: PublicSupabaseEnvironment) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = environment.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase browser configuration is not available.");
  }

  return { url, anonKey };
}

export function hasSupabaseBrowserConfig(
  environment: PublicSupabaseEnvironment = process.env,
): boolean {
  return Boolean(
    environment.NEXT_PUBLIC_SUPABASE_URL &&
      environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** Constructs an anon-key browser client only after public configuration exists. */
export function createSupabaseBrowserClient() {
  const { url, anonKey } = getPublicSupabaseConfig(process.env);
  return createBrowserClient(url, anonKey);
}
