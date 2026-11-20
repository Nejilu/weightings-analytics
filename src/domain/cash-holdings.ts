import type { Holding } from "./etf";

export function isCashHolding(holding: Pick<Holding, "assetClass" | "name">): boolean {
  const assetClass = holding.assetClass.toLocaleLowerCase("en-US");
  const name = holding.name.toLocaleLowerCase("en-US");
  return (
    assetClass.includes("cash") ||
    assetClass.includes("money market") ||
    assetClass === "currency" ||
    /(^|\s)cash($|\s|\(|\/)/u.test(name)
  );
}
