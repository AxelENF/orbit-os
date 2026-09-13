import type { DurableJob } from "@/lib/automation/durable-job-contract";
import {
  publishToFacebook,
  publishToInstagram,
  type MetaPublishResult,
} from "@/lib/integrations/meta-graph-client";
import type { SupabasePublishJobPayload } from "@/lib/automation/supabase-publish-worker-store";
import { MetaPublishError } from "@/lib/integrations/meta-publish-error";

export type MetaPublishProcessorDependencies = {
  fetchFn?: typeof fetch;
  markConnectionError: (organizationId: string) => Promise<void>;
};

export function buildCaption(copy: SupabasePublishJobPayload["copy"]): string {
  return [copy.headline, copy.body, copy.cta, copy.hashtags.join(" ")].join("\n\n");
}

export function createMetaPublishProcessor(
  dependencies: MetaPublishProcessorDependencies,
) {
  return async function processPublishJob(
    job: DurableJob<SupabasePublishJobPayload, MetaPublishResult>,
  ): Promise<MetaPublishResult> {
    try {
      const publishFn = job.payload.platform === "INSTAGRAM" ? publishToInstagram : publishToFacebook;
      return await publishFn(
        {
          pageId: job.payload.meta.facebookPageId,
          igUserId: job.payload.meta.instagramBusinessAccountId ?? "",
          pageAccessToken: job.payload.meta.pageAccessToken,
          caption: buildCaption(job.payload.copy),
          assets: job.payload.assets.map(({ assetUrl, position }) => ({
            signedUrl: assetUrl,
            position,
          })),
        },
        dependencies.fetchFn,
      );
    } catch (error) {
      if (error instanceof MetaPublishError && error.requiresReconnect) {
        await dependencies.markConnectionError(job.organizationId);
      }
      throw error;
    }
  };
}
