import { getPortfolioJournal } from "@/data/services/portfolio-journal-service";
import { publicationCatalog, requirePublicEtf } from "@/server/public-data";
import { AccessError } from "@/server/site-access";
import { withSiteAccess } from "@/server/site-route";

export const GET = withSiteAccess(async (_request: Request, context: { params: Promise<{ etfId: string }> }) => {
  const { etfId } = await context.params;
  const etf = requirePublicEtf(publicationCatalog(), etfId);
  if (etf.fundType !== "portfolio" || !etf.portfolioId) throw new AccessError(404, "Portfolio unavailable.");
  return Response.json({ data: getPortfolioJournal(etf.portfolioId, { initialize: false }) });
}, "portfolio-public-journal");
