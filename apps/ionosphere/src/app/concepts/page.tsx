import { getConceptClusters } from "@/lib/api";
import ConceptsListContent from "./ConceptsListContent";

export default async function ConceptsPage() {
  const { clusters } = await getConceptClusters();

  return <ConceptsListContent clusters={clusters} />;
}
