import { getSpeaker, getSpeakers } from "@/lib/api";

export async function generateStaticParams() {
  const { speakers } = await getSpeakers();
  return speakers.map((s: any) => ({ rkey: s.rkey }));
}

export default async function SpeakerPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const { speaker, talks } = await getSpeaker(rkey);

  return (
    <div>
      <h1 className="text-3xl font-bold">{speaker.name}</h1>
      {speaker.handle && <div className="text-neutral-400 mt-1">@{speaker.handle}</div>}
      {speaker.bio && <p className="text-neutral-300 mt-4">{speaker.bio}</p>}
      <h2 className="text-xl font-semibold mt-8 mb-4">Talks</h2>
      <div className="grid gap-3">
        {talks.map((t: any) => (
          <a key={t.rkey} href={`/talks/${t.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
            <div className="font-semibold">{t.title}</div>
            <div className="text-sm text-neutral-400 mt-1">{t.room} &middot; {t.talk_type}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
