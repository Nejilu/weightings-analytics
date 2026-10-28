import { getPortfolioCounterfactual, getPortfolioJournal } from "@/data/services/portfolio-journal-service";
import { publicationCatalog, requirePublicEtf } from "@/server/public-data";
import { requirePublishedJournalState } from "@/server/public-portfolio-journal";
import { AccessError } from "@/server/site-access";
import { withSiteAccess } from "@/server/site-route";

export const GET = withSiteAccess(async (request: Request, context: { params: Promise<{ etfId: string }> }) => {
  const { etfId } = await context.params;
  const entryId = Number(new URL(request.url).searchParams.get("entryId"));
  if (!Number.isSafeInteger(entryId) || entryId <= 0) throw new AccessError(400, "A valid journal entry is required.");
  const catalog = publicationCatalog();
  const etf = requirePublicEtf(catalog, etfId);
  if (etf.fundType !== "portfolio" || !etf.portfolioId) throw new AccessError(404, "Portfolio unavailable.");
  const journal = getPortfolioJournal(etf.portfolioId, { initialize: false });
  requirePublishedJournalState(journal, entryId, catalog);
  const result = await getPortfolioCounterfactual(etf.portfolioId, entryId, undefined, { initialize: false });
  return Response.json({ data: { journal, result } });
}, "portfolio-public-counterfactual");
