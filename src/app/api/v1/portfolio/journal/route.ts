import { getPortfolioJournal, PortfolioJournalError } from "@/data/services/portfolio-journal-service";
import { withSiteAccess } from "@/server/site-route";

const headers = { "Cache-Control": "no-store" };
export const GET = withSiteAccess((request: Request) => {
  const id = new URL(request.url).searchParams.get("portfolioId");
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return Response.json({ error: "A valid portfolio ID is required." }, { status: 400, headers });
  try { return Response.json({ data: getPortfolioJournal(id) }, { headers }); }
  catch (error) { return Response.json({ error: error instanceof PortfolioJournalError ? error.message : "The portfolio journal is temporarily unavailable." }, { status: error instanceof PortfolioJournalError ? 404 : 503, headers }); }
}, "owner");
