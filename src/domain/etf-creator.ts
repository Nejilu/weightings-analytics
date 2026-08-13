import type { Holding } from "./etf";

export type CreatorFilterMode = "include" | "exclude";
export type CreatorOverlapMode = "none" | "include" | "exclude";

export interface EtfCreatorCriteria {
  countryMode: CreatorFilterMode;
  countries: string[];
  sectorMode: CreatorFilterMode;
  sectors: string[];
  overlapMode: CreatorOverlapMode;
  overlapEtfId?: string;
}

export interface CreatorSelectedSecurity {
  securityId: string;
  ticker: string;
}

interface DynamicCreatorHoldings {
  holdings: Holding[];
  missingSecurities: CreatorSelectedSecurity[];
}

export function filterCreatorHoldings(
  holdings: Holding[],
  criteria: EtfCreatorCriteria,
  overlapSecurityIds: ReadonlySet<string> = new Set(),
): Holding[] {
  const countries = new Set(criteria.countries);
  const sectors = new Set(criteria.sectors);

  return holdings.filter((holding) => {
    if (countries.size > 0) {
      const countryMatches = countries.has(holding.country);
      if (
        (criteria.countryMode === "include" && !countryMatches) ||
        (criteria.countryMode === "exclude" && countryMatches)
      ) return false;
    }

    if (sectors.size > 0) {
      const sectorMatches = sectors.has(holding.sector);
      if (
        (criteria.sectorMode === "include" && !sectorMatches) ||
        (criteria.sectorMode === "exclude" && sectorMatches)
      ) return false;
    }

    if (criteria.overlapMode !== "none") {
      const overlaps = overlapSecurityIds.has(holding.securityId);
      if (criteria.overlapMode === "include" && !overlaps) return false;
      if (criteria.overlapMode === "exclude" && overlaps) return false;
    }

    return true;
  });
}

export function applyCreatorManualCuration(
  sourceHoldings: Holding[],
  automaticHoldings: Holding[],
  manualInclusions: ReadonlySet<string> = new Set(),
  manualExclusions: ReadonlySet<string> = new Set(),
): Holding[] {
  const automaticIds = new Set(
    automaticHoldings.map((holding) => holding.securityId),
  );

  return sourceHoldings.filter(
    (holding) =>
      (automaticIds.has(holding.securityId) ||
        manualInclusions.has(holding.securityId)) &&
      !manualExclusions.has(holding.securityId),
  );
}

export function normalizeCreatorHoldings(holdings: Holding[]): Holding[] {
  const total = holdings.reduce(
    (sum, holding) => sum + Math.max(0, holding.weight),
    0,
  );
  if (total <= 0) return [];

  const normalized = holdings
    .map((holding) => ({
      ...holding,
      weight: (Math.max(0, holding.weight) / total) * 100,
      marketValue: undefined,
    }))
    .sort((left, right) => right.weight - left.weight);
  const normalizedTotal = normalized.reduce(
    (sum, holding) => sum + holding.weight,
    0,
  );
  if (normalized.length > 0) {
    normalized[0] = {
      ...normalized[0],
      weight: normalized[0].weight + (100 - normalizedTotal),
    };
  }
  return normalized;
}

export function deriveDynamicCreatorHoldings(
  sourceHoldings: Holding[],
  selectedSecurities: CreatorSelectedSecurity[],
): DynamicCreatorHoldings {
  const sourceBySecurityId = new Map(
    sourceHoldings.map((holding) => [holding.securityId, holding]),
  );
  const uniqueSelection = selectedSecurities.filter(
    (security, index) =>
      security.securityId.trim() &&
      selectedSecurities.findIndex(
        (candidate) => candidate.securityId === security.securityId,
      ) === index,
  );
  const missingSecurities = uniqueSelection.filter(
    (security) => !sourceBySecurityId.has(security.securityId),
  );
  const holdings = normalizeCreatorHoldings(
    uniqueSelection.flatMap((security) => {
      const holding = sourceBySecurityId.get(security.securityId);
      return holding ? [holding] : [];
    }),
  );

  return { holdings, missingSecurities };
}

export function dynamicCreatorDescription(
  editableDescription: string,
  selectedCount: number,
  sourceTicker: string,
): string {
  return [
    editableDescription.trim(),
    `${selectedCount} ${sourceTicker} constituents selected; available source free-float weights are recalculated and normalized to 100% on every read.`,
  ]
    .filter(Boolean)
    .join(" ");
}
