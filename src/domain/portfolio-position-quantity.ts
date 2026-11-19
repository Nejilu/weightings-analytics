import type { PortfolioItem, PortfolioLookThroughPosition } from "./portfolio";
import { economicSecurityIdentity } from "./security-equivalence";

// Resolve owned quantities before requesting another quote: a later quote must
// never change the share count of an unchanged direct position.
export function portfolioPositionQuantity(
  position: PortfolioLookThroughPosition,
  items: PortfolioItem[],
  exposureValueUsd: number,
): number | undefined {
  const directItems = items.filter((item) => item.kind === "security" && (
    item.referenceId === position.securityId || economicSecurityIdentity({
      securityId: item.referenceId, ticker: item.ticker, name: item.name,
    }).securityId === position.securityId
  ));
  const quoteItems = directItems.filter((item) =>
    item.referenceId === (position.quoteSecurityId ?? position.securityId) &&
    item.ticker === (position.quoteTicker ?? position.ticker));

  if (quoteItems.length > 0 && quoteItems.length === directItems.length &&
    position.contributions.every((source) => source.kind === "security") &&
    quoteItems.every((item) => Number.isFinite(item.quantity))) {
    return quoteItems.reduce((sum, item) => sum + item.quantity!, 0);
  }

  // A mixed exposure is expressed in the selected listing's units, using the
  // same price snapshot as its owned position, rather than a second price feed.
  const price = quoteItems.find((item) =>
    Number.isFinite(item.currentPriceUsd) && item.currentPriceUsd! > 0)?.currentPriceUsd;
  return price !== undefined ? exposureValueUsd / price : undefined;
}
