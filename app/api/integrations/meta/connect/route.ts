import { createHmac, randomUUID } from "node:crypto";

import { cookies } from "next/headers";

import {
  canManageConnections,
  type OrganizationRole,
} from "@/lib/organizations/permissions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const META_OAUTH_NONCE_COOKIE = "snapgad_meta_oauth_nonce";
export const META_OAUTH_STATE_MAX_AGE_SECONDS = 600;

const META_OAUTH_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
].join(",");

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Cookie",
      },
    },
  );
}

function encodeState(payload: { organization_id: string; nonce: string; exp: number }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signState(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createSignedState(
  payload: { organization_id: string; nonce: string; exp: number },
  secret: string,
): string {
  const encodedPayload = encodeState(payload);
  return `${encodedPayload}.${signState(encodedPayload, secret)}`;
}

export async function GET(request: Request): Promise<Response> {
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim();
  if (!organizationId) return jsonError("INVALID_ORGANIZATION_ID", 400);

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: sessionError,
    } = await supabase.auth.getUser();
    if (sessionError || !user) return jsonError("AUTHENTICATION_REQUIRED", 401);

    const { data: membership, error: membershipError } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipError) return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
    if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);
    if (!canManageConnections(membership.role as OrganizationRole)) {
      return jsonError("ORGANIZATION_ACCESS_DENIED", 403);
    }

    const appId = process.env.META_APP_ID?.trim();
    const appSecret = process.env.META_APP_SECRET?.trim();
    if (!appId || !appSecret) return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);

    const nonce = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + META_OAUTH_STATE_MAX_AGE_SECONDS;
    const state = createSignedState(
      { organization_id: organizationId, nonce, exp: expiresAt },
      appSecret,
    );

    const callbackUrl = new URL("/api/integrations/meta/callback", request.url);
    const authorizationUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    authorizationUrl.searchParams.set("client_id", appId);
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl.toString());
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", META_OAUTH_SCOPES);

    const cookieStore = await cookies();
    cookieStore.set(META_OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      maxAge: META_OAUTH_STATE_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: authorizationUrl.toString(),
        Vary: "Cookie",
      },
    });
  } catch {
    return jsonError("META_INTEGRATION_NOT_CONFIGURED", 503);
  }
}
