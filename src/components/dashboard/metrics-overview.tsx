"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
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
  MetricCaptureWindow,
  MetricKey,
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
const DEFAULT_COMPONENT_POINT_LIMIT = 70;
const BUBBLE_AXIS_PADDING = 24;
const METRIC_GROUPS: Array<{
  id: string;
  title: string;
  description: string;
  method: string;
  color: string;
  keys: MetricKey[];
}> = [
  {
    id: "consensus-valuation",
    title: "Consensus valuation",
    description: "Valuation as quarterly earnings estimates roll forward.",
    method: "Estimate-only P/E · harmonic aggregation",
    color: "#6f57d2",
    keys: ["pe_estimate_window_0", "pe_estimate_window_4", "eps_growth_estimate_forward_4q"],
  },
  {
    id: "profitability-quality",
    title: "Profitability & quality",
    description: "Operating profitability and capital efficiency.",
    method: "Covered-weight arithmetic averages",
    color: "#36a88a",
    keys: ["operating_margin", "return_on_invested_capital", "return_on_equity"],
  },
  {
    id: "trailing-valuation",
    title: "Trailing valuation",
    description: "Price and enterprise-value multiples on reported fundamentals.",
    method: "Positive denominators · harmonic aggregation",
    color: "#e77e61",
    keys: [
      "price_earnings_ttm",
      "price_to_book",
      "price_to_sales",
      "enterprise_value_to_ebitda",
      "price_to_free_cash_flow",
    ],
  },
  {
    id: "income-risk",
    title: "Income & risk",
    description: "Portfolio income, financial leverage and market sensitivity.",
    method: "Covered-weight arithmetic averages",
    color: "#ad8540",
    keys: ["dividend_yield", "debt_to_equity", "beta_1y"],
  },
  {
    id: "growth",
    title: "Realized growth",
    description: "Trailing revenue and diluted EPS growth versus last year.",
    method: "Covered-weight arithmetic averages",
    color: "#3d85c6",
    keys: ["revenue_growth_ttm", "eps_diluted_growth_ttm"],
  },
  {
    id: "size",
    title: "Size profile",
    description: "Typical constituent size after ETF holding weights.",
    method: "Holding-weighted median market capitalization",
    color: "#8a6bb8",
    keys: ["market_cap"],
  },
];
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
  if (definition.unit === "compact_number") {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: definition.decimals,
    }).format(value);
  }
  const formatted = value.toLocaleString("en-US", {
    maximumFractionDigits: definition.decimals,
    minimumFractionDigits: definition.decimals,
  });
  if (definition.unit === "multiple") return `${formatted}×`;
  if (definition.unit === "percent") return `${formatted}%`;
  return formatted;
}

function formatDelta(
  value: number | null,
  reference: number | null,
  definition: MetricDefinitionView,
): string {
  if (value === null || reference === null) return "No comparable delta";
  const delta = value - reference;
  const sign = delta > 0 ? "+" : "";
  if (definition.unit === "compact_number") {
    return `${sign}${new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(delta)} vs reference`;
  }
  if (definition.unit === "percent") return `${sign}${delta.toFixed(1)} pts vs reference`;
  if (definition.unit === "multiple") return `${sign}${delta.toFixed(1)}× vs reference`;
  return `${sign}${delta.toFixed(definition.decimals)} vs reference`;
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

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCaptureWindow(window: MetricCaptureWindow | null): string {
  if (!window) return "Unavailable";
  const oldest = formatDate(window.oldest);
  const latest = formatDate(window.latest);
  return oldest === latest ? latest : `${oldest}–${latest}`;
}

function quantile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex];
  const upper = ordered[upperIndex];
  return lower + (upper - lower) * (position - lowerIndex);
}

