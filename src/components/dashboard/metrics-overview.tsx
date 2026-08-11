"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type TooltipContentProps,
} from "recharts";

import type { CatalogGroup } from "@/domain/etf";
import type {
  ComponentValuationPoint,
  ConsensusAggregate,
  ConsensusHorizon,
  EtfMetricsOverview,
  MetricDefinitionView,
  MetricsOverviewResult,
  MetricsOverviewWarning,
  WeightedMetric,
} from "@/domain/metrics";
import { consensusQuarters, deriveConsensusWindow } from "@/domain/processors/derive-estimate-metrics";
import { EtfSearch } from "./etf-search";

interface MetricsOverviewProps {
  catalog: CatalogGroup[];
  initialEtfIds: string[];
}

const FUND_COLORS = ["#6f57d2", "#e77e61", "#36a88a", "#ad8540"];
const CONSENSUS_OPTIONS: Array<{
  horizon: ConsensusHorizon;
  label: string;
  description: string;
  historicalLabel: string;
  forwardLabel: string;
  stages: string[];
}> = [
  {
    horizon: "4q",
    label: "4Q rolling",
    description: "rolling sums of four quarterly estimates",
    historicalLabel: "last 4 historical estimates",
    forwardLabel: "next 4 consensus estimates",
    stages: ["Last 4Q estimates", "+1Q", "+2Q", "+3Q", "Next 4Q estimates"],
  },
  {
    horizon: "2q",
    label: "2Q annualized",
    description: "rolling two-quarter estimates, multiplied by two",
    historicalLabel: "last 2 historical estimates, annualized",
    forwardLabel: "next 2 consensus estimates, annualized",
    stages: ["-2Q", "-1Q", "Last 2Q", "+1Q", "Next 2Q", "+3Q", "+4Q"],
  },
  {
    horizon: "1q",
    label: "1Q annualized",
    description: "single-quarter estimates, multiplied by four",
    historicalLabel: "latest historical estimate, annualized",
    forwardLabel: "next-quarter consensus, annualized",
    stages: ["-3Q", "-2Q", "-1Q", "Last Q", "Next Q", "+2Q", "+3Q", "+4Q"],
  },
];

const SOURCE_WARNING_LABELS: Record<MetricsOverviewWarning, string> = {
  "holdings-stale": "Holdings cache stale",
  "mapping-unresolved": "Some TradingView mappings unresolved",
  "screener-partial": "Screener coverage partial",
  "screener-unavailable": "Screener unavailable; cached fundamentals retained",
  "estimates-partial": "Consensus estimates partial",
  "estimates-unavailable": "Estimates unavailable; cached series retained",
};

function formatMetric(value: number | null, definition: MetricDefinitionView): string {
  if (value === null) return "—";
  const formatted = value.toLocaleString("en-US", {
    maximumFractionDigits: definition.decimals,
    minimumFractionDigits: definition.decimals,
  });
  if (definition.unit === "multiple") return `${formatted}×`;
  if (definition.unit === "percent") return `${formatted}%`;
  return formatted;
}

