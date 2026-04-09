import { getTrack, getTracks } from "@/lib/api";
import type { Metadata } from "next";
import TrackViewContent from "./TrackViewContent";

export async function generateStaticParams() {
  try {
    const { tracks } = await getTracks();
    return tracks.map((t: any) => ({ stream: t.slug }));
  } catch {
    return []; // tracks endpoint not available — render on-demand
  }
}

export async function generateMetadata({ params }: { params: Promise<{ stream: string }> }): Promise<Metadata> {
  const { stream } = await params;
  const data = await getTrack(stream);
  return {
    title: `${data.name} — Ionosphere`,
    description: `${data.talks.length} talks from ${data.room}, ATmosphereConf 2026`,
  };
}

export default async function TrackPage({ params }: { params: Promise<{ stream: string }> }) {
  const { stream } = await params;

  // Only pass lightweight metadata as props — the heavy data (words, diarization,
  // transcript) is fetched client-side to avoid serializing 10MB+ into the HTML.
  const data = await getTrack(stream);
  const meta = {
    slug: data.slug,
    name: data.name,
    room: data.room,
    dayLabel: data.dayLabel,
    streamUri: data.streamUri,
    durationSeconds: data.durationSeconds,
    playbackUrl: data.playbackUrl,
    talks: data.talks,
  };

  return <TrackViewContent trackMeta={meta} stream={stream} />;
}
