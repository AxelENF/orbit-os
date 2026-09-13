import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

import type { DurableJob } from "@/lib/automation/durable-job-contract";
import type { SupabaseCopyJobPayload } from "@/lib/automation/supabase-copy-worker-store";
import { createSupabaseCopyWorkerStore } from "@/lib/automation/supabase-copy-worker-store";
import {
  createSupabasePublishWorkerStore,
  type SupabasePublishJobPayload,
} from "@/lib/automation/supabase-publish-worker-store";
import { DurableJobRunner, type DurableJobProcessor } from "@/worker/durable-runner";
import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
import { createMetaPublishProcessor } from "@/worker/providers/meta-publish-processor";
import type { MetaPublishResult } from "@/lib/integrations/meta-graph-client";
import { MetaPublishError } from "@/lib/integrations/meta-publish-error";

type CopyResult = Record<string, unknown>;
type StoppableRunner = { stop(): void; runUntilStopped(): Promise<void> };

type ProcessorModule = {
  default?: unknown;
  processCopyJob?: unknown;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_DURATION_MS = 600_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 300_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to start the worker.`);
  return value;
}
export function parseWorkerDuration(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer in milliseconds.`);
  }
  return value;
}

/**
 * Without this, DurableJobRunner's default treats every error as retryable
 * (see worker/durable-runner.ts), so a budget or claims guardrail would
 * reach DEAD_LETTER through retries instead of failing straight to FAILED.
 */
export function isCopyJobRetryable(error: unknown): boolean {
  return !(error instanceof CopyGuardrailError) || error.retryable;
}

export function isPublishJobRetryable(error: unknown): boolean {
  return !(error instanceof MetaPublishError) || error.retryable;
}

function moduleSpecifier(value: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("node:")) return value;
  return pathToFileURL(resolve(process.cwd(), value)).href;
}

export async function loadCopyProcessor(
  specifier: string,
): Promise<DurableJobProcessor<SupabaseCopyJobPayload, CopyResult>> {
  const loaded = (await import(moduleSpecifier(specifier))) as ProcessorModule;
  const candidate = loaded.default ?? loaded.processCopyJob;
  if (typeof candidate !== "function") {
    throw new Error("SNAPGAD_COPY_WORKER_MODULE must export a default function or processCopyJob.");
  }
  return async (job) => {
    const result = await (candidate as (value: typeof job) => unknown)(job);
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("The copy processor must return an object result.");
    }
    return result as CopyResult;
  };
}

export async function main(): Promise<void> {
  const supabaseUrl = requiredEnvironment("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const processorSpecifier = requiredEnvironment("SNAPGAD_COPY_WORKER_MODULE");
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const store = createSupabaseCopyWorkerStore(client, {
    provider: process.env.SNAPGAD_COPY_WORKER_PROVIDER?.trim() || "local",
  });
  const processor = await loadCopyProcessor(processorSpecifier);
  const runner = new DurableJobRunner(store, processor, {
    pollIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    leaseDurationMs: parseWorkerDuration("SNAPGAD_WORKER_LEASE_DURATION_MS", DEFAULT_LEASE_DURATION_MS),
    heartbeatIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_HEARTBEAT_INTERVAL_MS", DEFAULT_HEARTBEAT_INTERVAL_MS),
    recoveryIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_RECOVERY_INTERVAL_MS", DEFAULT_RECOVERY_INTERVAL_MS),
    isRetryable: isCopyJobRetryable,
    logger: {
      error(message, metadata) {
        console.error(JSON.stringify({ message, ...metadata }));
      },
    },
  });
  const publishWorkerEnabled = process.env.SNAPGAD_META_PUBLISH_WORKER_ENABLED === "true";
  const runners: StoppableRunner[] = [runner];
  if (publishWorkerEnabled) {
    const publishStore = createSupabasePublishWorkerStore(client, { provider: "meta" });
    const publishProcessor = createMetaPublishProcessor({
      markConnectionError: async (organizationId) => {
        const { error } = await client.rpc("mark_meta_connection_error", {
          p_organization_id: organizationId,
        });
        if (error) throw new Error("Unable to mark the Meta connection as errored.");
      },
    });
    const publishJobProcessor: DurableJobProcessor<
      SupabasePublishJobPayload,
      Record<string, unknown>
    > = async (job) => {
      const metaJob: DurableJob<SupabasePublishJobPayload, MetaPublishResult> = {
        ...job,
        result: job.result as MetaPublishResult | undefined,
      };
      return publishProcessor(metaJob);
    };
    const publishRunner = new DurableJobRunner(publishStore, publishJobProcessor, {
      pollIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
      leaseDurationMs: parseWorkerDuration("SNAPGAD_WORKER_LEASE_DURATION_MS", DEFAULT_LEASE_DURATION_MS),
      heartbeatIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_HEARTBEAT_INTERVAL_MS", DEFAULT_HEARTBEAT_INTERVAL_MS),
      recoveryIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_RECOVERY_INTERVAL_MS", DEFAULT_RECOVERY_INTERVAL_MS),
      isRetryable: isPublishJobRetryable,
      logger: {
        error(message, metadata) {
          console.error(JSON.stringify({ message, ...metadata }));
        },
      },
    });
    runners.push(publishRunner);
  }
  const shutdown = () => runners.forEach((activeRunner) => activeRunner.stop());
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await Promise.all(runners.map((activeRunner) => activeRunner.runUntilStopped()));
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}

function safeStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 500) || "Worker startup failed.";
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(`SnapGad worker stopped: ${safeStartupError(error)}`);
    process.exitCode = 1;
  });
}
