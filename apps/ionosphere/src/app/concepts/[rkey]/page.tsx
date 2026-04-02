import type { Metadata } from "next";
import { getConcept, getConcepts, getTalks } from "@/lib/api";
import TalksListContent from "@/app/talks/TalksListContent";

export async function generateStaticParams() {
  const { concepts } = await getConcepts();
  return concepts.map((c: any) => ({ rkey: c.rkey }));
}

export async function generateMetadata({ params }: { params: Promise<{ rkey: string }> }): Promise<Metadata> {
  const { rkey } = await params;
  const { concept, talks } = await getConcept(rkey);
  const description = concept.description || `${concept.name} — mentioned in ${talks.length} talk${talks.length !== 1 ? "s" : ""} at ATmosphereConf 2026`;
  return {
    title: `${concept.name} — Ionosphere`,
    description,
    openGraph: { title: concept.name, description, url: `https://ionosphere.tv/concepts/${rkey}` },
    twitter: { card: "summary", title: concept.name, description },
  };
}

export default async function ConceptPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const [{ concept, talks: conceptTalks }, { talks: allTalks }] = await Promise.all([
    getConcept(rkey),
    getTalks(),
  ]);

  // Filter the full talks list (which has speaker_names, reaction_summary, etc.)
  // to just the talks associated with this concept
  const conceptRkeys = new Set(conceptTalks.map((t: any) => t.rkey));
  const talks = allTalks.filter((t: any) => conceptRkeys.has(t.rkey));

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3 border-b border-neutral-800">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold">{concept.name}</h1>
          <span className="text-sm text-neutral-500">{talks.length} talk{talks.length !== 1 ? "s" : ""}</span>
        </div>
        {concept.description && <p className="text-sm text-neutral-400 mt-1">{concept.description}</p>}
        {concept.wikidata_id && (
          <a href={`https://www.wikidata.org/wiki/${concept.wikidata_id}`}
            className="text-blue-400 hover:underline text-xs mt-1 inline-block" target="_blank" rel="noopener">
            Wikidata
          </a>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <TalksListContent talks={talks} />
      </div>
    </div>
  );
}
