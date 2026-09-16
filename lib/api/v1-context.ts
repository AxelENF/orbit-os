import "server-only";

import { verifyApiKey, ApiKeyAuthenticationError } from "@/lib/api/keys";
import { getContentRepositoryMode } from "@/lib/content/repository-factory";
import {
  requireOrganizationContext,
  OrganizationAccessError,
  type OrganizationApiKeyContext,
} from "@/lib/organizations/context";
import { createSupabaseRepository } from "@/lib/supabase/repository";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type { ContentRepository } from "@/lib/content/repository";
import type { OrganizationContext } from "@/lib/organizations/context";

export class V1AuthenticationError extends Error {
  constructor() {
    super("Invalid or missing API key.");
    this.name = "V1AuthenticationError";
  }
}

export class V1NotConfiguredError extends Error {
  constructor() {
    super("API v1 is not available: Supabase is not configured.");
    this.name = "V1NotConfiguredError";
  }
}

export type V1RequestContext = {
  organization: OrganizationContext;
  repository: ContentRepository;
};

type ApiKeyVerificationClient = Parameters<typeof verifyApiKey>[1];

function createApiKeyVerificationClient(
  serviceClient: ReturnType<typeof createSupabaseServiceRoleClient>,
): ApiKeyVerificationClient {
  return {
    from: (table) => ({
      select: (columns) => ({
        eq: (column, value) => ({
          is: (isColumn, isValue) => ({
            maybeSingle: async (): Promise<{ data: unknown; error: unknown }> => {
              const { data, error } = await serviceClient
                .from(table)
                .select(columns)
                .eq(column, value)
                .is(isColumn, isValue)
                .maybeSingle();
              return { data, error };
            },
          }),
        }),
      }),
    }),
  };
}

function extractBearerSecret(request: Request): string {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer (.+)$/);
  if (!match) throw new V1AuthenticationError();
  return match[1];
}

// Construye un repositorio nuevo, no cacheado, en cada llamada — nunca se
// reutiliza entre requests concurrentes (a diferencia del demoRepository
// singleton de repository-factory.ts, que este módulo evita por completo
// al rechazar el modo demo antes de llegar ahí).
export async function resolveV1RequestContext(request: Request): Promise<V1RequestContext> {
  if (getContentRepositoryMode() !== "supabase") {
    throw new V1NotConfiguredError();
  }

  const secret = extractBearerSecret(request);
  const serviceClient = createSupabaseServiceRoleClient();

  let apiKeyPrincipal: { organizationId: string; userId: string; apiKey: OrganizationApiKeyContext };
  try {
    apiKeyPrincipal = await verifyApiKey(secret, createApiKeyVerificationClient(serviceClient));
  } catch (error) {
    if (error instanceof ApiKeyAuthenticationError) throw new V1AuthenticationError();
    throw error;
  }

  let membership: OrganizationContext;
  try {
    membership = await requireOrganizationContext(apiKeyPrincipal.organizationId, {
      getSession: async () => ({ userId: apiKeyPrincipal.userId }),
      getMembership: async ({ organizationId, userId }) => {
        const { data, error } = await serviceClient
          .from("organization_members")
          .select("organization_id, user_id, role")
          .eq("organization_id", organizationId)
          .eq("user_id", userId)
          .maybeSingle();
        if (error || !data) return null;
        const row = data as { organization_id: string; user_id: string; role: string };
        return { organizationId: row.organization_id, userId: row.user_id, role: row.role as never };
      },
    });
  } catch (error) {
    if (error instanceof OrganizationAccessError) throw new V1AuthenticationError();
    throw error;
  }

  // Explícito: aunque cualquier rol produce un OrganizationContext válido,
  // solo un owner puede haber creado esta clave (create_organization_api_key
  // lo exige) — si ya no lo es, se trata igual que una clave inválida.
  if (membership.role !== "owner") throw new V1AuthenticationError();

  const organization: OrganizationContext = { ...membership, apiKey: apiKeyPrincipal.apiKey };
  const repository = createSupabaseRepository(serviceClient, organization);
  return { organization, repository };
}
