import { getSpeakers, getTalks } from "@/lib/api";
import SpeakersListContent from "./SpeakersListContent";

export default async function SpeakersPage() {
  const { speakers } = await getSpeakers();
  const { talks } = await getTalks();

  return <SpeakersListContent speakers={speakers} talks={talks} />;
}
