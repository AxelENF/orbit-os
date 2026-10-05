import "server-only";

/**
 * Guarded Next.js entry point for routes. The standalone worker must import
 * the unguarded core module directly because `server-only` intentionally
 * throws outside Next's server-module runtime.
 */
export { resolveOrganizationOpenRouterCredential } from "@/lib/ai/openrouter-organization-credential";
