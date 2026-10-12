export interface TradingViewCapitalization {
  symbol: string;
  ticker: string;
  description: string;
  companyLogo: string | null;
  marketCapUsd: number | null;
  capturedAt: string;
}
const cache = new Map<string, TradingViewCapitalization>();
const productionFetch = globalThis.fetch;

export async function fetchTradingViewCapitalizations(symbols: string[], fetcher: typeof fetch = fetch, ttlMs = 86_400_000): Promise<TradingViewCapitalization[]> {
  const unique = [...new Set(symbols)];
  // Cache is used only with the real provider; fixture fetchers stay isolated.
  const cached = fetcher === productionFetch ? unique.flatMap((symbol) => {
    const row = cache.get(symbol);
    return row && Date.now() - Date.parse(row.capturedAt) < ttlMs ? [row] : [];
  }) : [];
  const fresh = new Set(cached.map((row) => row.symbol));
  const requested = unique.filter((symbol) => !fresh.has(symbol));
  const groups: string[][] = [];
  for (let index = 0; index < requested.length; index += 1000) groups.push(requested.slice(index, index + 1000));
  const rows = [...cached];
  let successful = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next++];
      try {
        const response = await fetcher("https://scanner.tradingview.com/global/scan", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ symbols: { tickers: group, query: { types: [] } }, columns: ["name", "description", "logoid", "market_cap_basic"], price_conversion: { to_currency: "usd" } }),
          cache: "no-store", signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) continue;
        const payload = await response.json() as { data?: { s?: unknown; d?: unknown }[] };
        if (!Array.isArray(payload.data)) continue;
        successful++;
        const allowed = new Set(group);
        const capturedAt = new Date().toISOString();
        for (const row of payload.data) {
          if (typeof row.s !== "string" || !allowed.has(row.s) || !Array.isArray(row.d)) continue;
          const value: TradingViewCapitalization = {
            symbol: row.s, ticker: typeof row.d[0] === "string" ? row.d[0] : row.s,
            description: typeof row.d[1] === "string" ? row.d[1] : "",
            companyLogo: typeof row.d[2] === "string" && row.d[2] ? row.d[2] : null,
            marketCapUsd: typeof row.d[3] === "number" && Number.isFinite(row.d[3]) ? row.d[3] : null, capturedAt,
          };
          rows.push(value);
          if (fetcher === productionFetch) cache.set(row.s, value);
        }
      } catch { /* Missing batches are represented by absent observations. */ }
    }
  }));
  if (requested.length && !successful && !rows.length) throw new Error("TradingView total capitalizations are unavailable.");
  return rows;
}
