import WebSocket from "ws";
import { parseTradingViewFrames } from "./tradingview-estimates";
import { selectTradingViewQuote, type MarketQuote } from "@/domain/market-quote";

const FIELDS = ["lp", "lp_time", "rtc", "rtc_time", "current_session", "currency_code", "update_mode", "timezone"];
const frame = (m: string, p: unknown[]) => {
  const payload = JSON.stringify({ m, p });
  return `~m~${payload.length}~m~${payload}`;
};

export function fetchTradingViewQuoteBatch(symbols: string[]): Promise<Map<string, MarketQuote>> {
  symbols = [...new Set(symbols)];
  if (!symbols.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const session = `qs_${Math.random().toString(36).slice(2, 14)}`;
    const values = new Map<string, Record<string, unknown>>();
    const completed = new Set<string>();
    const socket = new WebSocket("wss://data.tradingview.com/socket.io/websocket", {
      origin: "https://www.tradingview.com", handshakeTimeout: 10_000,
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(new Map([...values].flatMap(([symbol, fields]) => {
        const quote = selectTradingViewQuote(symbol, fields);
        return quote ? [[symbol, quote] as const] : [];
      })));
    };
    const timer = setTimeout(finish, 12_000);
    socket.on("open", () => {
      socket.send(frame("set_auth_token", ["unauthorized_user_token"]));
      socket.send(frame("quote_create_session", [session]));
      socket.send(frame("quote_set_fields", [session, ...FIELDS]));
      socket.send(frame("quote_add_symbols", [session, ...symbols]));
    });
    socket.on("message", (data) => {
      if (settled) return;
      for (const raw of parseTradingViewFrames(String(data))) {
        if (raw.startsWith("~h~")) { socket.send(`~m~${raw.length}~m~${raw}`); continue; }
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (message.m === "qsd") {
          const update = message.p?.[1];
          if (symbols.includes(update?.n) && update?.s === "ok" && update.v && typeof update.v === "object") {
            values.set(update.n, { ...values.get(update.n), ...update.v });
          }
          if (symbols.includes(update?.n) && update?.s === "error") completed.add(update.n);
        }
        if (message.m === "quote_completed") completed.add(message.p?.[1]);
        if (completed.size === symbols.length || String(message.m).includes("error")) finish();
      }
    });
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

/** Coalesce simultaneous row/portfolio requests; no price cache here, so forced
 * refreshes always reach the provider once the previous request has completed. */
export function createTradingViewQuoteLoader(fetchBatch = fetchTradingViewQuoteBatch) {
  const pending = new Map<string, { resolve: (quote: MarketQuote | null) => void; promise: Promise<MarketQuote | null> }>();
  const queue: string[] = [];
  let scheduled = false;
  let running = 0;
  const drain = () => {
    scheduled = false;
    while (running < 2 && queue.length) {
      const symbols = queue.splice(0, 100);
      running++;
      void Promise.resolve().then(() => fetchBatch(symbols)).catch(() => new Map<string, MarketQuote>()).then((quotes) => {
        for (const symbol of symbols) {
          pending.get(symbol)!.resolve(quotes.get(symbol) ?? null);
          pending.delete(symbol);
        }
      }).finally(() => { running--; drain(); });
    }
  };
  return (symbol: string): Promise<MarketQuote | null> => {
    const existing = pending.get(symbol);
    if (existing) return existing.promise;
    let resolve!: (quote: MarketQuote | null) => void;
    const promise = new Promise<MarketQuote | null>((done) => { resolve = done; });
    pending.set(symbol, { resolve, promise });
    queue.push(symbol);
    if (!scheduled) { scheduled = true; queueMicrotask(drain); }
    return promise;
  };
}

export const getTradingViewQuote = createTradingViewQuoteLoader();
