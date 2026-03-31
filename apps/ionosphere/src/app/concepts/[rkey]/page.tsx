import { getConcept, getConcepts } from "@/lib/api";

export async function generateStaticParams() {
  const { concepts } = await getConcepts();
  return concepts.map((c: any) => ({ rkey: c.rkey }));
}

export default async function ConceptPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const { concept, talks } = await getConcept(rkey);

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-3xl font-bold">{concept.name}</h1>
      {concept.description && <p className="text-neutral-300 mt-4">{concept.description}</p>}
      {concept.wikidata_id && (
        <a href={`https://www.wikidata.org/wiki/${concept.wikidata_id}`}
          className="text-blue-400 hover:underline text-sm mt-2 inline-block" target="_blank" rel="noopener">
          Wikidata
        </a>
      )}
      <h2 className="text-xl font-semibold mt-8 mb-4">
        Mentioned in {talks.length} talk{talks.length !== 1 ? "s" : ""}
      </h2>
      <div className="grid gap-3">
        {talks.map((t: any) => (
          <a key={t.rkey} href={`/talks/${t.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
            <div className="font-semibold">{t.title}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
