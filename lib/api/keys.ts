import "server-only";
import { createHash } from "node:crypto";

export class ApiKeyAuthenticationError extends Error {
  constructor() {
    super("Invalid or revoked API key.");
    this.name = "ApiKeyAuthenticationError";
  }
}

export type ApiKeyPrincipal = {
  organizationId: string;
  userId: string;
  apiKey: { id: string; label: string };
};

// The real Supabase client returns a PostgrestBuilder, which implements
// PromiseLike rather than Promise. PromiseLike keeps this structural type
// compatible with the awaitable returned by maybeSingle().
type ServiceRoleClientLike = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        is: (column: string, value: null) => {
          maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
};

export async function verifyApiKey(
  secret: string,
  serviceClient: ServiceRoleClientLike,
): Promise<ApiKeyPrincipal> {
  const keyHash = createHash("sha256").update(secret).digest("hex");

  const { data: keyRow, error: keyError } = await serviceClient
    .from("organization_api_keys")
    .select("id, organization_id, label, created_by")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (keyError || !keyRow) throw new ApiKeyAuthenticationError();

  const key = keyRow as { id: string; organization_id: string; label: string; created_by: string };
  return {
    organizationId: key.organization_id,
    userId: key.created_by,
    apiKey: { id: key.id, label: key.label },
  };
}