function robustCentralBounds(
  values: number[],
  fallbackMin: number,
  fallbackMax: number,
  step: number,
): { min: number; max: number } {
  if (values.length === 0) return { min: fallbackMin, max: fallbackMax };
  const firstQuartile = quantile(values, 0.25);
  const thirdQuartile = quantile(values, 0.75);
  const interquartileRange = thirdQuartile - firstQuartile;
  const lowerFence = firstQuartile - 1.5 * interquartileRange;
  const upperFence = thirdQuartile + 1.5 * interquartileRange;
  const centralMin = Math.max(quantile(values, 0.05), lowerFence);
  const centralMax = Math.min(quantile(values, 0.95), upperFence);
  return {
    min: Math.min(fallbackMin, Math.floor(centralMin / step) * step),
    max: Math.max(fallbackMax, Math.ceil(centralMax / step) * step),
  };
}

function robustUpperBound(values: number[], fallback: number, step: number): number {
  if (values.length === 0) return fallback;
  const firstQuartile = quantile(values, 0.25);
  const thirdQuartile = quantile(values, 0.75);
  const interquartileRange = thirdQuartile - firstQuartile;
  const upperFence = thirdQuartile + 1.5 * interquartileRange;
  const centralMax = Math.min(quantile(values, 0.95), upperFence);
  return Math.max(fallback, Math.ceil(centralMax / step) * step);
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

function displayedDefinitionShortName(
  definition: MetricDefinitionView,
  horizon: ConsensusHorizon,
): string {
  if (definition.key === "pe_estimate_window_0") return "P/E · historical consensus";
  if (definition.key === "pe_estimate_window_4") return "P/E · forward consensus";
  if (definition.key === "eps_growth_estimate_forward_4q") {
    return `Expected EPS growth · ${consensusOption(horizon).label}`;
  }
  return definition.shortName;
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
  const summaries = result.etfs.map((etf) => {
    const consensus = etf.consensusWindows[horizon];
    const startingPe = consensus.valuationPath[4 - consensus.quarters]?.value ?? null;
    const forwardPe = consensus.valuationPath[4]?.value ?? null;
    const compression = startingPe !== null && forwardPe !== null && startingPe !== 0
      ? (forwardPe / startingPe - 1) * 100
      : null;
    return { etf, startingPe, forwardPe, compression, growth: consensus.growth.value };
  });
  return (
    <section className="metrics-feature-card metrics-feature-card--wide panel">
      <div className="metrics-feature-heading">
        <div><span className="eyebrow">P/E roll-down</span><h2>How forward earnings compress the P/E</h2></div>
        <p>Current price divided by {option.description}, rolled forward one quarter at each point.</p>
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
      <div className="metrics-valuation-summary" aria-label="P/E roll-down summary">
        {summaries.map(({ etf, startingPe, forwardPe, compression, growth }, index) => (
          <div key={etf.etfId}>
            <span><i style={{ background: FUND_COLORS[index] }} />{etf.ticker}</span>
            <strong>{formatNumber(startingPe)}× → {formatNumber(forwardPe)}×</strong>
            <small>{compression === null ? "—" : `${compression.toFixed(1)}%`} P/E change · {formatNumber(growth)}% earnings growth</small>
          </div>
        ))}
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
  const [showFullExtent, setShowFullExtent] = useState(false);
  const [showAllCompanies, setShowAllCompanies] = useState(false);
  const selected = result.etfs.find((etf) => etf.etfId === selectedEtfId) ?? result.etfs[0];
  const view = selected.componentValuation;
  const option = consensusOption(horizon);
  const allPoints = useMemo(() => view.points.flatMap((point) => {
    const displayed = displayComponentPoint(point, horizon);
    return displayed ? [displayed] : [];
  }).sort((left, right) => right.weight - left.weight), [horizon, view.points]);
  const points = showAllCompanies
    ? allPoints
    : allPoints.slice(0, DEFAULT_COMPONENT_POINT_LIMIT);
  const originalPointWeight = view.points.reduce((sum, point) => sum + point.weight, 0);
  const totalEligibleWeight = view.representedWeight > 0
    ? originalPointWeight / (view.representedWeight / 100)
    : 0;
  const fullMinGrowth = points.length
    ? Math.min(-10, Math.floor(Math.min(...points.map((point) => point.epsGrowth)) / 10) * 10)
    : -10;
  const fullMaxGrowth = points.length
    ? Math.max(30, Math.ceil(Math.max(...points.map((point) => point.epsGrowth)) / 10) * 10)
    : 30;
  const fullMaxPe = points.length
    ? Math.max(30, Math.ceil(Math.max(...points.map((point) => point.peForward)) / 10) * 10)
    : 30;
  const robustGrowthBounds = robustCentralBounds(
    points.map((point) => point.epsGrowth),
    -10,
    30,
    10,
  );
  const robustMinGrowth = robustGrowthBounds.min;
  const robustMaxGrowth = robustGrowthBounds.max;
  const robustMaxPe = robustUpperBound(
    points.map((point) => point.peForward),
    30,
    10,
  );
  const minGrowth = showFullExtent ? fullMinGrowth : robustMinGrowth;
  const maxGrowth = showFullExtent ? fullMaxGrowth : robustMaxGrowth;
  const maxPe = showFullExtent ? fullMaxPe : robustMaxPe;
  const outsideRobustFrame = points.filter((point) =>
    point.epsGrowth < robustMinGrowth || point.epsGrowth > robustMaxGrowth || point.peForward > robustMaxPe);
  const plottedPoints = showFullExtent
    ? points
    : points.filter((point) =>
        point.epsGrowth >= robustMinGrowth &&
        point.epsGrowth <= robustMaxGrowth &&
        point.peForward <= robustMaxPe);
  const plottedPointWeight = plottedPoints.reduce((sum, point) => sum + point.weight, 0);
  const representedWeight = totalEligibleWeight > 0
    ? (plottedPointWeight / totalEligibleWeight) * 100
    : 0;
  return (
    <section className="metrics-feature-card metrics-feature-card--bubble panel">
      <div className="metrics-feature-heading metrics-feature-heading--stacked">
        <div><span className="eyebrow">Constituent map</span><h2>{selected.ticker}: earnings growth versus P/E</h2></div>
        <div className="metrics-bubble-controls">
          <div className="metrics-fund-tabs" role="tablist" aria-label="ETF shown in constituent chart">
            {result.etfs.map((etf, index) => (
              <button
                key={etf.etfId}
                type="button"
                role="tab"
                aria-selected={etf.etfId === selected.etfId}
                onClick={() => {
                  setSelectedEtfId(etf.etfId);
                  setShowFullExtent(false);
                  setShowAllCompanies(false);
                }}
                style={{ "--tab-color": FUND_COLORS[index] } as React.CSSProperties}
              >{etf.ticker}</button>
            ))}
          </div>
          {allPoints.length > DEFAULT_COMPONENT_POINT_LIMIT ? (
            <button
              className="metrics-axis-toggle"
              type="button"
              aria-pressed={showAllCompanies}
              onClick={() => setShowAllCompanies((current) => !current)}
            >
              {showAllCompanies
                ? `Show top ${DEFAULT_COMPONENT_POINT_LIMIT}`
                : `Show all ${allPoints.length}`}
            </button>
          ) : null}
          <button className="metrics-axis-toggle" type="button" aria-pressed={showFullExtent} onClick={() => setShowFullExtent((current) => !current)}>
            {showFullExtent ? "Use robust axes" : "Show full extent"}
          </button>
        </div>
      </div>
      <div className="metrics-bubble-summary">
        <span><b>{plottedPoints.length}/{points.length}</b> selected companies plotted</span>
        <span><b>{representedWeight.toFixed(1)}%</b> ETF weight plotted</span>
        <span><b>{showAllCompanies ? "Full universe" : `Top ${DEFAULT_COMPONENT_POINT_LIMIT}`}</b> {showAllCompanies ? "shown" : "by ETF weight"}</span>
        {view.eligibleHoldingCount - allPoints.length > 0 ? <span><b>{view.eligibleHoldingCount - allPoints.length}</b> missing complete consensus/P/E</span> : null}
        {view.truncatedCount > 0 ? <span><b>{view.truncatedCount}</b> beyond top-500 by weight</span> : null}
        <span><b>{showFullExtent ? "Full" : "Robust IQR"} axes</b> {outsideRobustFrame.length} extreme points {showFullExtent ? "included" : "listed below"}</span>
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
              padding={{ left: BUBBLE_AXIS_PADDING, right: BUBBLE_AXIS_PADDING }}
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
              padding={{ top: BUBBLE_AXIS_PADDING, bottom: BUBBLE_AXIS_PADDING }}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted)", fontSize: 8 }}
              width={42}
            />
            <ZAxis type="number" dataKey="weight" name="ETF weight" unit="%" range={[18, 900]} />
            <ReferenceLine x={0} stroke="var(--faint)" strokeDasharray="3 4" />
            <Tooltip content={(props) => <ComponentTooltip {...props} horizon={horizon} />} cursor={{ strokeDasharray: "3 4" }} />
            <Scatter data={plottedPoints} fill={FUND_COLORS[result.etfs.indexOf(selected)]} fillOpacity={0.7} stroke="var(--surface)" strokeWidth={0.8} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {!showFullExtent && outsideRobustFrame.length > 0 ? (
        <details className="metrics-outlier-details">
          <summary>{outsideRobustFrame.length} constituents outside the robust frame — data retained</summary>
          <span>{outsideRobustFrame
            .sort((left, right) => right.weight - left.weight)
            .slice(0, 12)
            .map((point) => `${point.ticker} (${point.weight.toFixed(2)}%, ${point.epsGrowth.toFixed(1)}% growth, ${point.peForward.toFixed(1)}×)`)
            .join(" · ")}{outsideRobustFrame.length > 12 ? " · …" : ""}</span>
        </details>
      ) : null}
      <p className="metrics-chart-note">{showAllCompanies
        ? `All ${allPoints.length} available companies are shown.`
        : `The ${points.length} largest available companies by ETF weight are selected; ${Math.max(0, allPoints.length - points.length)} remain available through the full-universe toggle.`} Visible axes: {minGrowth}% to {maxGrowth}% growth and 0× to {maxPe}× P/E. {showFullExtent ? "Full extent includes every selected point; robust axes can be restored." : "Robust axes use the central 90% of selected values bounded by IQR fences, so isolated extremes never set the scale. Points outside the frame are listed instead of being partially clipped; full extent remains available."} Axis padding keeps the largest bubbles clear of every chart edge. Negative or zero annualized EPS has no finite P/E and is excluded. Up to 500 valid constituents are retained by descending ETF weight.</p>
    </section>
  );
}

function MetricGroupCard({
  group,
  result,
  horizon,
}: {
  group: (typeof METRIC_GROUPS)[number];
  result: MetricsOverviewResult;
  horizon: ConsensusHorizon;
}) {
  const definitions = group.keys.flatMap((key) => {
    const definition = result.definitions.find((item) => item.key === key);
    return definition ? [definition] : [];
  });
  if (definitions.length === 0) return null;

  return (
    <article
      className="metrics-group-card"
      style={{ "--metric-group-color": group.color } as React.CSSProperties}
      aria-labelledby={`metrics-group-${group.id}`}
    >
      <header className="metrics-group-heading">
        <div>
          <span>{group.title}</span>
          <h3 id={`metrics-group-${group.id}`}>{group.description}</h3>
        </div>
        <small>{definitions.length}</small>
      </header>
      <div className="metrics-group-scroll">
        <table className="metrics-group-table">
          <thead>
            <tr>
              <th>Metric</th>
              {result.etfs.map((etf, index) => (
                <th key={etf.etfId}>
                  <i style={{ background: FUND_COLORS[index] }} />
                  {etf.ticker}{index === 0 ? <b>Ref.</b> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {definitions.map((definition) => {
              const referenceMetric = displayedMetricFor(
                result.etfs[0],
                definition.key,
                horizon,
              );
              return (
                <tr key={definition.key}>
                  <td title={definition.description} tabIndex={0}>
                    <strong>{displayedDefinitionShortName(definition, horizon)}</strong>
                  </td>
                  {result.etfs.map((etf, index) => {
                    const metric = displayedMetricFor(etf, definition.key, horizon);
                    const details = [
                      definition.description,
                      `${metric?.coveredHoldings ?? 0}/${metric?.totalHoldings ?? 0} holdings`,
                      `${metric?.coverageWeight.toFixed(1) ?? "0.0"}% covered weight`,
                      `Captured ${formatCaptureWindow(metric?.captureWindow ?? null)}`,
                    ].join(" · ");
                    return (
                      <td key={etf.etfId} title={details} tabIndex={0}>
                        <strong>{formatMetric(metric?.value ?? null, definition)}</strong>
                        <small>
                          {index === 0
                            ? `${metric?.coverageWeight.toFixed(1) ?? "0.0"}% cov.`
                            : formatDelta(
                                metric?.value ?? null,
                                referenceMetric?.value ?? null,
                                definition,
                              )}
                        </small>
                        {index > 0 ? <em>{metric?.coverageWeight.toFixed(1) ?? "0.0"}% cov.</em> : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer>{group.method}</footer>
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
          <section className="metrics-freshness-panel panel" aria-label="Metrics source freshness">
            <div className="metrics-freshness-heading">
              <span className={`source-status source-status--${result.sourceStatus}`}>{result.sourceStatus}</span>
              <strong>{result.source}</strong>
              <small>{result.cacheTtlHours}h observation cache</small>
            </div>
            <dl>
              <div><dt>Calculated</dt><dd>{formatDateTime(result.calculatedAt)}</dd></div>
              <div><dt>Fundamentals captured</dt><dd>{formatCaptureWindow(result.fundamentalsCaptureWindow)}</dd></div>
              <div><dt>Consensus captured</dt><dd>{formatCaptureWindow(result.estimatesCaptureWindow)}</dd></div>
            </dl>
            {result.sourceWarnings.length > 0 ? (
              <details className="metrics-status-warnings">
                <summary>{result.sourceWarnings.length} data-quality warning{result.sourceWarnings.length > 1 ? "s" : ""}</summary>
                <span>{result.sourceWarnings.map((warning) => SOURCE_WARNING_LABELS[warning]).join(" · ")}</span>
              </details>
            ) : null}
          </section>

          <ConsensusHorizonControl value={consensusHorizon} onChange={setConsensusHorizon} />

          <section className="metrics-feature-grid">
            <ValuationPathChart result={result} horizon={consensusHorizon} />
            <EtfGrowthValuationChart result={result} horizon={consensusHorizon} />
          </section>
          <ComponentBubbleChart result={result} horizon={consensusHorizon} />

          <section className="metrics-groups-panel panel">
            <div className="panel-heading">
              <div><span className="eyebrow">Fundamental groups</span><h2>Read the portfolio by investment lens</h2></div>
              <span className="info-chip">First ETF is the reference</span>
            </div>
            <p className="metrics-groups-intro">Values, reference deltas and covered weight stay visible. Hover or focus a cell for the full definition, holding count and capture date.</p>
            <div className="metrics-group-grid">
              {[0, 1].map((columnIndex) => (
                <div className="metrics-group-column" key={columnIndex}>
                  {METRIC_GROUPS.filter((_, index) => index % 2 === columnIndex).map((group) => (
                    <MetricGroupCard
                      key={group.id}
                      group={group}
                      result={result}
                      horizon={consensusHorizon}
                    />
                  ))}
                </div>
              ))}
            </div>
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
