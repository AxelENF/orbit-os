import {
  PUBLICATION_PLATFORMS,
  type ContentItem,
  type ContentRepository,
  type PublicationTarget,
} from "@/lib/content/repository";
import { parseContentBrief } from "@/lib/content/validation";

function createId(): string {
  return crypto.randomUUID();
}

class DemoContentRepository implements ContentRepository {
  private readonly targetsByContentItem = new Map<string, PublicationTarget[]>();

  async createContentItem(input: unknown): Promise<ContentItem> {
    const brief = parseContentBrief(input);
    const item: ContentItem = {
      ...brief,
      id: createId(),
      state: "DRAFT",
      createdAt: new Date().toISOString(),
    };

    this.targetsByContentItem.set(
      item.id,
      PUBLICATION_PLATFORMS.map((platform) => ({
        id: createId(),
        contentItemId: item.id,
        platform,
        status: "PENDING_REVIEW",
      })),
    );

    return item;
  }

  async listPublicationTargets(
    contentItemId: string,
  ): Promise<PublicationTarget[]> {
    return [...(this.targetsByContentItem.get(contentItemId) ?? [])];
  }
}

/** Creates isolated in-memory demo storage and never makes network calls. */
export function createDemoRepository(): ContentRepository {
  return new DemoContentRepository();
}
