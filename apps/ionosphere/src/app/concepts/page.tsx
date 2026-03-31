import { getConcepts } from "@/lib/api";

export default async function ConceptsPage() {
  const { concepts } = await getConcepts();

  if (concepts.length === 0) {
    return (
      <div>
        <h1 className="text-3xl font-bold mb-6">Concepts</h1>
        <p className="text-neutral-400">Concepts will appear here after transcript enrichment.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Concepts</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {concepts.map((c: any) => (
          <a key={c.rkey} href={`/concepts/${c.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
            <div className="font-semibold">{c.name}</div>
            {c.description && <div className="text-sm text-neutral-400 mt-1 line-clamp-2">{c.description}</div>}
          </a>
        ))}
      </div>
    </div>
  );
}
