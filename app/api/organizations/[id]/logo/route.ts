import { StorageApiError } from "@supabase/supabase-js";
import { z } from "zod";

import {
  canManageConnections,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const organizationIdSchema = z.string().uuid();
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = [
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
];

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

type Session = { userId: string };
type Membership = { role: OrganizationRole };
type RouteContext = { params: Promise<{ id: string }> };

async function resolveAuthAndMembership(
  deps: {
    getSession: () => Promise<Session | null>;
    getMembership: (input: {
      organizationId: string;
      userId: string;
    }) => Promise<Membership | null>;
  },
  params: { id: string },
): Promise<{ organizationId: string; membership: Membership } | Response> {
  const parsed = organizationIdSchema.safeParse(params.id);
  if (!parsed.success) return jsonError("INVALID_ORGANIZATION_ID", 400);

  const session = await deps.getSession();
  if (!session) return jsonError("AUTHENTICATION_REQUIRED", 401);

  let membership: Membership | null;
  try {
    membership = await deps.getMembership({
      organizationId: parsed.data,
      userId: session.userId,
    });
  } catch {
    return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
  }
  if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);

  return { organizationId: parsed.data, membership };
}

function isPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

type GetHandlerDependencies = {
  getSession: () => Promise<Session | null>;
  getMembership: (input: {
    organizationId: string;
    userId: string;
  }) => Promise<Membership | null>;
  download: (path: string) => Promise<{ data: Blob | null; error: unknown }>;
};

export function createOrganizationLogoGetHandler(
  deps: GetHandlerDependencies,
) {
  return async function handleGet(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const resolved = await resolveAuthAndMembership(deps, params);
    if (resolved instanceof Response) return resolved;

    const { data, error } = await deps.download(
      `${resolved.organizationId}/logo.png`,
    );
    if (error) {
      if (
        error instanceof StorageApiError &&
        error.code === "NoSuchKey"
      ) {
        return jsonError("LOGO_NOT_CONFIGURED", 404);
      }
      return jsonError("LOGO_LOOKUP_FAILED", 503);
    }
    if (!data) return jsonError("LOGO_LOOKUP_FAILED", 503);

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  };
}

type PostHandlerDependencies = {
  getSession: () => Promise<Session | null>;
  getMembership: (input: {
    organizationId: string;
    userId: string;
  }) => Promise<Membership | null>;
  upload: (
    path: string,
    body: ArrayBuffer,
    options: { upsert: boolean; contentType: string },
  ) => Promise<{ error: unknown }>;
};

export function createOrganizationLogoPostHandler(
  deps: PostHandlerDependencies,
) {
  return async function handlePost(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const resolved = await resolveAuthAndMembership(deps, params);
    if (resolved instanceof Response) return resolved;
    if (!canManageConnections(resolved.membership.role)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }

    const file = formData.get("logo");
    if (!(file instanceof File)) return jsonError("INVALID_REQUEST", 400);
    if (file.size > MAX_LOGO_BYTES) {
      return jsonError("REQUEST_TOO_LARGE", 413);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPngSignature(bytes)) {
      return jsonError("INVALID_LOGO_FORMAT", 422);
    }

    const { error } = await deps.upload(
      `${resolved.organizationId}/logo.png`,
      bytes.buffer,
      { upsert: true, contentType: "image/png" },
    );
    if (error) return jsonError("LOGO_UPLOAD_FAILED", 503);

    return Response.json(
      { success: true },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  };
}

type RouteDependencies = {
  getSession: () => Promise<Session | null>;
  getMembership: (input: {
    organizationId: string;
    userId: string;
  }) => Promise<Membership | null>;
  download: GetHandlerDependencies["download"];
  upload: PostHandlerDependencies["upload"];
};

async function withDependencies(
  request: Request,
  context: RouteContext,
  handlerFactory: (
    deps: RouteDependencies,
  ) => (request: Request, context: RouteContext) => Promise<Response>,
): Promise<Response> {
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return jsonError("LOGO_INTEGRATION_NOT_CONFIGURED", 503);
  }

  const deps: RouteDependencies = {
    getSession: async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();
      return error || !user ? null : { userId: user.id };
    },
    getMembership: async ({ organizationId, userId }) => {
      const { data, error } = await supabase
        .from("organization_members")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { role: data.role as OrganizationRole };
    },
    download: (path: string) =>
      supabase.storage.from("organization-logos").download(path),
    upload: (path, body, options) =>
      supabase.storage.from("organization-logos").upload(path, body, options),
  };

  try {
    return await handlerFactory(deps)(request, context);
  } catch {
    return jsonError("LOGO_LOOKUP_FAILED", 503);
  }
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return withDependencies(request, context, createOrganizationLogoGetHandler);
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return withDependencies(request, context, createOrganizationLogoPostHandler);
}
