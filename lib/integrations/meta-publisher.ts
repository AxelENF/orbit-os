import "server-only";

type MetaEnvironment = Record<string, string | undefined>;

const REQUIRED_APP_VARIABLES = [
  "META_APP_ID",
  "META_APP_SECRET",
] as const;

export type MetaAppPreflight =
  | { status: "READY" }
  | { status: "NOT_CONFIGURED"; missing: Array<(typeof REQUIRED_APP_VARIABLES)[number]> };

/**
 * Deliberately an app configuration boundary, not a publisher. Organization
 * page credentials live in the database and are not checked here.
 */
export function createMetaPublisher(environment: MetaEnvironment = process.env) {
  return {
    async preflightApp(): Promise<MetaAppPreflight> {
      const missing = REQUIRED_APP_VARIABLES.filter((key) => !environment[key]?.trim());
      return missing.length > 0 ? { status: "NOT_CONFIGURED", missing } : { status: "READY" };
    },
  };
}
