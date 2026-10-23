import { deletePortfolioJournalState, getPortfolioJournal, PortfolioJournalDeletionError, PortfolioJournalError } from "@/data/services/portfolio-journal-service";
import { withSiteAccess } from "@/server/site-route";

const headers = { "Cache-Control": "no-store" };
export const GET = withSiteAccess((request: Request) => {
  const id = new URL(request.url).searchParams.get("portfolioId");
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return Response.json({ error: "A valid portfolio ID is required." }, { status: 400, headers });
  try { return Response.json({ data: getPortfolioJournal(id) }, { headers }); }
  catch (error) { return Response.json({ error: error instanceof PortfolioJournalError ? error.message : "The portfolio journal is temporarily unavailable." }, { status: error instanceof PortfolioJournalError ? 404 : 503, headers }); }
}, "owner");

export const DELETE = withSiteAccess((request: Request) => {
  const params = new URL(request.url).searchParams;
  const id = params.get("portfolioId"), entryId = Number(params.get("entryId"));
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(entryId) || entryId <= 0) return Response.json({ error: "Valid portfolio and journal entry IDs are required." }, { status: 400, headers });
  try { return Response.json({ data: deletePortfolioJournalState(id, entryId) }, { headers }); }
  catch (error) { return Response.json({ error: error instanceof PortfolioJournalDeletionError ? error.message : "The journal entry could not be deleted. Reload the journal before retrying." }, { status: error instanceof PortfolioJournalDeletionError ? error.status : 503, headers }); }
}, "owner");
