import { getTalks } from "@/lib/api";
import TalksListContent from "./TalksListContent";

export default async function TalksPage() {
  const { talks } = await getTalks();

  return <TalksListContent talks={talks} />;
}
