import { getIndex } from "@/lib/api";
import IndexContent from "./IndexContent";

export default async function IndexPage() {
  const { entries } = await getIndex();
  return <IndexContent entries={entries} />;
}
