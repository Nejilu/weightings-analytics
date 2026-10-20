"use client";

import { useEffect, useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PortfolioHistory, PortfolioValueSnapshot } from "@/domain/portfolio-history";
import { investedIndices, latestInvestedSegment, type InvestedIndices, type PortfolioReturnBasis } from "@/domain/portfolio-invested-return";
import { InvestedReturnMethodology, PortfolioReturnToggle } from "./portfolio-return-toggle";

type HistoryPoint = Pick<PortfolioValueSnapshot, "date" | "capturedAt" | "reason"> & Partial<PortfolioValueSnapshot> & InvestedIndices & { indexUsd?: number; indexEur?: number; value?: number };
type HistoryView = Omit<PortfolioHistory, "snapshots"> & { snapshots: HistoryPoint[] };
const percent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

const ranges = [{ label: "1M", days: 30 }, { label: "3M", days: 90 }, { label: "1Y", days: 365 }, { label: "All", days: Infinity }];
const money = (value: number, currency: "EUR" | "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
const dateLabel = (timestamp: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(timestamp);

function HistoryTooltip({ active, payload, currency, relative }: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: HistoryPoint }>;
  currency: "EUR" | "USD";
  relative: boolean;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return <div className="portfolio-history-tooltip">
    <span>{new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(point.capturedAt))} · New York</span>
    <strong>{relative ? percent(point.value ?? 0) : money((currency === "EUR" ? point.valueEur : point.valueUsd) ?? 0, currency)}</strong>
    {!relative ? <small>{money((currency === "EUR" ? point.valueUsd : point.valueEur) ?? 0, currency === "EUR" ? "USD" : "EUR")}</small> : null}
    <small>{point.reason === "catchup" ? "Catch-up capture" : point.reason === "initial" ? "First capture" : "Daily capture"}</small>
    {point.quotesAsOf ? <small>Oldest quote: {dateLabel(Date.parse(point.quotesAsOf))}</small> : null}
  </div>;
}

