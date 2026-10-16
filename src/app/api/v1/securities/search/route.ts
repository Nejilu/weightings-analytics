import { withSiteAccess } from "@/server/site-route";
import {
  getHoldingsSnapshot,
  HoldingsUnavailableError,
} from "@/data/services/holdings-service";
import { SUPPORTED_INDIVIDUAL_SECURITIES } from "@/data/supported-individual-securities";
import { economicSecurityIdentity, securityQuoteAlias } from "@/domain/security-equivalence";
import { securitySearchIssuerWeights } from "@/domain/security-search";

const MAX_RESULTS = 12;

function normalized(value: string): string {
  return value.trim().toLocaleUpperCase("en-US");
}

async function handleGET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = normalized(params.get("q") ?? "");
  const equityOnly = params.get("assetClass") === "equity";
  if (query.length < 2) {
    return Response.json({ data: [] });
  }

  try {
    const acwi = await getHoldingsSnapshot("ACWI");
    const searchUniverse = new Map(
      acwi.holdings.map((holding) => [holding.securityId, holding]),
    );
    for (const security of SUPPORTED_INDIVIDUAL_SECURITIES) {
      if (!searchUniverse.has(security.securityId)) {
        searchUniverse.set(security.securityId, { ...security, weight: 0 });
      }
    }

    const holdings = [...searchUniverse.values()];
    const issuerWeights = securitySearchIssuerWeights(holdings);
    const matches = holdings
      .map((holding) => ({
        holding,
        alias: securityQuoteAlias(holding),
        issuerWeight: issuerWeights.get(economicSecurityIdentity(holding).securityId) ?? holding.weight,
      }))
      .filter(({ holding, alias }) => {
        if (equityOnly && !holding.assetClass.toLowerCase().includes("equity")) return false;
        if (!holding.ticker || holding.ticker === "—") return false;
        const searchable = [
          holding.ticker,
          holding.name,
          alias?.displayTicker,
          alias?.providerSymbol,
          alias?.instrumentType,
        ]
          .filter((value): value is string => Boolean(value))
          .map(normalized);
        return searchable.some((value) => value.includes(query));
      })
      .sort((left, right) => {
        const score = (candidate: typeof left) => {
          const tickers = [
            candidate.alias?.displayTicker,
            candidate.alias?.providerSymbol,
            candidate.holding.ticker,
          ]
            .filter((value): value is string => Boolean(value))
            .map(normalized);
          return tickers.includes(query)
            ? 0
            : tickers.some((ticker) => ticker.startsWith(query))
              ? 1
              : 2;
        };
        return (
          score(left) - score(right) ||
          right.issuerWeight - left.issuerWeight ||
          right.holding.weight - left.holding.weight
        );
      })
      .slice(0, MAX_RESULTS)
      .map(({ holding, alias }) => ({
        securityId: holding.securityId,
        ticker: alias?.displayTicker ?? holding.ticker,
        name: holding.name,
        sector: holding.sector,
        country: holding.country,
        quoteSymbol: alias?.providerSymbol,
        instrumentType: alias?.instrumentType,
        underlyingTicker: alias?.underlyingTicker,
        underlyingSharesPerReceipt: alias?.underlyingSharesPerReceipt,
      }));

    return Response.json(
      {
        data: matches,
        meta: {
          universe: "ACWI + supported securities",
          asOf: acwi.asOf,
          sourceStatus: acwi.sourceStatus,
          supportedSecurities: SUPPORTED_INDIVIDUAL_SECURITIES.length,
        },
      },
      {
        headers: {
          "Cache-Control": acwi.sourceStatus === "stale"
            ? "no-store"
            : "private, max-age=60",
        },
      },
    );
  } catch (error) {
    if (error instanceof HoldingsUnavailableError) {
      return Response.json(
        {
          error:
            "The security universe is unavailable. Try again when the iShares source is reachable.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { error: "Security search failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = withSiteAccess(handleGET, "read");
