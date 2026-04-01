import { getSpeakers } from "@/lib/api";
import SpeakersListContent from "./SpeakersListContent";

export default async function SpeakersPage() {
  const { speakers } = await getSpeakers();

  return <SpeakersListContent speakers={speakers} />;
}
