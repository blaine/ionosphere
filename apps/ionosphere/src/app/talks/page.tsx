import { getTalks } from "@/lib/api";

export default async function TalksPage() {
  const { talks } = await getTalks();

  const byDay = new Map<string, any[]>();
  for (const talk of talks) {
    const day = talk.starts_at?.slice(0, 10) || "unknown";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(talk);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">All Talks</h1>
      {[...byDay.entries()].map(([day, dayTalks]) => (
        <section key={day} className="mb-8">
          <h2 className="text-xl font-semibold text-neutral-300 mb-4">
            {new Date(day + "T00:00:00Z").toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric",
            })}
          </h2>
          <div className="grid gap-3">
            {dayTalks.map((talk: any) => (
              <a key={talk.rkey} href={`/talks/${talk.rkey}`}
                className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
                <h3 className="font-semibold">{talk.title}</h3>
                <div className="text-sm text-neutral-400 mt-1">
                  {talk.speaker_names} &middot; {talk.room} &middot; {talk.talk_type}
                </div>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
