import { DraftEditor } from "@/components/content/draft-editor";

type DraftDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DraftDetailPage({ params }: DraftDetailPageProps) {
  const { id } = await params;
  return <DraftEditor draftId={id} />;
}
