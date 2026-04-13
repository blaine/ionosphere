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
    <div className="max-w-5xl mx-auto px-4 py-6">
      {DAY_ORDER.filter((d) => byDay.has(d)).map((day) => (
        <div key={day} className="mb-6">
          <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-3">
            {day}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {byDay.get(day)!.map((track) => (
              <Link
                key={track.slug}
                href={`/tracks/${track.slug}`}
                className="block p-3 rounded-lg bg-neutral-900/50 hover:bg-neutral-800/70 transition-colors"
              >
                <div className="font-medium text-sm">{track.room}</div>
                <div className="text-xs text-neutral-500 mt-1">
                  {track.talkCount} talks · {formatDuration(track.durationSeconds)}
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
