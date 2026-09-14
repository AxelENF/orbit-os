"use client";

import { useCallback, useEffect, useState } from "react";

import { approveContentTarget, getContentRecord, retryContentTarget } from "@/lib/content/client";
import type { ContentRecord, PublicationTarget } from "@/lib/content/repository";

export function useAttentionTargets(contentItemIds: string[], onTargetResolved?: () => void) {
  const [records, setRecords] = useState<ContentRecord[]>([]);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const idsKey = contentItemIds.join(",");

  // isLoading is derived, not synced via a separate setState call in the
  // effect below: it's true whenever the ids we last finished loading for
  // don't match the current ids. This satisfies react-hooks/set-state-in-effect
  // (no setState synchronously at the top of the effect) and avoids
  // react-hooks/refs (no ref read/write during render either) — both of
  // which a naive "setIsLoading(true) at the top of the effect" or a
  // ref-tracked "previous key" comparison during render would trigger.
  const [loadedForKey, setLoadedForKey] = useState<string | null>(null);
  const isLoading = loadedForKey !== idsKey;

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled(contentItemIds.map((id) => getContentRecord(id))).then((results) => {
      if (cancelled) return;
      const nextRecords: ContentRecord[] = [];
      const nextFailedIds: string[] = [];
      results.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") nextRecords.push(outcome.value);
        else nextFailedIds.push(contentItemIds[index]);
      });
      setRecords(nextRecords);
      setFailedIds(nextFailedIds);
      setLoadedForKey(idsKey);
    });

    return () => {
      cancelled = true;
    };
    // contentItemIds is derived from a filtered list each render; compare by
    // its joined value so a same-membership array doesn't re-trigger the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const refreshOne = useCallback(async (contentItemId: string) => {
    const refreshed = await getContentRecord(contentItemId);
    setRecords((current) => current.map((record) => (record.content.id === contentItemId ? refreshed : record)));
  }, []);

  const handleApprove = useCallback(
    async (contentItemId: string, target: PublicationTarget) => {
      const approved = await approveContentTarget(contentItemId, target);
      if (approved.status !== "APPROVED") throw new Error("PUBLICATION_TARGET_NOT_APPROVED");
      await refreshOne(contentItemId);
      onTargetResolved?.();
      return { ...approved, status: "APPROVED" as const };
    },
    [refreshOne, onTargetResolved],
  );

  const handleRetry = useCallback(
    async (contentItemId: string, targetId: string) => {
      const retried = await retryContentTarget(contentItemId, targetId);
      await refreshOne(contentItemId);
      onTargetResolved?.();
      return { ...retried, status: "APPROVED" as const };
    },
    [refreshOne, onTargetResolved],
  );

  return { records, failedIds, isLoading, handleApprove, handleRetry };
}
