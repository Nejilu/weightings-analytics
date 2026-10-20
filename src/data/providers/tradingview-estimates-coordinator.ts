import type { SecurityEstimateSeries } from "@/domain/metrics";

type SymbolResult = { series?: SecurityEstimateSeries; error?: Error };
type FetchBatch = (symbols: string[]) => Promise<SecurityEstimateSeries[]>;

// In-flight work only: entries disappear after completion. Different ETF and
// stock requests share a symbol without adding another observation cache.
export class EstimateRequestCoordinator {
  private readonly pending = new Map<string, Promise<SymbolResult>>();
  private readonly queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid estimates concurrency");
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) this.queue.shift()!();
  }

  async fetch(symbols: string[], fetcher: FetchBatch) {
    const requested = [...new Set(symbols)];
    const added = requested.filter((symbol) => !this.pending.has(symbol));
    if (added.length) {
      let finish!: (result: Map<string, SymbolResult>) => void;
      const task = new Promise<Map<string, SymbolResult>>((resolve) => { finish = resolve; });
      const entries = new Map(added.map((symbol) => [symbol,
        task.then((result) => result.get(symbol) ?? {})]));
      for (const [symbol, promise] of entries) this.pending.set(symbol, promise);
      this.queue.push(() => {
        this.active++;
        void (async () => {
          try {
            const series = new Map((await fetcher(added)).map((item) => [item.providerSymbol, item]));
            finish(new Map(added.map((symbol) => [symbol, { series: series.get(symbol) }])));
          } catch (error) {
            const failure = error instanceof Error ? error : new Error("Estimate batch failed");
            finish(new Map(added.map((symbol) => [symbol, { error: failure }])));
          } finally {
            for (const [symbol, promise] of entries) {
              if (this.pending.get(symbol) === promise) this.pending.delete(symbol);
            }
            this.active--;
            this.pump();
          }
        })();
      });
    }
    // Keep the promises before starting tasks, including synchronously failing
    // fetchers which may remove their entries before pump() returns.
    const pending = requested.map((symbol) => [symbol, this.pending.get(symbol)!] as const);
    this.pump();
    const results = await Promise.all(pending.map(async ([symbol, promise]) =>
      [symbol, await promise] as const));
    return {
      series: results.flatMap(([, result]) => result.series ? [result.series] : []),
      failedSymbols: results.flatMap(([symbol, result]) => result.error ? [symbol] : []),
    };
  }
}
