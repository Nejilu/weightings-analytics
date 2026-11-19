import WebSocket from "ws";
import { marketDate, type PriceBar } from "@/domain/adr-premium";
import { parseTradingViewFrames } from "./tradingview-estimates";

export interface TradingViewChart {
  currency: string;
  timezone: string;
  bars: PriceBar[];
}

const frame = (method: string, params: unknown[]) => {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${payload.length}~m~${payload}`;
};

/** TradingView regular-session corrections encode early closes and dayoffs. */
export function tradingViewSessionSeconds(session: string, corrections: string, date: string): number | null {
  let selected = session;
  for (const correction of corrections.split(";")) {
    const separator = correction.indexOf(":");
    if (separator < 0) continue;
    if (correction.slice(separator + 1).split(",").includes(date.replaceAll("-", ""))) selected = correction.slice(0, separator);
  }
  const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::[1-7]+)?$/.exec(selected);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return end > start && end <= 24 * 60 ? (end - start) * 60 : null;
}

export function fetchTradingViewChart(symbol: string, interval: "1" | "5" | "1D", count: number): Promise<TradingViewChart> {
  return new Promise((resolve, reject) => {
    const session = `cs_${Math.random().toString(36).slice(2, 14)}`;
    const bars = new Map<number, PriceBar>();
    let currency = "";
    let timezone = "";
    let regularSession = "";
    let sessionCorrections = "";
    let settled = false;
    const socket = new WebSocket("wss://data.tradingview.com/socket.io/websocket", {
      origin: "https://www.tradingview.com",
      headers: { "User-Agent": "WeightingsAnalytics/0.1 ADR premiums" },
      handshakeTimeout: 20_000,
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else {
        const output = [...bars.values()].sort((a, b) => a.timestamp - b.timestamp);
        if (interval === "1D" && timezone) {
          for (const bar of output) {
            const duration = tradingViewSessionSeconds(regularSession, sessionCorrections, marketDate(bar.timestamp, timezone));
            if (duration !== null) bar.sessionCloseTimestamp = bar.timestamp + duration;
          }
        }
        resolve({ currency, timezone, bars: output });
      }
    };
    const timer = setTimeout(() => finish(new Error(`TradingView chart timed out: ${symbol}`)), 25_000);
    socket.on("open", () => {
      socket.send(frame("set_auth_token", ["unauthorized_user_token"]));
      socket.send(frame("chart_create_session", [session, ""]));
      socket.send(frame("resolve_symbol", [session, "sym_1", `=${JSON.stringify({ symbol, adjustment: "splits", session: "regular" })}`]));
      socket.send(frame("create_series", [session, "s1", "s1", "sym_1", interval, count]));
    });
    socket.on("message", (data) => {
      if (settled) return;
      for (const raw of parseTradingViewFrames(String(data))) {
        if (raw.startsWith("~h~")) {
          socket.send(`~m~${raw.length}~m~${raw}`);
          continue;
        }
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (!message || typeof message !== "object") continue;
        if (message.m === "symbol_resolved") {
          const metadata = message.p?.[2];
          currency = typeof metadata?.currency_code === "string" ? metadata.currency_code : "";
          timezone = typeof metadata?.timezone === "string" ? metadata.timezone : "";
          const regular = Array.isArray(metadata?.subsessions)
            ? metadata.subsessions.find((session: { id?: string } | null) => session?.id === "regular") : undefined;
          regularSession = typeof regular?.session === "string" ? regular.session : typeof metadata?.session === "string" ? metadata.session : "";
          sessionCorrections = typeof regular?.["session-correction"] === "string" ? regular["session-correction"] : "";
        }
        if (message.m === "timescale_update") {
          const updates = message.p?.[1]?.s1?.s;
          for (const bar of Array.isArray(updates) ? updates : []) {
            const values = bar?.v;
            if (Array.isArray(values) && Number.isFinite(values[0]) && Number.isFinite(values[4])) {
              bars.set(values[0], { timestamp: values[0], close: values[4], volume: Number.isFinite(values[5]) ? values[5] : 0 });
            }
          }
        }
        if (message.m === "series_completed") finish();
        else if (typeof message.m === "string" && message.m.includes("error")) finish(new Error(`TradingView chart unavailable: ${symbol}`));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error(`TradingView chart closed before completion: ${symbol}`)));
  });
}
