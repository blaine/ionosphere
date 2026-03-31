import { getTalks } from "@/lib/api";

export default async function Home() {
  const { talks } = await getTalks();

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-4xl font-bold mb-2">ATmosphereConf 2026</h1>
      <p className="text-neutral-400 mb-8">
        Semantically enriched conference archive. {talks.length} talks.
      </p>
      <div className="grid gap-4">
        {talks.slice(0, 20).map((talk: any) => (
          <a key={talk.rkey} href={`/talks/${talk.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
            <h2 className="font-semibold">{talk.title}</h2>
            <div className="text-sm text-neutral-400 mt-1">
              {talk.speaker_names} &middot; {talk.room} &middot; {talk.talk_type}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
