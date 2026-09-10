import { InMemoryJobStore, type JobStoreStats } from "@/worker/job-runner";

export type WorkerHealthSnapshot = JobStoreStats;

/**
 * Computes a deterministic snapshot from the local store. It has no network
 * side effects and reports only work known by this process.
 */
export function snapshotWorkerHealth<Payload = unknown, Result = unknown>(
  store: InMemoryJobStore<Payload, Result>,
): WorkerHealthSnapshot {
  return { ...store.stats() };
}

export class WorkerHealth<Payload = unknown, Result = unknown> {
  public constructor(private readonly store: InMemoryJobStore<Payload, Result>) {}

  public snapshot(): WorkerHealthSnapshot {
    return snapshotWorkerHealth(this.store);
  }
}
