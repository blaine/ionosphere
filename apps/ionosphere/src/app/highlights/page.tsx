import HighlightsContent from "./HighlightsContent";
import { getHighlights } from "@/lib/api";

export default async function HighlightsPage() {
  const data = await getHighlights().catch(() => ({ highlights: [] }));
  return <HighlightsContent highlights={data.highlights} />;
}
