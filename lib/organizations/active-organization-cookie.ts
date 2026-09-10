import { createHmac, timingSafeEqual } from "node:crypto";

export const ACTIVE_ORGANIZATION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type ActiveOrganizationCookiePayload = {
  organizationId: string;
  userId: string;
  expiresAt: number;
};

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function encode(payload: ActiveOrganizationCookiePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode(value: string): ActiveOrganizationCookiePayload | null {
  try {
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<
      ActiveOrganizationCookiePayload
    >;
    if (
      typeof payload.organizationId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return null;
    }
    return payload as ActiveOrganizationCookiePayload;
  } catch {
    return null;
  }
}

export function createActiveOrganizationCookieValue(
  input: Omit<ActiveOrganizationCookiePayload, "expiresAt"> &
    Partial<Pick<ActiveOrganizationCookiePayload, "expiresAt">>,
  secret: string,
): string {
  if (!secret) throw new Error("Active organization cookie secret is required.");

  const payload = encode({
    organizationId: input.organizationId,
    userId: input.userId,
    expiresAt:
      input.expiresAt ?? Math.floor(Date.now() / 1000) + ACTIVE_ORGANIZATION_COOKIE_MAX_AGE_SECONDS,
  });
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyActiveOrganizationCookieValue(
  value: string | null | undefined,
  expectedUserId: string,
  secret: string | undefined,
  now = Math.floor(Date.now() / 1000),
): string | null {
  if (!value || !secret || !expectedUserId) return null;

  const [payloadValue, signature, extra] = value.split(".");
  if (!payloadValue || !signature || extra) return null;

  const expectedSignature = sign(payloadValue, secret);
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }

  const payload = decode(payloadValue);
  if (!payload || payload.userId !== expectedUserId || payload.expiresAt <= now) {
    return null;
  }

  return payload.organizationId;
}
