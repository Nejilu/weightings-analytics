import { getPortfolioCounterfactual, PortfolioJournalError } from "@/data/services/portfolio-journal-service";
import { withSiteAccess } from "@/server/site-route";

const headers = { "Cache-Control": "no-store" };
export const GET = withSiteAccess(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const id = params.get("portfolioId"), entryId = Number(params.get("entryId"));
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(entryId) || entryId <= 0) return Response.json({ error: "Valid portfolio and journal entry IDs are required." }, { status: 400, headers });
  try { return Response.json({ data: await getPortfolioCounterfactual(id, entryId) }, { headers }); }
  catch (error) { return Response.json({ error: error instanceof PortfolioJournalError ? error.message : "Latest quotes are temporarily unavailable." }, { status: error instanceof PortfolioJournalError ? 409 : 503, headers }); }
}, "owner");
