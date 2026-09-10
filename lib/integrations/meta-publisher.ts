import "server-only";

type MetaEnvironment = Record<string, string | undefined>;

const REQUIRED_META_VARIABLES = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_PAGE_ID",
  "META_PAGE_ACCESS_TOKEN",
] as const;

export type MetaPreflight =
  | { status: "READY" }
  | { status: "NOT_CONFIGURED"; missing: Array<(typeof REQUIRED_META_VARIABLES)[number]> };

/**
 * Deliberately a configuration boundary, not a publisher. The page token is
 * server-only and no Meta SDK/network client is constructed by this module.
 */
export function createMetaPublisher(environment: MetaEnvironment = process.env) {
  return {
    async preflight(): Promise<MetaPreflight> {
      const missing = REQUIRED_META_VARIABLES.filter((key) => !environment[key]?.trim());
      return missing.length > 0 ? { status: "NOT_CONFIGURED", missing } : { status: "READY" };
    },
  };
}