function formatNumber(value: number | null, decimals = 1): string {
  return value === null ? "—" : value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function metricFor(
  metrics: WeightedMetric[],
  key: MetricDefinitionView["key"],
): WeightedMetric | undefined {
  return metrics.find((metric) => metric.key === key);
}

function consensusOption(horizon: ConsensusHorizon) {
  return CONSENSUS_OPTIONS.find((option) => option.horizon === horizon) ?? CONSENSUS_OPTIONS[0];
}

function displayedMetricFor(
  etf: EtfMetricsOverview,
  key: MetricDefinitionView["key"],
  horizon: ConsensusHorizon,
): WeightedMetric | ConsensusAggregate | undefined {
  const consensus = etf.consensusWindows[horizon];
  if (key === "pe_estimate_window_0") return consensus.valuationPath[4 - consensus.quarters];
  if (key === "pe_estimate_window_4") return consensus.valuationPath[4];
  if (key === "eps_growth_estimate_forward_4q") return consensus.growth;
  return metricFor(etf.metrics, key);
}

function displayedDefinitionName(
  definition: MetricDefinitionView,
  horizon: ConsensusHorizon,
): string {
  const option = consensusOption(horizon);
  if (definition.key === "pe_estimate_window_0") return `P/E on ${option.historicalLabel}`;
  if (definition.key === "pe_estimate_window_4") return `P/E on ${option.forwardLabel}`;
  if (definition.key === "eps_growth_estimate_forward_4q") {
    return `Expected EPS growth (${option.label})`;
  }
  return definition.name;
}

interface DisplayComponentValuationPoint extends ComponentValuationPoint {
  peHistorical: number;
  peForward: number;
  epsGrowth: number;
  historicalAnnualizedEps: number;
  forwardAnnualizedEps: number;
}

function displayComponentPoint(
  point: ComponentValuationPoint,
  horizon: ConsensusHorizon,
): DisplayComponentValuationPoint | null {
  const derived = deriveConsensusWindow({
    providerSymbol: point.providerSymbol,
    currency: point.currency,
    price: point.price,
    points: point.estimatePoints,
  }, consensusQuarters(horizon));
  if (!derived) return null;
  const peHistorical = derived.pePath[4 - derived.quarters];
  const peForward = derived.pePath[4];
  if (
    derived.growth === null ||
    typeof peHistorical !== "number" || typeof peForward !== "number"
  ) return null;
  return {
    ...point,
    peHistorical,
    peForward,
    epsGrowth: derived.growth,
    historicalAnnualizedEps: derived.historicalAnnualizedEps,
    forwardAnnualizedEps: derived.forwardAnnualizedEps,
  };
}

function ComponentTooltip({
  active,
  payload,
  horizon,
}: TooltipContentProps & { horizon: ConsensusHorizon }) {
  const point = payload?.[0]?.payload as DisplayComponentValuationPoint | undefined;
  if (!active || !point) return null;
  const option = consensusOption(horizon);
  return (
    <div className="metrics-bubble-tooltip">
      <strong>{point.ticker} · {point.name}</strong>
      <span>{point.sector} · {point.country} · {point.weight.toFixed(2)}% weight</span>
      <dl>
        <div><dt>Estimated EPS growth · {option.label}</dt><dd>{formatNumber(point.epsGrowth)}%</dd></div>
        <div><dt>P/E · {option.forwardLabel}</dt><dd>{formatNumber(point.peForward)}×</dd></div>
        <div><dt>P/E · {option.historicalLabel}</dt><dd>{formatNumber(point.peHistorical)}×</dd></div>
        <div><dt>Historical annualized EPS</dt><dd>{formatNumber(point.historicalAnnualizedEps, 2)} {point.currency}</dd></div>
        <div><dt>Forward annualized EPS</dt><dd>{formatNumber(point.forwardAnnualizedEps, 2)} {point.currency}</dd></div>
        <div><dt>Current price anchor</dt><dd>{formatNumber(point.price, 2)} {point.currency}</dd></div>
      </dl>
      <small>{point.estimatePoints.map((item) => `${item.fiscalPeriod}: ${formatNumber(item.estimate, 2)}${item.isHistorical ? " (historical estimate)" : " (current consensus)"}`).join(" · ")}</small>
    </div>
  );
}

function ValuationPathChart({
  result,
  horizon,
}: { result: MetricsOverviewResult; horizon: ConsensusHorizon }) {
  const option = consensusOption(horizon);
  const data = option.stages.map((stage, stageIndex) => ({
    stage,
    ...Object.fromEntries(result.etfs.map((etf) => [
      etf.ticker,
      etf.consensusWindows[horizon].valuationPath[stageIndex]?.value ?? null,
    ])),
  }));
  return (
    <section className="metrics-feature-card metrics-feature-card--wide panel">
      <div className="metrics-feature-heading">
        <div><span className="eyebrow">Valuation path</span><h2>Which earnings horizon does the market price?</h2></div>
        <p>An estimates-only EPS series using {option.description}, rolled forward one quarter at each point.</p>
      </div>
      <div className="metrics-feature-chart" aria-label="P/E valuation path by ETF">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 18, right: 24, bottom: 5, left: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 5" vertical={false} />
            <XAxis dataKey="stage" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 9 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--faint)", fontSize: 8 }} tickFormatter={(value) => `${value}×`} />
            <Tooltip
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 7, fontSize: 10 }}
              formatter={(value, name) => [`${formatNumber(typeof value === "number" ? value : null)}×`, name]}
            />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 9 }} />
            {result.etfs.map((etf, index) => (
              <Line
                key={etf.etfId}
                type="monotone"
                dataKey={etf.ticker}
                stroke={FUND_COLORS[index]}
                strokeWidth={2.2}
                dot={{ r: 4, fill: FUND_COLORS[index], strokeWidth: 2, stroke: "var(--surface)" }}
                activeDot={{ r: 6 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="metrics-chart-note">Every point uses current local-currency price divided by {option.description}. Historical reported EPS and reconstructed adjusted EPS are never used. ETF P/E is the holding-weighted harmonic mean.</p>
    </section>
  );
}

function EtfGrowthValuationChart({
  result,
  horizon,
}: { result: MetricsOverviewResult; horizon: ConsensusHorizon }) {
  const option = consensusOption(horizon);
  const data = result.etfs.flatMap((etf, index) => {
    const consensus = etf.consensusWindows[horizon];
    const growth = consensus.growth.value;
    const pe = consensus.valuationPath[4]?.value;
    return growth !== null && growth !== undefined && pe !== null && pe !== undefined
      ? [{ ticker: etf.ticker, growth, pe, size: 1, fill: FUND_COLORS[index] }]
      : [];
  });
  const medianGrowth = data.length ? [...data].sort((a, b) => a.growth - b.growth)[Math.floor(data.length / 2)].growth : 0;
  const medianPe = data.length ? [...data].sort((a, b) => a.pe - b.pe)[Math.floor(data.length / 2)].pe : 0;
  return (
    <section className="metrics-feature-card panel">
      <div className="metrics-feature-heading">
        <div><span className="eyebrow">ETF map</span><h2>Growth versus valuation</h2></div>
        <p>{option.forwardLabel} growth on x; P/E on the same annualized estimate window on y.</p>
      </div>
      <div className="metrics-feature-chart metrics-feature-chart--square" aria-label="ETF growth versus valuation scatter plot">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 28, right: 35, bottom: 18, left: 2 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 5" />
            <XAxis type="number" dataKey="growth" name="EPS growth" unit="%" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 8 }} label={{ value: `${option.forwardLabel} vs ${option.historicalLabel}`, position: "bottom", offset: 2, fill: "var(--faint)", fontSize: 8 }} />
            <YAxis type="number" dataKey="pe" name="Consensus P/E" unit="×" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 8 }} width={40} />
            <ZAxis type="number" dataKey="size" range={[180, 180]} />
            {data.length > 1 ? <ReferenceLine x={medianGrowth} stroke="var(--faint)" strokeDasharray="3 4" /> : null}
            {data.length > 1 ? <ReferenceLine y={medianPe} stroke="var(--faint)" strokeDasharray="3 4" /> : null}
            <Tooltip cursor={{ strokeDasharray: "3 4" }} formatter={(value, name) => [`${formatNumber(typeof value === "number" ? value : null)}${name === "EPS growth" ? "%" : "×"}`, name]} />
            <Scatter data={data}>
              {data.map((point) => <Cell key={point.ticker} fill={point.fill} />)}
              <LabelList dataKey="ticker" position="top" fill="var(--ink)" fontSize={9} fontWeight={700} />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function ComponentBubbleChart({
  result,
  horizon,
}: { result: MetricsOverviewResult; horizon: ConsensusHorizon }) {
  const [selectedEtfId, setSelectedEtfId] = useState("");
  const selected = result.etfs.find((etf) => etf.etfId === selectedEtfId) ?? result.etfs[0];
  const view = selected.componentValuation;
  const option = consensusOption(horizon);
  const points = useMemo(() => view.points.flatMap((point) => {
    const displayed = displayComponentPoint(point, horizon);
    return displayed ? [displayed] : [];
  }), [horizon, view.points]);
  const representedPointWeight = points.reduce((sum, point) => sum + point.weight, 0);
  const originalPointWeight = view.points.reduce((sum, point) => sum + point.weight, 0);
  const totalEligibleWeight = view.representedWeight > 0
    ? originalPointWeight / (view.representedWeight / 100)
    : 0;
  const representedWeight = totalEligibleWeight > 0
    ? (representedPointWeight / totalEligibleWeight) * 100
    : 0;
  const minGrowth = points.length
    ? Math.min(-10, Math.floor(Math.min(...points.map((point) => point.epsGrowth)) / 10) * 10)
    : -10;
  const maxGrowth = points.length
    ? Math.max(30, Math.ceil(Math.max(...points.map((point) => point.epsGrowth)) / 10) * 10)
    : 30;
  const maxPe = points.length
    ? Math.max(30, Math.ceil(Math.max(...points.map((point) => point.peForward)) / 10) * 10)
    : 30;
  return (
    <section className="metrics-feature-card metrics-feature-card--bubble panel">
      <div className="metrics-feature-heading metrics-feature-heading--stacked">
        <div><span className="eyebrow">Constituent map</span><h2>{selected.ticker}: earnings growth versus P/E</h2></div>
        <div className="metrics-fund-tabs" role="tablist" aria-label="ETF shown in constituent chart">
          {result.etfs.map((etf, index) => (
            <button
              key={etf.etfId}
              type="button"
              role="tab"
              aria-selected={etf.etfId === selected.etfId}
              onClick={() => setSelectedEtfId(etf.etfId)}
              style={{ "--tab-color": FUND_COLORS[index] } as React.CSSProperties}
            >{etf.ticker}</button>
          ))}
        </div>
      </div>
      <div className="metrics-bubble-summary">
        <span><b>{points.length}/{view.eligibleHoldingCount}</b> companies plotted</span>
        <span><b>{representedWeight.toFixed(1)}%</b> ETF weight represented</span>
        {view.eligibleHoldingCount - points.length > 0 ? <span><b>{view.eligibleHoldingCount - points.length}</b> missing complete consensus/P/E</span> : null}
        {view.truncatedCount > 0 ? <span><b>{view.truncatedCount}</b> beyond top-500 by weight</span> : null}
        <span><b>Dynamic axes</b> no outlier clipping</span>
        <span>Bubble size scales with holding weight</span>
      </div>
      <div className="metrics-bubble-chart" aria-label={`${selected.ticker} constituent growth versus valuation bubble chart`}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 15, right: 24, bottom: 25, left: 3 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 5" />
            <XAxis
              type="number"
              dataKey="epsGrowth"
              name="Expected EPS growth"
              unit="%"
              domain={[minGrowth, maxGrowth]}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted)", fontSize: 8 }}
              label={{ value: `${option.forwardLabel} vs ${option.historicalLabel}`, position: "bottom", offset: 8, fill: "var(--faint)", fontSize: 8 }}
            />
            <YAxis
              type="number"
              dataKey="peForward"
              name="Estimate-only P/E"
              unit="×"
              domain={[0, maxPe]}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted)", fontSize: 8 }}
              width={42}
            />
            <ZAxis type="number" dataKey="weight" name="ETF weight" unit="%" range={[18, 900]} />
            <ReferenceLine x={0} stroke="var(--faint)" strokeDasharray="3 4" />
            <Tooltip content={(props) => <ComponentTooltip {...props} horizon={horizon} />} cursor={{ strokeDasharray: "3 4" }} />
            <Scatter data={points} fill={FUND_COLORS[result.etfs.indexOf(selected)]} fillOpacity={0.7} stroke="var(--surface)" strokeWidth={0.8} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="metrics-chart-note">Visible axes: {minGrowth}% to {maxGrowth}% growth and 0× to {maxPe}× P/E. The selected {option.label} calculation is applied to the same complete consensus-series universe; negative or zero annualized EPS has no finite P/E and is excluded. Up to 500 valid constituents are retained by descending ETF weight.</p>
    </section>
  );
}

