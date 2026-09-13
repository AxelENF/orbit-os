import { createHmac, timingSafeEqual } from "node:crypto";

export const META_OAUTH_NONCE_COOKIE = "snapgad_meta_oauth_nonce";
export const META_OAUTH_STATE_MAX_AGE_SECONDS = 600;

export type MetaOAuthState = {
  organization_id: string;
  nonce: string;
  exp: number;
};

function encodeState(payload: MetaOAuthState): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signState(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSignedMetaOAuthState(payload: MetaOAuthState, secret: string): string {
  const encodedPayload = encodeState(payload);
  return `${encodedPayload}.${signState(encodedPayload, secret)}`;
}

export function verifySignedMetaOAuthState(
  value: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): MetaOAuthState | null {
  const [encodedPayload, signature, extra] = value.split(".");
  if (!encodedPayload || !signature || extra) return null;

  const expectedSignature = signState(encodedPayload, secret);
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const state = parsed as Partial<MetaOAuthState>;
  const expiration = state.exp;
  if (
    typeof state.organization_id !== "string" ||
    state.organization_id.length === 0 ||
    typeof state.nonce !== "string" ||
    state.nonce.length === 0 ||
    typeof expiration !== "number" ||
    !Number.isSafeInteger(expiration) ||
    expiration <= nowSeconds
  ) {
    return null;
  }

  return {
    organization_id: state.organization_id,
    nonce: state.nonce,
    exp: expiration,
  };
}
