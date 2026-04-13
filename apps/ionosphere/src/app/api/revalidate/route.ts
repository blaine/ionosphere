import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

const REVALIDATE_SECRET = process.env.REVALIDATE_SECRET;

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");

  if (REVALIDATE_SECRET && secret !== REVALIDATE_SECRET) {
    return NextResponse.json({ error: "invalid secret" }, { status: 401 });
  }

  // Revalidate all data-driven pages
  revalidatePath("/talks", "page");
  revalidatePath("/speakers", "page");
  revalidatePath("/concepts", "page");
  revalidatePath("/concordance", "page");
  revalidatePath("/discussion", "page");
  revalidatePath("/highlights", "page");
  // Dynamic routes
  revalidatePath("/talks/[rkey]", "page");
  revalidatePath("/speakers/[rkey]", "page");
  revalidatePath("/concepts/[rkey]", "page");

  return NextResponse.json({ revalidated: true, timestamp: Date.now() });
}
