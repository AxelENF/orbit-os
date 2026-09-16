/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import { verifyApiKey, ApiKeyAuthenticationError } from "@/lib/api/keys";

function serviceClient(overrides: Partial<{ keyRow: unknown; keyError: unknown }> = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: overrides.keyRow ?? null,
    error: overrides.keyError ?? null,
  });
  const is = vi.fn().mockReturnValue({ maybeSingle });
  const eq = vi.fn().mockReturnValue({ is });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

describe("verifyApiKey", () => {
  it("resolves organizationId/userId/apiKey from a valid, active key", async () => {
    const client = serviceClient({
      keyRow: { id: "key-1", organization_id: "org-1", label: "n8n", created_by: "user-1" },
    });
    const result = await verifyApiKey("sk_live_abc", client as never);
    expect(result).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      apiKey: { id: "key-1", label: "n8n" },
    });
  });

  it("hashes the secret before querying — never queries with the raw secret", async () => {
    const client = serviceClient({
      keyRow: { id: "key-1", organization_id: "org-1", label: "n8n", created_by: "user-1" },
    });
    await verifyApiKey("sk_live_abc", client as never);
    const selectCall = vi.mocked(client.from).mock.results[0]!.value.select;
    const eqCall = vi.mocked(selectCall).mock.results[0]!.value.eq;
    expect(eqCall).toHaveBeenCalledWith("key_hash", expect.not.stringContaining("sk_live_abc"));
  });

  it("rejects when no key row matches (unknown or revoked secret)", async () => {
    const client = serviceClient({ keyRow: null });
    await expect(verifyApiKey("sk_live_unknown", client as never)).rejects.toThrow(ApiKeyAuthenticationError);
  });

  it("rejects on a real lookup failure (not a leak — same error type as an unknown key)", async () => {
    const client = serviceClient({ keyError: new Error("connection reset") });
    await expect(verifyApiKey("sk_live_abc", client as never)).rejects.toThrow(ApiKeyAuthenticationError);
  });
});