function MetricMiniChart({ definition, result }: { definition: MetricDefinitionView; result: MetricsOverviewResult }) {
  const data = result.etfs.map((etf) => ({ ticker: etf.ticker, value: metricFor(etf.metrics, definition.key)?.value ?? null }));
  return (
    <article className="metrics-chart-card">
      <div className="metrics-chart-heading">
        <div><span>{definition.category}</span><h3>{definition.shortName}</h3></div>
        <p>{definition.description}</p>
      </div>
      <div className="metrics-mini-chart" aria-label={`${definition.name} comparison`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 5, bottom: 0, left: -22 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="ticker" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 9 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--faint)", fontSize: 8 }} width={42} />
            <Tooltip cursor={{ fill: "var(--surface-muted)" }} contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--ink)", fontSize: 10 }} formatter={(value) => [formatMetric(typeof value === "number" ? value : null, definition), definition.name]} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={38}>{data.map((entry, index) => <Cell key={entry.ticker} fill={FUND_COLORS[index]} />)}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="metrics-values-row">{result.etfs.map((etf, index) => <span key={etf.etfId}><i style={{ background: FUND_COLORS[index] }} />{etf.ticker}<strong>{formatMetric(metricFor(etf.metrics, definition.key)?.value ?? null, definition)}</strong></span>)}</div>
    </article>
  );
}

