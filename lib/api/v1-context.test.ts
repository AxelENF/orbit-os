/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/keys", () => ({
  verifyApiKey: vi.fn(),
  ApiKeyAuthenticationError: class ApiKeyAuthenticationError extends Error {},
}));
vi.mock("@/lib/content/repository-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/content/repository-factory")>();
  return { ...actual, getContentRepositoryMode: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/supabase/repository", () => ({
  createSupabaseRepository: vi.fn(),
}));

import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";
import { verifyApiKey } from "@/lib/api/keys";
import { getContentRepositoryMode } from "@/lib/content/repository-factory";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseRepository } from "@/lib/supabase/repository";

function requestWithAuth(header?: string) {
  const headers = new Headers();
  if (header) headers.set("authorization", header);
  return new Request("http://localhost/api/v1/campaigns", { headers });
}

function fakeServiceClient(membershipRow: unknown, membershipError: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: membershipRow, error: membershipError });
  const eq2 = vi.fn().mockReturnValue({ maybeSingle });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

describe("resolveV1RequestContext", () => {
  it("rejects a missing Authorization header", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    await expect(resolveV1RequestContext(requestWithAuth())).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects a header that isn't a Bearer token", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    await expect(resolveV1RequestContext(requestWithAuth("Basic xyz"))).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects when the app is in demo or misconfigured mode, even with a well-formed key", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("demo");
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"))).rejects.toThrow(V1NotConfiguredError);
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it("wraps ApiKeyAuthenticationError as V1AuthenticationError, not an unhandled exception", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fakeServiceClient(null) as never);
    const { ApiKeyAuthenticationError } = await import("@/lib/api/keys");
    vi.mocked(verifyApiKey).mockRejectedValue(new ApiKeyAuthenticationError());
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_bad"))).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects when the key's creator has no membership in the organization at all (OrganizationAccessError, not an unhandled exception)", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(verifyApiKey).mockResolvedValue({
      organizationId: "org-1", userId: "user-1", apiKey: { id: "key-1", label: "n8n" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fakeServiceClient(null) as never);
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"))).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects when the key's creator is no longer an owner (role changed since the key was created)", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(verifyApiKey).mockResolvedValue({
      organizationId: "org-1", userId: "user-1", apiKey: { id: "key-1", label: "n8n" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      fakeServiceClient({ organization_id: "org-1", user_id: "user-1", role: "editor" }) as never,
    );
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"))).rejects.toThrow(V1AuthenticationError);
  });

  it("returns a fresh repository built from the verified owner's real membership", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(verifyApiKey).mockResolvedValue({
      organizationId: "org-1", userId: "user-1", apiKey: { id: "key-1", label: "n8n" },
    });
    const serviceClient = fakeServiceClient({ organization_id: "org-1", user_id: "user-1", role: "owner" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient as never);
    const fakeRepository = { listContentItems: vi.fn() };
    vi.mocked(createSupabaseRepository).mockReturnValue(fakeRepository as never);

    const result = await resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"));

    expect(result.organization).toEqual({
      organizationId: "org-1", userId: "user-1", role: "owner",
      apiKey: { id: "key-1", label: "n8n" },
    });
    expect(result.repository).toBe(fakeRepository);
    // Construido de cero, con el mismo cliente de service role usado para
    // verificar la clave — nunca el demoRepository singleton.
    expect(createSupabaseRepository).toHaveBeenCalledWith(serviceClient, result.organization);
  });
});
