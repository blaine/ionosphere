import type { Metadata } from "next";
import { getTalk, getTalks } from "@/lib/api";
import TalkContent from "./TalkContent";

export async function generateStaticParams() {
  const { talks } = await getTalks();
  return talks.map((t: any) => ({ rkey: t.rkey }));
}

export async function generateMetadata({ params }: { params: Promise<{ rkey: string }> }): Promise<Metadata> {
  const { rkey } = await params;
  const { talk, speakers } = await getTalk(rkey);
  const speakerNames = speakers.map((s: any) => s.name).join(", ");
  const description = speakerNames
    ? `${talk.title} by ${speakerNames} — ATmosphereConf 2026`
    : `${talk.title} — ATmosphereConf 2026`;
  return {
    title: `${talk.title} — Ionosphere`,
    description,
    openGraph: {
      title: talk.title,
      description,
      url: `https://ionosphere.tv/talks/${rkey}`,
      type: "article",
    },
    twitter: {
      card: "summary",
      title: talk.title,
      description,
    },
  };
}

export default async function TalkPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const { talk, speakers, concepts } = await getTalk(rkey);

  return <TalkContent talk={talk} speakers={speakers} concepts={concepts} />;
}
