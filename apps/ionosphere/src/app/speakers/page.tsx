import { getSpeakers } from "@/lib/api";

export default async function SpeakersPage() {
  const { speakers } = await getSpeakers();

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Speakers</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {speakers.map((s: any) => (
          <a key={s.rkey} href={`/speakers/${s.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
            <div className="font-semibold">{s.name}</div>
            {s.handle && <div className="text-sm text-neutral-400">@{s.handle}</div>}
          </a>
        ))}
      </div>
    </div>
  );
}
