import { getPortfolioById } from "@/data/services/portfolio-service";
import { publicationCatalog, requirePublicEtf } from "@/server/public-data";
import { AccessError } from "@/server/site-access";
import { withSiteAccess } from "@/server/site-route";
import type { PublishedPortfolio } from "@/domain/published-portfolio";

export const GET = withSiteAccess(
  async (
    _request: Request,
    context: { params: Promise<{ etfId: string }> },
  ) => {
    const { etfId } = await context.params;
    const etf = requirePublicEtf(publicationCatalog(), etfId);
    if (
      etf.visibility !== "public" ||
      etf.fundType !== "portfolio" ||
      !etf.portfolioId
    ) {
      throw new AccessError(404, "Portfolio details unavailable.");
    }
    const portfolio = await getPortfolioById(etf.portfolioId);
    const data: PublishedPortfolio = {
      ticker: etf.ticker,
      name: etf.name,
      updatedAt: portfolio.updatedAt,
      totalMarketValueUsd: portfolio.analysis?.totalMarketValueUsd ?? null,
      items: portfolio.items.map((item) => ({
        ticker: item.ticker,
        name: item.name,
        quantity: item.quantity ?? null,
        currentValueUsd: item.currentValueUsd ?? null,
        allocationWeight: item.allocationWeight,
      })),
      cash: portfolio.cashPositions.map((cash) => ({
        currency: cash.currency,
        amount: cash.amount,
        valueUsd: cash.valueUsd ?? null,
        weight: cash.weight ?? null,
      })),
    };
    return Response.json({ data });
  },
  "published-portfolio",
);
