import { getTalk, getTalks } from "@/lib/api";
import VideoPlayer from "@/app/components/VideoPlayer";

export async function generateStaticParams() {
  const { talks } = await getTalks();
  return talks.map((t: any) => ({ rkey: t.rkey }));
}

export default async function TalkPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const { talk, speakers, concepts } = await getTalk(rkey);
  const durationMin = talk.duration ? (talk.duration / 1e9 / 60).toFixed(0) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2">
        {talk.video_uri && <VideoPlayer videoUri={talk.video_uri} />}
        <h1 className="text-2xl font-bold mt-4">{talk.title}</h1>
        <div className="text-neutral-400 mt-1">
          {speakers.map((s: any) => s.name).join(", ")}
          {durationMin && <> &middot; {durationMin} min</>}
          {talk.room && <> &middot; {talk.room}</>}
        </div>
        {talk.description && (
          <p className="text-neutral-300 mt-4 leading-relaxed">{talk.description}</p>
        )}
        <div className="mt-8 p-6 rounded-lg border border-neutral-800 text-neutral-500 text-sm">
          Transcript not yet available.
        </div>
      </div>
      <aside className="space-y-6">
        <section>
          <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wide mb-2">Speakers</h2>
          {speakers.map((s: any) => (
            <a key={s.rkey} href={`/speakers/${s.rkey}`} className="block text-neutral-200 hover:text-white">
              {s.name}
              {s.handle && <span className="text-neutral-500 ml-1">@{s.handle}</span>}
            </a>
          ))}
        </section>
        {talk.category && (
          <section>
            <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wide mb-2">Category</h2>
            <span className="text-neutral-300">{talk.category}</span>
          </section>
        )}
        {talk.talk_type && (
          <section>
            <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wide mb-2">Type</h2>
            <span className="text-neutral-300">{talk.talk_type}</span>
          </section>
        )}
      </aside>
    </div>
  );
}