function ConsensusHorizonControl({
  value,
  onChange,
}: {
  value: ConsensusHorizon;
  onChange: (value: ConsensusHorizon) => void;
}) {
  return (
    <section className="metrics-consensus-control panel">
      <div>
        <span className="eyebrow">Consensus EPS calculation</span>
        <strong>Rolling estimate horizon</strong>
        <small>Switch every EPS growth and estimate-only P/E view without reloading provider data.</small>
      </div>
      <div className="metrics-consensus-toggle" role="group" aria-label="Consensus EPS calculation horizon">
        {CONSENSUS_OPTIONS.map((option) => (
          <button
            key={option.horizon}
            type="button"
            aria-pressed={value === option.horizon}
            onClick={() => onChange(option.horizon)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function MetricsOverview({ catalog, initialEtfIds }: MetricsOverviewProps) {
  const allEtfs = useMemo(() => catalog.flatMap((group) => group.variants), [catalog]);
  const defaultId = allEtfs[0]?.id ?? "";
  const [selectedIds, setSelectedIds] = useState(() => [...new Set(initialEtfIds.filter((id) => allEtfs.some((etf) => etf.id === id)))].slice(0, 4));
  const [result, setResult] = useState<MetricsOverviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consensusHorizon, setConsensusHorizon] = useState<ConsensusHorizon>("4q");
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => () => {
    requestController.current?.abort();
  }, []);

  const invalidateRequest = () => {
    requestController.current?.abort();
    requestController.current = null;
  };

  const updateSelection = (index: number, nextId: string) => {
    setSelectedIds((current) => {
      const duplicateIndex = current.indexOf(nextId);
      if (duplicateIndex < 0 || duplicateIndex === index) return current.map((id, position) => position === index ? nextId : id);
      const previousId = current[index];
      return current.map((id, position) => position === index ? nextId : position === duplicateIndex ? previousId : id);
    });
    invalidateRequest();
    setLoading(false);
    setResult(null);
  };

  const addSelection = () => {
    const next = allEtfs.find((etf) => !selectedIds.includes(etf.id))?.id ?? defaultId;
    if (next) {
      invalidateRequest();
      setLoading(false);
      setSelectedIds((current) => [...current, next].slice(0, 4));
      setResult(null);
    }
  };

  const analyze = async () => {
    const uniqueIds = [...new Set(selectedIds.filter(Boolean))];
    if (uniqueIds.length === 0) return;
    invalidateRequest();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/v1/metrics/overview?etfs=${encodeURIComponent(uniqueIds.join(","))}`, {
        cache: "no-cache",
        signal: controller.signal,
      });
      const payload = await response.json() as { data?: MetricsOverviewResult; error?: string };
      if (!response.ok || !payload.data) throw new Error(payload.error ?? "TradingView metrics are unavailable.");
      if (requestController.current !== controller) return;
      setResult(payload.data);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      if (requestController.current !== controller) return;
      setError(requestError instanceof Error ? requestError.message : "TradingView metrics are unavailable.");
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        setLoading(false);
      }
    }
  };

  const secondaryDefinitions = result?.definitions.filter((definition) =>
    ["price_to_book", "price_to_sales", "return_on_equity", "dividend_yield", "debt_to_equity", "beta_1y"].includes(definition.key)) ?? [];

  return (
    <div className="metrics-overview">
      <section className="metrics-hero panel">
        <div><span className="eyebrow">Constituent fundamentals</span><h1>Metrics overview</h1><p>Compare valuation and earnings expectations from each holding up to the ETF level, with metric-by-metric coverage.</p></div>
        <div className="metrics-provider-mark"><span>TV</span><div><strong>TradingView Screener + Estimates</strong><small>Batched · daily cache</small></div></div>
      </section>

      <section className="metrics-builder panel">
        <div className="metrics-selector-grid">
          {selectedIds.map((etfId, index) => (
            <div className="metrics-selector" key={`${index}-${etfId}`}>
              <EtfSearch catalog={catalog} selectedId={etfId} label={`ETF ${index + 1}`} onSelect={(nextId) => updateSelection(index, nextId)} />
              {selectedIds.length > 1 ? <button className="metrics-remove" type="button" aria-label={`Remove ETF ${index + 1}`} onClick={() => { invalidateRequest(); setLoading(false); setSelectedIds((current) => current.filter((_, position) => position !== index)); setResult(null); }}>×</button> : null}
            </div>
          ))}
          {selectedIds.length < 4 ? <button className="metrics-add" type="button" onClick={addSelection}><b>+</b><span>Add ETF</span><small>Up to four funds</small></button> : null}
        </div>
        <div className="metrics-builder-action"><small>First load may take longer while constituent symbols are resolved.</small><button className="primary-button" type="button" onClick={analyze} disabled={loading}>{loading ? <span className="spinner" /> : <span>Load metrics</span>}</button></div>
      </section>

      {error ? <div className="alert alert--error">{error}</div> : null}

      {result ? (
        <>
          <section className="metrics-coverage-grid" aria-label="TradingView mapping coverage">
            {result.etfs.map((etf, index) => <article key={etf.etfId} style={{ borderTopColor: FUND_COLORS[index] }}><span>{etf.ticker} · symbol coverage</span><strong>{etf.mappingCoverageWeight.toFixed(1)}%</strong><small>{etf.mappedHoldings} / {etf.holdingsCount} equity holdings · {formatDate(etf.asOf)}</small></article>)}
          </section>
          <div className="metrics-status-line">
            <span className={`source-status source-status--${result.sourceStatus}`}>{result.sourceStatus}</span>
            {result.source} · data updated {new Date(result.calculatedAt).toLocaleString("en-GB")} · {result.cacheTtlHours}h cache
            {result.sourceWarnings.length > 0 ? (
              <span className="metrics-status-warnings" title="Data quality warnings">
                · {result.sourceWarnings.map((warning) => SOURCE_WARNING_LABELS[warning]).join(" · ")}
              </span>
            ) : null}
          </div>

          <ConsensusHorizonControl value={consensusHorizon} onChange={setConsensusHorizon} />

          <section className="metrics-feature-grid">
            <ValuationPathChart result={result} horizon={consensusHorizon} />
            <EtfGrowthValuationChart result={result} horizon={consensusHorizon} />
          </section>
          <ComponentBubbleChart result={result} horizon={consensusHorizon} />

          <section className="metrics-chart-grid">{secondaryDefinitions.map((definition) => <MetricMiniChart key={definition.key} definition={definition} result={result} />)}</section>

          <section className="metrics-table-panel panel">
            <div className="panel-heading"><div><span className="eyebrow">Audit trail</span><h2>Metric coverage</h2></div><span className="info-chip">P/E · P/B · P/S harmonic</span></div>
            <div className="metrics-table-scroll"><table className="metrics-table"><thead><tr><th>Metric</th>{result.etfs.map((etf) => <th key={etf.etfId}>{etf.ticker}</th>)}</tr></thead><tbody>{result.definitions.map((definition) => <tr key={definition.key}><td><strong>{displayedDefinitionName(definition, consensusHorizon)}</strong><small>{definition.category}</small></td>{result.etfs.map((etf) => { const metric = displayedMetricFor(etf, definition.key, consensusHorizon); return <td key={etf.etfId}><strong>{formatMetric(metric?.value ?? null, definition)}</strong><small>{metric?.coverageWeight.toFixed(1) ?? "0.0"}% weight · {metric?.coveredHoldings ?? 0}/{metric?.totalHoldings ?? 0}</small></td>; })}</tr>)}</tbody></table></div>
          </section>
        </>
      ) : !loading ? (
        <section className="metrics-empty panel"><span>∿</span><div><strong>Select funds, then load their constituent metrics.</strong><p>No aggregate is estimated until TradingView returns security-level observations.</p></div></section>
      ) : (
        <section className="metrics-loading panel"><span className="spinner" /><strong>Resolving symbols and loading grouped metrics…</strong></section>
      )}
    </div>
  );
}
