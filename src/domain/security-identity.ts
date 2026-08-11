export interface SecurityIdentityDescriptor {
  securityId: string;
  ticker?: string;
  name: string;
  country?: string;
  isin?: string;
  cusip?: string;
  sedol?: string;
}

export interface SecurityIdentityMerge {
  sourceId: string;
  targetId: string;
}

export function normalizeSecurityIdentityPart(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLocaleUpperCase("en-US");
}

export function fallbackSecurityId(name: string, ticker: string): string {
  const normalizedName = normalizeSecurityIdentityPart(name);
  const normalizedTicker = normalizeSecurityIdentityPart(ticker);
  return normalizedTicker && normalizedTicker !== "CASH"
    ? `NAME:${normalizedName}:${normalizedTicker}`
    : `NAME:${normalizedName}`;
}

export function preferredSecurityId(
  security: Pick<
    SecurityIdentityDescriptor,
    "securityId" | "isin" | "sedol" | "cusip"
  >,
): string {
  const isin = normalizeSecurityIdentityPart(security.isin);
  if (isin) return isin;
  const sedol = normalizeSecurityIdentityPart(security.sedol);
  if (sedol) return `SEDOL:${sedol}`;
  const cusip = normalizeSecurityIdentityPart(security.cusip);
  if (cusip) return `CUSIP:${cusip}`;
  return security.securityId;
}

export function securityListingIdentity(
  security: Pick<SecurityIdentityDescriptor, "ticker" | "name" | "country">,
): string | null {
  const ticker = normalizeSecurityIdentityPart(security.ticker);
  const name = normalizeSecurityIdentityPart(security.name);
  if (!ticker || !name) return null;
  return [ticker, name, normalizeSecurityIdentityPart(security.country)].join("|");
}

export function securityTickerCountryIdentity(
  security: Pick<SecurityIdentityDescriptor, "ticker" | "country">,
): string | null {
  const ticker = normalizeSecurityIdentityPart(security.ticker);
  const country = normalizeSecurityIdentityPart(security.country);
  if (!ticker || !country) return null;
  return `${ticker}|${country}`;
}

function isLegacyFallback(securityId: string): boolean {
  return securityId.startsWith("NAME:");
}

function preferredLegacyFallback(
  securities: SecurityIdentityDescriptor[],
): SecurityIdentityDescriptor | undefined {
  const tickerSpecific = securities.filter(
    (security) =>
      isLegacyFallback(security.securityId) &&
      security.securityId.split(":").length >= 3,
  );
  return tickerSpecific.length === 1 ? tickerSpecific[0] : undefined;
}

function strongIdentityTokens(security: SecurityIdentityDescriptor): Set<string> {
  return new Set(
    [
      ["ISIN", security.isin],
      ["SEDOL", security.sedol],
      ["CUSIP", security.cusip],
    ]
      .map(([kind, value]) => {
        const normalized = normalizeSecurityIdentityPart(value);
        return normalized ? `${kind}:${normalized}` : null;
      })
      .filter((value): value is string => value !== null),
  );
}

function securityStrength(security: SecurityIdentityDescriptor): number {
  if (normalizeSecurityIdentityPart(security.isin)) return 4;
  if (normalizeSecurityIdentityPart(security.sedol)) return 3;
  if (normalizeSecurityIdentityPart(security.cusip)) return 2;
  return security.securityId.split(":").length >= 3 ? 1 : 0;
}

function strongIdentityComponents(
  securities: SecurityIdentityDescriptor[],
): SecurityIdentityDescriptor[][] {
  const strong = securities.filter(
    (security) => strongIdentityTokens(security).size > 0,
  );
  const parents = new Map(strong.map((security) => [security.securityId, security.securityId]));
  const byToken = new Map<string, SecurityIdentityDescriptor>();

  const find = (securityId: string): string => {
    const parent = parents.get(securityId) ?? securityId;
    if (parent === securityId) return parent;
    const root = find(parent);
    parents.set(securityId, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  for (const security of strong) {
    for (const token of strongIdentityTokens(security)) {
      const existing = byToken.get(token);
      if (existing) union(security.securityId, existing.securityId);
      else byToken.set(token, security);
    }
  }

  const components = new Map<string, SecurityIdentityDescriptor[]>();
  for (const security of strong) {
    const root = find(security.securityId);
    const component = components.get(root) ?? [];
    component.push(security);
    components.set(root, component);
  }
  return [...components.values()];
}

export function planSecurityIdentityMerges(
  securities: SecurityIdentityDescriptor[],
): SecurityIdentityMerge[] {
  const merges = new Map<string, SecurityIdentityMerge>();
  const canonicalStrongId = new Map<string, string>();
  for (const component of strongIdentityComponents(securities)) {
    const target = [...component].sort(
      (left, right) =>
        securityStrength(right) - securityStrength(left) ||
        left.securityId.localeCompare(right.securityId),
    )[0];
    for (const security of component) {
      canonicalStrongId.set(security.securityId, target.securityId);
      if (security.securityId !== target.securityId) {
        merges.set(security.securityId, {
          sourceId: security.securityId,
          targetId: target.securityId,
        });
      }
    }
  }

  const groups = new Map<string, SecurityIdentityDescriptor[]>();
  for (const security of securities) {
    const key = securityListingIdentity(security);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(security);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const strongTargets = new Set(
      group
        .map((security) => canonicalStrongId.get(security.securityId))
        .filter((securityId): securityId is string => Boolean(securityId)),
    );
    const targetId = strongTargets.size === 1
      ? [...strongTargets][0]
      : strongTargets.size === 0 && group.every((security) => isLegacyFallback(security.securityId))
        ? preferredLegacyFallback(group)?.securityId
        : undefined;
    if (!targetId) continue;

    for (const security of group) {
      if (
        security.securityId !== targetId &&
        isLegacyFallback(security.securityId)
      ) {
        merges.set(security.securityId, {
          sourceId: security.securityId,
          targetId,
        });
      }
    }
  }

  // Provider files do not use one stable company label: for example,
  // "MICROSOFT", "MICROSOFT CORP" and "MICROSOFT CORPORATION" can all
  // describe the same MSFT listing. Merge a legacy name-based identity when
  // ticker and country lead to exactly one durable market identity. Multiple
  // strong candidates remain deliberately ambiguous and are kept separate.
  const tickerCountryGroups = new Map<string, SecurityIdentityDescriptor[]>();
  for (const security of securities) {
    const key = securityTickerCountryIdentity(security);
    if (!key) continue;
    const group = tickerCountryGroups.get(key) ?? [];
    group.push(security);
    tickerCountryGroups.set(key, group);
  }

  for (const group of tickerCountryGroups.values()) {
    if (group.length < 2) continue;
    const strongTargets = new Set(
      group
        .map((security) => canonicalStrongId.get(security.securityId))
        .filter((securityId): securityId is string => Boolean(securityId)),
    );
    if (strongTargets.size !== 1) continue;
    const targetId = [...strongTargets][0];

    for (const security of group) {
      if (
        security.securityId !== targetId &&
        isLegacyFallback(security.securityId)
      ) {
        merges.set(security.securityId, {
          sourceId: security.securityId,
          targetId,
        });
      }
    }
  }
  return [...merges.values()].sort(
    (left, right) =>
      left.targetId.localeCompare(right.targetId) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}
