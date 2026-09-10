import "server-only";

/**
 * Browser imports must use this guarded entry point. The unguarded core is
 * also imported directly by the standalone Node worker, where Next's
 * `server-only` marker would throw at runtime even though the process is
 * server-side.
 */
export * from "@/lib/automation/supabase-copy-worker-store";
