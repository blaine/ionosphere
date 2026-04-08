import { getTracks } from "@/lib/api";
import Link from "next/link";

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const DAY_ORDER = ["Friday", "Saturday", "Sunday"];

export const dynamic = "force-dynamic";

export default async function TracksPage() {
  let tracks: any[] = [];
  try {
    const data = await getTracks();
    tracks = data.tracks;
  } catch {
    // tracks API not available yet
  }

  const byDay = new Map<string, any[]>();
  for (const track of tracks) {
    const day = track.dayLabel;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(track);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Full-Day Streams</h1>
      <p className="text-neutral-400 text-sm mb-8">
        Browse complete conference recordings by room and day. Each track shows
        the full stream with talk segments, speaker diarization, and transcript.
      </p>

      {DAY_ORDER.filter((d) => byDay.has(d)).map((day) => (
        <div key={day} className="mb-8">
          <h2 className="text-lg font-semibold text-neutral-300 mb-3 border-b border-neutral-800 pb-1">
            {day}
          </h2>
          <div className="space-y-2">
            {byDay.get(day)!.map((track) => (
              <Link
                key={track.slug}
                href={`/tracks/${track.slug}`}
                className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{track.room}</span>
                  <span className="text-sm text-neutral-500">
                    {formatDuration(track.durationSeconds)}
                  </span>
                </div>
                <div className="text-sm text-neutral-400 mt-1">
                  {track.talkCount} talks
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
