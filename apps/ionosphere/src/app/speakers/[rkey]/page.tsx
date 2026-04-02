import { getSpeaker, getSpeakers, getTalks } from "@/lib/api";
import TalksListContent from "@/app/talks/TalksListContent";

export async function generateStaticParams() {
  const { speakers } = await getSpeakers();
  return speakers.map((s: any) => ({ rkey: s.rkey }));
}

export default async function SpeakerPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const [{ speaker, talks: speakerTalks }, { talks: allTalks }] = await Promise.all([
    getSpeaker(rkey),
    getTalks(),
  ]);

  const speakerRkeys = new Set(speakerTalks.map((t: any) => t.rkey));
  const talks = allTalks.filter((t: any) => speakerRkeys.has(t.rkey));

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3 border-b border-neutral-800">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold">{speaker.name}</h1>
          {speaker.handle && <span className="text-sm text-neutral-500">@{speaker.handle}</span>}
        </div>
        {speaker.bio && <p className="text-sm text-neutral-400 mt-1">{speaker.bio}</p>}
        <span className="text-sm text-neutral-500">{talks.length} talk{talks.length !== 1 ? "s" : ""}</span>
      </div>
      <div className="flex-1 min-h-0">
        <TalksListContent talks={talks} />
      </div>
    </div>
  );
}
