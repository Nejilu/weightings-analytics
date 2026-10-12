import { withSiteAccess } from "@/server/site-route";
import { getCapitalizationReference, CapitalizationReferenceRequestError } from "@/data/services/capitalization-reference-service";

async function handleGET(request: Request, context: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await context.params;
  const universe = new URL(request.url).searchParams.get("universe") ?? "holdings";
  if (universe !== "holdings" && universe !== "market") return Response.json({ error: "Unknown reference universe." }, { status: 400 });
  try {
    return Response.json({ data: await getCapitalizationReference(ticker, universe) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const invalid = error instanceof CapitalizationReferenceRequestError;
    return Response.json({ error: invalid ? error.message : "Total market capitalizations are temporarily unavailable." }, { status: invalid ? 404 : 503 });
  }
}

export const GET = withSiteAccess(handleGET, "holdings");
