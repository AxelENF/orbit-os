import { beforeEach, describe, expect, it, vi } from "vitest";

const callbackRepository = {
  ingestCopyResult: vi.fn(),
};
const serviceRoleClient = { client: "service-role" };
const createSupabaseServerClient = vi.fn();
const createSupabaseServiceRoleClient = vi.fn(() => serviceRoleClient);
const createSupabaseCallbackRepository = vi.fn(() => callbackRepository);

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
}));

vi.mock("@/lib/supabase/repository", () => ({
  createSupabaseCallbackRepository,
  createSupabaseRepository: vi.fn(),
}));

import { createN8nCallbackRepository } from "@/lib/content/repository-factory";

describe("n8n callback repository factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the service-role adapter without asking for a browser session", async () => {
    const repository = await createN8nCallbackRepository({
      environment: {
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      },
    });

    expect(repository).toBe(callbackRepository);
    expect(createSupabaseServiceRoleClient).toHaveBeenCalledOnce();
    expect(createSupabaseCallbackRepository).toHaveBeenCalledWith(serviceRoleClient);
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
