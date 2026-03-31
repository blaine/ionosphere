import { getTalk, getTalks } from "@/lib/api";
import TalkContent from "./TalkContent";

export async function generateStaticParams() {
  const { talks } = await getTalks();
  return talks.map((t: any) => ({ rkey: t.rkey }));
}

export default async function TalkPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const { talk, speakers, concepts } = await getTalk(rkey);

  return <TalkContent talk={talk} speakers={speakers} concepts={concepts} />;
}
