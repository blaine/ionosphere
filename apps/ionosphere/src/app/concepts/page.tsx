import { getConcepts } from "@/lib/api";
import ConceptsListContent from "./ConceptsListContent";

export default async function ConceptsPage() {
  const { concepts } = await getConcepts();

  return <ConceptsListContent concepts={concepts} />;
}
