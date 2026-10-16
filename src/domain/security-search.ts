import type { Holding } from "./etf";
import { economicSecurityIdentity } from "./security-equivalence";

/** Keep an issuer's smaller listings discoverable beside its main ACWI line. */
export function securitySearchIssuerWeights(holdings: Holding[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const holding of holdings) {
    const { securityId } = economicSecurityIdentity(holding);
    weights.set(securityId, Math.max(weights.get(securityId) ?? 0, holding.weight));
  }
  return weights;
}
