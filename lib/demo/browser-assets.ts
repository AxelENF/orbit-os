import type { ContentItem } from "@/lib/content/repository";

const STORAGE_KEY = "snapgad-content-os:demo-assets";

export type DemoBrowserAsset = {
  contentItemId: string;
  filename: string;
  mimeType: string;
  previewDataUrl: string;
  content: ContentItem;
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function readDemoAssets(): DemoBrowserAsset[] {
  if (!isBrowser()) return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as DemoBrowserAsset[]) : [];
  } catch {
    return [];
  }
}

export async function persistDemoAsset(content: ContentItem, file: File): Promise<void> {
  if (!isBrowser()) return;

  const previewDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Unable to read asset preview"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read asset preview")));
    reader.readAsDataURL(file);
  });

  const next: DemoBrowserAsset[] = [
    { contentItemId: content.id, filename: file.name, mimeType: file.type, previewDataUrl, content },
    ...readDemoAssets().filter((asset) => asset.contentItemId !== content.id),
  ];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function clearDemoAssets(): void {
  if (isBrowser()) window.localStorage.removeItem(STORAGE_KEY);
}
