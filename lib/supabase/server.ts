import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

export async function createSupabaseServerClient() {
  if (!hasSupabaseBrowserConfig()) {
    throw new Error("Supabase server configuration is not available.");
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot set cookies; middleware will refresh them.
        }
      },
    },
  });
}
