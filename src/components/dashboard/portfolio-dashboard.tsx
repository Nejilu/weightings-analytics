"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dashboardSeries, portfolioPeriodStart, type PortfolioPeriod, type PortfolioDashboardEntry } from "@/domain/portfolio-dashboard";

const colors = ["#536b8a", "#26775f", "#c26a3b", "#9a579e", "#bd4259", "#298a9c", "#88702c"];
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const formatValue = (value: number, mode: "relative" | "absolute", currency: "USD" | "EUR") => mode === "relative"
  ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%`
  : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);

export function PortfolioDashboard({ entries, owner, loading, error, onRetry }: {
  entries: PortfolioDashboardEntry[]; owner: boolean; loading: boolean; error: string | null; onRetry: () => void;
}) {
  const [mode, setMode] = useState<"relative" | "absolute">("relative");
  const [currency, setCurrency] = useState<"USD" | "EUR">("USD");
  const [period, setPeriod] = useState<PortfolioPeriod>({ preset: "All" });
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const eligible = useMemo(() => entries.filter((entry) => mode === "relative" || owner || entry.visibility === "public"), [entries, mode, owner]);
  const dates = useMemo(() => eligible.flatMap((entry) => entry.snapshots.map((point) => point.date)).sort(), [eligible]);
  const earliest = dates[0] ?? "";
  const latest = dates.at(-1) ?? "";
  const start = portfolioPeriodStart(period, earliest, latest);
  const series = useMemo(() => dashboardSeries(eligible, mode, currency, start), [eligible, mode, currency, start]);
  const displayed = series.filter((entry) => !hiddenIds.includes(entry.id));
  const chartData = useMemo(() => {
    const rows = new Map<string, Record<string, number>>();
    series.forEach((entry, index) => {
      if (hiddenIds.includes(entry.id)) return;
      entry.points.forEach((point) => {
        const row = rows.get(point.date) ?? { timestamp: Date.parse(`${point.date}T12:00:00Z`) };
        row[`series${index}`] = point.value;
        rows.set(point.date, row);
      });
    });
    return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [series, hiddenIds]);

  return <section className="panel portfolio-dashboard" aria-label="Portfolio comparison dashboard" aria-busy={loading}>
    <div className="panel-heading">
      <div><span className="eyebrow">Portfolio comparison</span><h2>Evolution over time</h2></div>
      <div className="portfolio-dashboard-controls">
        <div className="segmented-control" role="group" aria-label="Portfolio chart display">
          <button type="button" aria-pressed={mode === "relative"} className={mode === "relative" ? "is-active" : ""} onClick={() => setMode("relative")}>Relative %</button>
          <button type="button" aria-pressed={mode === "absolute"} className={mode === "absolute" ? "is-active" : ""} onClick={() => setMode("absolute")}>Absolute value</button>
        </div>
        <select aria-label="Portfolio chart currency" value={currency} onChange={(event) => setCurrency(event.target.value as "USD" | "EUR")}><option>USD</option><option>EUR</option></select>
      </div>
    </div>
    <div className="portfolio-dashboard-period">
      <label>From <input type="date" aria-label="Portfolio comparison start date" value={start} max={latest || undefined} onChange={(event) => setPeriod(event.target.value ? { date: event.target.value } : { preset: "All" })} disabled={!dates.length} /></label>
      <div className="portfolio-history-ranges" role="group" aria-label="Portfolio comparison period">
        {(["1M", "3M", "1Y", "All"] as const).map((preset) => <button key={preset} type="button" disabled={!dates.length} aria-pressed={"preset" in period && period.preset === preset} className={"preset" in period && period.preset === preset ? "is-active" : ""} onClick={() => setPeriod({ preset })}>{preset}</button>)}
      </div>
    </div>
    {earliest && start < earliest ? <p className="portfolio-dashboard-note" role="status">Saved history starts on {dateLabel(earliest)}. Earlier values are not available.</p> : null}
    {!owner ? <p className="portfolio-dashboard-note">{mode === "absolute" ? "Only fully public portfolios are shown in absolute value." : "Public and weights-only portfolios are shown. Exact amounts remain private for weights-only portfolios."}</p> : null}
    {loading ? <p className="portfolio-dashboard-message" role="status"><span className="spinner" /> Loading portfolio histories…</p>
      : error ? <div className="portfolio-dashboard-message" role="alert">{error}<button className="secondary-button" type="button" onClick={onRetry}>Retry</button></div>
      : chartData.length ? <div className="portfolio-dashboard-chart" role="img" aria-label={`${mode === "relative" ? "Relative evolution" : "Absolute values"} of ${displayed.length} portfolios in ${currency} from ${start}`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={chartData} margin={{ top: 12, right: 12, bottom: 8, left: 4 }} accessibilityLayer>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 6" vertical={false} />
            <XAxis dataKey="timestamp" type="number" scale="time" domain={chartData.length === 1 ? [chartData[0].timestamp - 43_200_000, chartData[0].timestamp + 43_200_000] : ["dataMin", "dataMax"]} tickFormatter={(time: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(time)} tick={{ fill: "var(--muted)", fontSize: 10 }} minTickGap={40} axisLine={false} tickLine={false} />
            <YAxis width={72} tickFormatter={(value: number) => mode === "relative" ? `${value.toFixed(1)}%` : new Intl.NumberFormat("en-US", { notation: "compact", style: "currency", currency, maximumFractionDigits: 1 }).format(value)} domain={["auto", "auto"]} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ stroke: "var(--faint)", strokeDasharray: "4 4" }} content={({ active, payload, label }) => active && payload?.length ? <div className="portfolio-history-tooltip portfolio-dashboard-tooltip">
              <span>{dateLabel(new Date(Number(label)).toISOString().slice(0, 10))}</span>
              {payload.map((item) => <div key={String(item.dataKey)}><span style={{ color: item.color }}>{item.name}</span><b>{formatValue(Number(item.value), mode, currency)}</b></div>)}
            </div> : null} />
            {series.map((entry, index) => hiddenIds.includes(entry.id) ? null : <Line key={entry.id} name={entry.ticker} dataKey={`series${index}`} type="linear" connectNulls stroke={colors[entries.findIndex((candidate) => candidate.id === entry.id) % colors.length]} strokeWidth={2.2} dot={{ r: chartData.length > 100 ? 1 : 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div> : <p className="portfolio-dashboard-message">{hiddenIds.length && series.length ? "Select a portfolio below to show its curve." : eligible.length ? "No saved snapshots in this period yet." : "No portfolios available in this view."}</p>}
    {!loading && !error ? <div className="portfolio-dashboard-legend" aria-label="Portfolios displayed on chart">
      {eligible.map((entry) => {
        const item = series.find((candidate) => candidate.id === entry.id);
        const last = item?.points.at(-1);
        return <button key={entry.id} type="button" aria-pressed={!hiddenIds.includes(entry.id)} onClick={() => setHiddenIds((ids) => ids.includes(entry.id) ? ids.filter((id) => id !== entry.id) : [...ids, entry.id])}>
          <i aria-hidden="true" style={{ background: colors[entries.findIndex((candidate) => candidate.id === entry.id) % colors.length] }} />
          <span><strong>{entry.ticker}</strong><small>{entry.name}</small></span>
          <b>{last ? formatValue(last.value, mode, currency) : "No snapshots"}</b>
          {mode === "relative" && item ? <small>Base: {dateLabel(item.baselineDate)}</small> : null}
        </button>;
      })}
    </div> : null}
    <p className="portfolio-dashboard-note">{mode === "relative" ? "Each curve starts at 0% at its first saved snapshot on or after the selected date. " : "Saved net asset values, including cash. "}Changes include deposits, withdrawals and portfolio edits. Missing days are not reconstructed; lines connect saved snapshots.</p>
  </section>;
}
