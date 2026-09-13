import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
import { MetaPublishError } from "@/lib/integrations/meta-publish-error";

const workerMocks = vi.hoisted(() => ({
  runnerInstances: [] as Array<{
    stop: ReturnType<typeof vi.fn>;
    runUntilStopped: ReturnType<typeof vi.fn>;
  }>,
  supabaseClient: { rpc: vi.fn() },
  createClient: vi.fn(),
  createCopyStore: vi.fn(),
  createPublishStore: vi.fn(),
  createMetaProcessor: vi.fn(),
  durableJobRunner: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: workerMocks.createClient,
}));

vi.mock("@/lib/automation/supabase-copy-worker-store", () => ({
  createSupabaseCopyWorkerStore: workerMocks.createCopyStore,
}));

vi.mock("@/lib/automation/supabase-publish-worker-store", () => ({
  createSupabasePublishWorkerStore: workerMocks.createPublishStore,
}));

vi.mock("@/worker/providers/meta-publish-processor", () => ({
  createMetaPublishProcessor: workerMocks.createMetaProcessor,
}));

vi.mock("@/worker/durable-runner", () => ({
  DurableJobRunner: workerMocks.durableJobRunner,
}));

import {
  isCopyJobRetryable,
  isPublishJobRetryable,
  main,
} from "@/worker/entrypoint";

function stubWorkerEnvironment(): void {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("SNAPGAD_COPY_WORKER_MODULE", "worker/providers/copy-processor.ts");
}

beforeEach(() => {
  workerMocks.supabaseClient.rpc.mockReset();
  workerMocks.createClient.mockReset().mockReturnValue(workerMocks.supabaseClient);
  workerMocks.createCopyStore.mockReset().mockReturnValue({ kind: "copy" });
  workerMocks.createPublishStore.mockReset().mockReturnValue({ kind: "publish" });
  workerMocks.createMetaProcessor.mockReset().mockReturnValue(vi.fn());
  workerMocks.durableJobRunner.mockReset().mockImplementation(function () {
    const runner = {
      stop: vi.fn(),
      runUntilStopped: vi.fn().mockResolvedValue(undefined),
    };
    workerMocks.runnerInstances.push(runner);
    return runner;
  });
  workerMocks.runnerInstances.length = 0;
  stubWorkerEnvironment();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("isCopyJobRetryable", () => {
  it("treats a non-guardrail error as retryable by default", () => {
    expect(isCopyJobRetryable(new Error("network blip"))).toBe(true);
  });

  it("respects the guardrail's own retryable flag", () => {
    expect(isCopyJobRetryable(new CopyGuardrailError("budget exceeded", false))).toBe(false);
    expect(isCopyJobRetryable(new CopyGuardrailError("bad shape", true))).toBe(true);
  });
});

describe("isPublishJobRetryable", () => {
  it("returns false for a MetaPublishError with retryable=false", () => {
    expect(isPublishJobRetryable(new MetaPublishError("token expired", false, true))).toBe(false);
  });

  it("returns true for a generic error", () => {
    expect(isPublishJobRetryable(new Error("network blip"))).toBe(true);
  });
});

describe("worker entrypoint dispatch", () => {
  it("with SNAPGAD_META_PUBLISH_WORKER_ENABLED other than true only runs COPY", async () => {
    vi.stubEnv("SNAPGAD_META_PUBLISH_WORKER_ENABLED", "false");

    await main();

    expect(workerMocks.createCopyStore).toHaveBeenCalledTimes(1);
    expect(workerMocks.createPublishStore).not.toHaveBeenCalled();
    expect(workerMocks.createMetaProcessor).not.toHaveBeenCalled();
    expect(workerMocks.runnerInstances).toHaveLength(1);
    expect(workerMocks.runnerInstances[0]?.runUntilStopped).toHaveBeenCalledTimes(1);
  });

  it("does not use the legacy SNAPGAD_PUBLISH_WORKER_ENABLED flag", async () => {
    vi.stubEnv("SNAPGAD_META_PUBLISH_WORKER_ENABLED", "false");
    vi.stubEnv("SNAPGAD_PUBLISH_WORKER_ENABLED", "true");

    await main();

    expect(workerMocks.createPublishStore).not.toHaveBeenCalled();
    expect(workerMocks.runnerInstances).toHaveLength(1);
  });

  it("with SNAPGAD_META_PUBLISH_WORKER_ENABLED=true builds and runs both runners", async () => {
    vi.stubEnv("SNAPGAD_META_PUBLISH_WORKER_ENABLED", "true");

    await main();

    expect(workerMocks.createCopyStore).toHaveBeenCalledTimes(1);
    expect(workerMocks.createPublishStore).toHaveBeenCalledTimes(1);
    expect(workerMocks.createMetaProcessor).toHaveBeenCalledTimes(1);
    expect(workerMocks.runnerInstances).toHaveLength(2);
    expect(workerMocks.runnerInstances[0]?.runUntilStopped).toHaveBeenCalledTimes(1);
    expect(workerMocks.runnerInstances[1]?.runUntilStopped).toHaveBeenCalledTimes(1);
  });
});
