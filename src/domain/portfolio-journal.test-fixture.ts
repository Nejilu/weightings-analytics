import { compositionPatch, emptyJournalComposition, journalPositionKey, valueCounterfactual, type CounterfactualMarket, type JournalComposition, type JournalPosition, type PortfolioJournal } from "./portfolio-journal";

// Synthetic data used only by the reconstruction unit tests.
const asset = (ticker: string, quantity: number): JournalPosition => ({ ticker, quantity, referenceId: `demo-${ticker}`,
  kind: ["ACWI", "AGG", "GLD"].includes(ticker) ? "etf" : "security", name: ({ ACWI: "World equity ETF", MSFT: "Microsoft", NVDA: "NVIDIA", AAPL: "Apple", TSLA: "Tesla", AGG: "Bond ETF", GLD: "Gold ETF", JNJ: "Johnson & Johnson" } as Record<string, string>)[ticker] });
const dates = ["2026-05-06", "2026-06-12", "2026-07-09", "2026-08-21", "2026-09-18", "2026-10-12"];
const states: JournalComposition[] = [
  { name: "Atlas · Demo portfolio", items: [asset("ACWI", 100), asset("MSFT", 100)], cashPositions: [{ currency: "USD", amount: 50000 }] },
  { name: "Atlas · Demo portfolio", items: [asset("MSFT", 80), asset("NVDA", 150)], cashPositions: [{ currency: "USD", amount: 50900 }] },
  { name: "Atlas · Demo portfolio", items: [asset("MSFT", 80), asset("NVDA", 250), asset("AAPL", 50)], cashPositions: [{ currency: "USD", amount: 27400 }] },
  { name: "Atlas · Demo portfolio", items: [asset("MSFT", 80), asset("NVDA", 250), asset("TSLA", -40), asset("ACWI", 200)], cashPositions: [{ currency: "USD", amount: 26600 }] },
  { name: "Atlas · Demo portfolio", items: [asset("MSFT", 140), asset("NVDA", 100), asset("TSLA", -40), asset("ACWI", 200)], cashPositions: [{ currency: "USD", amount: 22400 }] },
  { name: "Atlas · Demo portfolio", items: [asset("MSFT", 140), asset("NVDA", 100), asset("ACWI", 300)], cashPositions: [{ currency: "USD", amount: 400 }] },
];
const historicalPrices = [
  { ACWI: 100, MSFT: 400, NVDA: 100, AAPL: 190, TSLA: 240 },
  { ACWI: 105, MSFT: 420, NVDA: 120, AAPL: 200, TSLA: 260 },
  { ACWI: 110, MSFT: 440, NVDA: 130, AAPL: 210, TSLA: 270 },
  { ACWI: 115, MSFT: 450, NVDA: 145, AAPL: 220, TSLA: 280 },
  { ACWI: 118, MSFT: 470, NVDA: 160, AAPL: 225, TSLA: 260 },
  { ACWI: 120, MSFT: 490, NVDA: 165, AAPL: 230, TSLA: 250 },
];
function demoMarket(values: Record<string, number>, date: string): CounterfactualMarket {
  return { fetchedAt: `${date}T20:10:00Z`, fx: {}, prices: Object.fromEntries(Object.entries(values).map(([ticker, priceUsd]) => [
    journalPositionKey(asset(ticker, 1)), { priceUsd, asOf: `${date}T20:00:00Z`, stale: false },
  ])) };
}
export const portfolioJournalFixture: { journal: PortfolioJournal; market: CounterfactualMarket } = {
  journal: { portfolioId: "demo-atlas", current: states.at(-1)!, entries: states.map((state, index) => ({
    id: index + 1, kind: index === 0 ? "created" : "edited", capturedAt: `${dates[index]}T16:30:00Z`,
    patch: compositionPatch(states[index - 1] ?? emptyJournalComposition(), state),
    valueUsd: valueCounterfactual(state, demoMarket(historicalPrices[index], dates[index])).valueUsd,
  })) },
  market: { ...demoMarket({ ACWI: 122, MSFT: 500, NVDA: 170, AAPL: 235, TSLA: 230 }, "2026-10-22"), fx: { EUR: { rateToUsd: 1.12, asOf: "2026-10-22T20:00:00Z", stale: false } } },
};