export function PortfolioValueHistory({ portfolioId, currency: portfolioCurrency, owner = true, etfId, relative = false }: { portfolioId: string; currency: "EUR" | "USD"; owner?: boolean; etfId?: string; relative?: boolean }) {
  const [history, setHistory] = useState<HistoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [range, setRange] = useState(Infinity);
  const [basis, setBasis] = useState<PortfolioReturnBasis>("total");
  const [relativeCurrency, setRelativeCurrency] = useState<"USD" | "EUR">("USD");
  // Weights-only details have no monetary total/currency control. Their chart
  // can still select either recorded return series without a live FX request.
  const currency = relative ? relativeCurrency : portfolioCurrency;
  const percentage = relative || basis === "invested";
  const gradientId = `portfolio-history-${useId().replace(/:/g, "")}`;
  const endpoint = owner ? `/api/v1/portfolio/history?portfolioId=${encodeURIComponent(portfolioId)}` : `/api/v1/portfolio/published/${encodeURIComponent(etfId!)}/history`;

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "History could not be loaded.");
        if (!controller.signal.aborted) { setHistory(payload.data); setError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "History could not be loaded.");
      } finally { loading = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [endpoint]);

  async function toggle() {
    if (!owner || !history || saving) return;
    setSaving(true);
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !history.enabled }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Recording setting could not be saved.");
      setHistory(payload.data);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Recording setting could not be saved."); }
    finally { setSaving(false); }
  }

  const snapshots = (history?.snapshots ?? []).map((point) => ({ ...point, ...investedIndices(point.invested) }));
  const latest = snapshots.at(-1);
  const available = basis === "invested" ? latestInvestedSegment(snapshots) : snapshots;
  const lastAvailable = available.at(-1);
  const cutoff = lastAvailable ? Date.parse(lastAvailable.capturedAt) - range * 86_400_000 : -Infinity;
  const visible = available.filter((point) => Date.parse(point.capturedAt) >= cutoff);
  const selectedIndex = (point: HistoryPoint) => basis === "invested"
    ? (currency === "EUR" ? point.investedIndexEur : point.investedIndexUsd)!
    : (currency === "EUR" ? point.indexEur : point.indexUsd) ?? 100;
  const baseline = visible[0] ? selectedIndex(visible[0]) : 100;
  const data = visible.map((point) => ({ ...point, timestamp: Date.parse(point.capturedAt), value: percentage ? (selectedIndex(point) / baseline - 1) * 100 : (currency === "EUR" ? point.valueEur : point.valueUsd) ?? 0 }));
  const format = (value: number) => percentage ? percent(value) : money(value, currency);
  const first = data[0];
  const last = data.at(-1);
  const change = first && last ? last.value - first.value : 0;
  const positive = change >= 0;
  const color = positive ? "var(--mint)" : "var(--negative)";

  return <section className="panel portfolio-history-panel" aria-label="Portfolio value history">
    <div className="panel-heading portfolio-history-heading">
      <div><span className="eyebrow">Daily snapshots · {percentage ? `Return in ${currency}` : currency}</span><h2>{basis === "invested" ? "Invested performance over time" : "Portfolio value over time"}</h2></div>
      {owner ? <button type="button" className="holdings-cash-toggle" role="switch" aria-checked={history?.enabled ?? true} disabled={!history || saving} onClick={() => void toggle()}>
        {saving ? "Saving…" : history?.enabled === false ? "Recording paused" : "Daily recording"}<span className="holdings-cash-toggle-track" aria-hidden="true" />
      </button> : <span className="info-chip">Read-only · {relative ? "Amounts private" : "Published values"}</span>}
    </div>
    <div className="portfolio-dashboard-controls"><PortfolioReturnToggle value={basis} onChange={setBasis} />
      {relative ? <select aria-label="Portfolio history currency" value={currency} onChange={(event) => setRelativeCurrency(event.target.value as "USD" | "EUR")}><option>USD</option><option>EUR</option></select> : null}
    </div>
    <div className="portfolio-history-summary">
      <div><strong>{last ? format(last.value) : "—"}</strong>
        {data.length > 1 ? <span className={positive ? "is-positive" : "is-negative"}>{percentage ? percent(last!.value) : <>{positive ? "+" : ""}{money(change, currency)} ({positive ? "+" : ""}{(change / first.value * 100).toFixed(2)}%)</>} <small>over selected period</small></span> : <span>{last ? "Your history starts here" : history ? "Waiting for the first capture" : "Loading history…"}</span>}
      </div>
      <div className="portfolio-history-ranges" role="group" aria-label="History period">{ranges.map((item) => <button type="button" key={item.label} aria-pressed={range === item.days} className={range === item.days ? "is-active" : ""} onClick={() => setRange(item.days)}>{item.label}</button>)}</div>
    </div>
    {error ? <p className="portfolio-history-error" role="alert">{error}</p> : null}
    {history?.enabled && history.lastError ? <p className="portfolio-history-error" role="status">Last capture failed: {history.lastError} A new attempt is made after five minutes while the server is running.</p> : null}
    {data.length ? <div className="portfolio-history-chart" role="img" aria-label={`${data.length} saved portfolio values in ${percentage ? "percent" : currency}, from ${dateLabel(first.timestamp)} to ${dateLabel(last!.timestamp)}. Latest value ${format(last!.value)}.`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }} accessibilityLayer>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.2} /><stop offset="100%" stopColor={color} stopOpacity={0.01} /></linearGradient></defs>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 6" vertical={false} />
          <XAxis dataKey="timestamp" type="number" scale="time" domain={data.length === 1 ? [first.timestamp - 43_200_000, first.timestamp + 43_200_000] : ["dataMin", "dataMax"]} tickFormatter={dateLabel} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={40} />
          <YAxis domain={percentage ? ["auto", "auto"] : [(min: number) => Math.max(0, min * 0.97), (max: number) => max * 1.03]} tickFormatter={(value: number) => percentage ? `${value.toFixed(1)}%` : new Intl.NumberFormat("en-US", { notation: "compact", style: "currency", currency, maximumFractionDigits: 1 }).format(value)} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={76} />
          <Tooltip content={<HistoryTooltip currency={currency} relative={percentage} />} cursor={{ stroke: "var(--faint)", strokeDasharray: "4 4" }} />
          <Area type="linear" dataKey="value" stroke={color} strokeWidth={2.5} fill={`url(#${gradientId})`} dot={{ r: data.length > 120 ? 2 : 3, fill: "var(--surface)", strokeWidth: 2 }} activeDot={{ r: 6, stroke: "var(--surface)", strokeWidth: 3 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div> : <div className="portfolio-history-empty"><span aria-hidden="true">↗</span><p>{history?.enabled === false ? "Recording is paused. Turn it on to start collecting daily values." : basis === "invested" ? "Invested performance needs new captures with position data. Older totals cannot reconstruct it. A data gap or cash-only capture restarts the series." : "The first refreshed valuation will appear here. Each saved day adds a new point."}</p></div>}
    <div className="portfolio-history-footer"><span>{snapshots.length} saved point{snapshots.length === 1 ? "" : "s"}{latest ? ` · Last capture ${dateLabel(Date.parse(latest.capturedAt))}` : ""}</span><span>{history?.enabled === false ? "Paused · existing history retained" : "Daily at 16:10 New York · catch-up after 24h"}</span></div>
    <p className="portfolio-history-note">{basis === "invested" ? "Cash excluded · Normalized to 1× gross exposure · Price return, excluding cash dividends. Starts at 0% at the first available observation in the selected period." : <>{relative ? "Evolution starts at 0% at the first saved snapshot of the selected period. Exact amounts remain private. " : "Values include positions and cash. EUR uses the exchange rate saved with each capture. "}Days missed while the server is off remain missing; lines connect recorded points. Weekends and holidays use the latest available market quotes. Changes include deposits, withdrawals and edits to holdings.</>}</p>
    {basis === "invested" ? <InvestedReturnMethodology /> : null}
    {data.length ? <details className="portfolio-history-table"><summary>View saved values</summary><div className="table-scroll"><table><thead><tr><th>Captured (New York)</th>{percentage ? <th>Evolution (%)</th> : <><th>USD</th><th>EUR</th></>}<th>Capture</th></tr></thead><tbody>{data.slice().reverse().map((point) => <tr key={point.date}><td>{new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(point.capturedAt))}</td>{percentage ? <td>{percent(point.value)}</td> : <><td>{money(point.valueUsd ?? 0, "USD")}</td><td>{money(point.valueEur ?? 0, "EUR")}</td></>}<td>{point.reason === "catchup" ? "Catch-up" : point.reason === "initial" ? "Initial" : "Daily"}</td></tr>)}</tbody></table></div></details> : null}
  </section>;
}
