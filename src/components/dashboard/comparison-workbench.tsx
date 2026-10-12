"use client";

import { HoldingsSourceWarning } from "./holdings-source-warning";
import { MetricCard } from "./metric-card";
import { AdrPremiumBadge } from "./adr-premium-badge";
import { PortfolioValuationPanel, formatPortfolioUsd } from "./portfolio-valuation-panel";
import { PortfolioEvents } from "./portfolio-events";
import { PortfolioOverview } from "./portfolio-overview";
import { portfolioPositionValueUsd } from "@/domain/portfolio-valuation";

import { useEffect, useRef, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PublicationManager } from "./publication-manager";
import { ManualRefreshButton } from "@/components/dashboard/manual-refresh-button";
import type {
  CatalogGroup,
  ComparisonResult,
  ConstituentCoverage,
  EtfShareClass,
  ImplicitSleeve,
  SleevePosition,
} from "@/domain/etf";
import type {
  HoldingsAnalysisPosition,
  HoldingsAnalysisResult,
  DistortionMode,
  DistortionWeightingBasis,
} from "@/domain/holdings-analysis";
import { DEFAULT_DISTORTION_TOP_COUNT } from "@/domain/holdings-analysis";
import { calculateHoldingsDistortion } from "@/domain/processors/calculate-holdings-distortion";
import { calculateTotalCapDistortion } from "@/domain/processors/calculate-total-cap-distortion";
import type { CapitalizationReferenceData } from "@/domain/capitalization-reference";
import {
  rankDistortionPositions,
  rankDistortionTablePositions,
  absoluteDistortionLabel,
  relativeDistortionLabel,
  type DistortionRankingBasis,
  type DistortionTableRanking,
  type RankedDistortionPosition,
} from "@/domain/distortion-rankings";
import {
  countryToContinent,
  geographicCountryLabel,
} from "@/domain/geography";
import { holdingsCashDisplayPositions, type HoldingsCashDisplay } from "@/domain/holdings-cash-display";
import { EtfSearch } from "./etf-search";

const PortfolioAnalytics = dynamic(() => import("./portfolio-analytics").then((module) => module.PortfolioAnalytics));
const EtfCreator = dynamic(() => import("./etf-creator").then((module) => module.EtfCreator));

const MetricsOverview = dynamic(
  () => import("@/components/dashboard/metrics-overview").then((module) => module.MetricsOverview),
  {
    ssr: false,
    loading: () => <section className="metrics-loading panel"><span className="spinner" /><strong>Loading metrics workspace…</strong></section>,
  },
);

const AiAnalysisPanel = dynamic(() => import("./ai-analysis-panel").then((module) => module.AiAnalysisPanel), { ssr: false });

interface ComparisonWorkbenchProps {
  siteMode: "local" | "web";
  owner: boolean;
  ownerOrigin: string;
  publicOrigin: string;
  catalogRevision: string;
  catalog: CatalogGroup[];
}

type SelectionSide = "left" | "right";
type HoldingsWeightView = "securities" | "with-cash";
type GeographyGrouping = "country" | "continent";

const INITIAL_VISIBLE_POSITIONS = 50;

function matchesHoldingSearch(
  position: { ticker: string; name: string; securityId: string },
  query: string,
) {
  const normalize = (value: string) =>
    value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleUpperCase("en-US");
  const search = normalize(query.trim());
  return !search || [position.ticker, position.name, position.securityId]
    .some((value) => normalize(value).includes(search));
}

function HoldingsTableSearch({
  query,
  onChange,
  controls,
  count,
  total,
}: {
  query: string;
  onChange: (query: string) => void;
  controls: string;
  count: number;
  total: number;
}) {
  return (
    <div className="holdings-table-search">
      <label className="result-search">
        <span className="sr-only">Filter holdings by name, ticker or identifier</span>
        <input
          type="search"
          value={query}
          placeholder="Filter holdings by name or ticker"
          aria-controls={controls}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <span className="holdings-table-search-count" role="status">
        {query.trim() ? `${count} of ${total} holdings match` : `${total} holdings`}
      </span>
    </div>
  );
}

const COLORS = {
  left: "var(--left)",
  overlap: "var(--overlap)",
  right: "var(--right)",
  track: "var(--line)",
};

function formatPercent(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}

function formatDate(value: string) {
  const date = value.slice(0, 10).split("-");
  return date.length === 3 ? `${date[2]}/${date[1]}/${date[0]}` : value;
}

function holdingsPositionWeight(
  position: HoldingsAnalysisPosition,
  weightView: HoldingsWeightView,
) {
  return weightView === "with-cash"
    ? position.publishedWeight
    : (position.normalizedWeightExCash ?? 0);
}

function buildHoldingsDisplaySummary(
  analysis: HoldingsAnalysisResult,
  weightView: HoldingsWeightView,
) {
  const ranked = analysis.positions
    .filter(
      (position) => weightView === "with-cash" || !position.isCash,
    )
    .map((position) => ({
      ...position,
      displayWeight: holdingsPositionWeight(position, weightView),
    }))
    .sort((left, right) => right.displayWeight - left.displayWeight);
  return {
    top10Concentration: ranked
      .slice(0, 10)
      .reduce((sum, position) => sum + position.displayWeight, 0),
    topPosition: ranked[0] ?? null,
  };
}

function wrapperLabel(etf: EtfShareClass) {
  if (etf.fundType === "portfolio") return "Portfolio ETF";
  if (etf.fundType === "custom") return "Custom ETF";
  if (etf.wrapper === "SYNTHETIC") return "Synthetic UCITS";
  return etf.wrapper === "UCITS" ? "UCITS" : "US";
}

function comparisonFundLabel(
  comparison: ComparisonResult,
  side: SelectionSide,
) {
  const etf = comparison[side].etf;
  const peer = comparison[side === "left" ? "right" : "left"].etf;
  return etf.ticker === peer.ticker
    ? `${etf.ticker} · ${wrapperLabel(etf)}`
    : etf.ticker;
}

function normalizationMessage(
  ticker: string,
  coverage: ConstituentCoverage,
) {
  const missing = coverage.missingTickers.length
    ? ` Missing from the current ACWI snapshot: ${coverage.missingTickers.join(", ")}.`
    : "";
  return `${ticker}: normalization used ${coverage.used} of ${coverage.total} configured constituents.${missing}`;
}

function comparisonApiUrl(
  leftEtfId: string,
  rightEtfId: string,
  weightView: HoldingsWeightView,
  forceRefresh = false,
) {
  return `/api/v1/compare?left=${encodeURIComponent(leftEtfId)}&right=${encodeURIComponent(rightEtfId)}&includeCash=${weightView === "with-cash"}${forceRefresh ? "&refresh=true" : ""}`;
}

function ThemeToggle({ mobile = false }: { mobile?: boolean }) {
  const toggleTheme = () => {
    const root = document.documentElement;
    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = nextTheme;
    root.style.colorScheme = nextTheme;
    localStorage.setItem("weightings-analytics-theme", nextTheme);
  };

  return (
    <button
      className={`icon-button theme-toggle${mobile ? " theme-toggle--mobile" : ""}`}
      type="button"
      aria-label="Toggle color theme"
      title="Toggle color theme"
      onClick={toggleTheme}
    >
      <span className="theme-icon theme-icon--light" aria-hidden="true">☾</span>
      <span className="theme-icon theme-icon--dark" aria-hidden="true">☀</span>
    </button>
  );
}

function FundSelector({
  side,
  etfId,
  catalog,
  onEtfChange,
  label,
}: {
  side: SelectionSide;
  etfId: string;
  catalog: CatalogGroup[];
  onEtfChange: (side: SelectionSide, value: string) => void;
  label?: string;
}) {
  const etfs = catalog.flatMap((benchmark) => benchmark.variants);
  const etf = etfs.find((variant) => variant.id === etfId) ?? etfs[0];

  return (
    <section className={`fund-selector fund-selector--${side}`}>
      <div className="fund-selector__eyebrow">
        <span className="fund-dot" aria-hidden="true" />
        {label ?? `ETF ${side === "left" ? "A" : "B"}`}
      </div>
      <EtfSearch
        catalog={catalog}
        selectedId={etf.id}
        label={label ? `Search ${label.toLowerCase()}` : `Search ETF ${side === "left" ? "A" : "B"}`}
        onSelect={(value) => onEtfChange(side, value)}
      />
      <div className="fund-identity">
        <div className="ticker-tile">{etf.ticker}</div>
        <div>
          <strong>{etf.name}</strong>
          <p
            className={
              etf.description || etf.fundType === "portfolio"
                ? "fund-description"
                : ""
            }
            title={etf.description}
          >
            {etf.description ??
              (etf.fundType === "portfolio"
                ? `${etf.domicile} · dynamic look-through composition`
                : `${etf.domicile} · ${etf.distributionPolicy} · TER ${formatPercent(etf.ter, 2)}`)}
          </p>
        </div>
      </div>
    </section>
  );
}

function ComparisonPair({
  left,
  right,
  separator = "/",
}: {
  left: ReactNode;
  right: ReactNode;
  separator?: ReactNode;
}) {
  return (
    <span className="comparison-pair">
      <span className="fund-color--left">{left}</span>
      <i aria-hidden="true">{separator}</i>
      <span className="fund-color--right">{right}</span>
    </span>
  );
}

function OverlapDonut({ comparison }: { comparison: ComparisonResult }) {
  const data = [
    { name: "Overlap", value: comparison.overlapWeight },
    { name: "Difference", value: 100 - comparison.overlapWeight },
  ];

  return (
    <div className="donut-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            innerRadius={72}
            outerRadius={94}
            startAngle={90}
            endAngle={-270}
            stroke="none"
          >
            <Cell fill={COLORS.overlap} />
            <Cell fill={COLORS.track} />
          </Pie>
          <Tooltip
            formatter={(value) => formatPercent(Number(value))}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              color: "var(--ink)",
              boxShadow: "var(--shadow)",
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="donut-center" aria-hidden="true">
        <strong>{formatPercent(comparison.overlapWeight, 0)}</strong>
        <span>overlap</span>
      </div>
    </div>
  );
}

function SleeveBars({ comparison }: { comparison: ComparisonResult }) {
  const leftLabel = comparisonFundLabel(comparison, "left");
  const rightLabel = comparisonFundLabel(comparison, "right");
  return (
    <div className="sleeve-bars">
      <div className="sleeve-row">
        <div className="sleeve-row__header">
          <strong className="fund-color--left">{leftLabel}</strong>
          <span className="fund-color--left">{formatPercent(comparison.leftActiveWeight)} active</span>
        </div>
        <div className="sleeve-track">
          <span
            className="sleeve-segment sleeve-segment--left"
            style={{ width: `${comparison.leftActiveWeight}%` }}
          />
          <span
            className="sleeve-segment sleeve-segment--overlap"
            style={{ width: `${comparison.overlapWeight}%` }}
          />
        </div>
      </div>
      <div className="sleeve-row">
        <div className="sleeve-row__header">
          <strong className="fund-color--right">{rightLabel}</strong>
          <span className="fund-color--right">{formatPercent(comparison.rightActiveWeight)} active</span>
        </div>
        <div className="sleeve-track">
          <span
            className="sleeve-segment sleeve-segment--right"
            style={{ width: `${comparison.rightActiveWeight}%` }}
          />
          <span
            className="sleeve-segment sleeve-segment--overlap"
            style={{ width: `${comparison.overlapWeight}%` }}
          />
        </div>
      </div>
      <div className="legend">
        <span className="fund-color--left"><i className="legend-dot legend-dot--left" />Active {leftLabel}</span>
        <span className="fund-color--overlap"><i className="legend-dot legend-dot--overlap" />Overlap</span>
        <span className="fund-color--right"><i className="legend-dot legend-dot--right" />Active {rightLabel}</span>
      </div>
    </div>
  );
}

function SectorChart({ comparison }: { comparison: ComparisonResult }) {
  const data = comparison.sectorComparison
    .filter((sector) => sector.sector !== "Other")
    .slice(0, 7)
    .map((sector) => ({
      ...sector,
      shortSector:
        sector.sector.length > 20
          ? `${sector.sector.slice(0, 18)}…`
          : sector.sector,
    }));

  return (
    <ResponsiveContainer width="100%" height={286}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 8, bottom: 0, left: 4 }}
      >
        <CartesianGrid horizontal={false} stroke="var(--line)" />
        <XAxis
          type="number"
          tickFormatter={(value) => `${value}%`}
          axisLine={false}
          tickLine={false}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
        />
        <YAxis
          type="category"
          dataKey="shortSector"
          width={118}
          axisLine={false}
          tickLine={false}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
        />
        <Tooltip
          formatter={(value) => formatPercent(Number(value))}
          cursor={{ fill: "#f6f7f9" }}
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            color: "var(--ink)",
            boxShadow: "var(--shadow)",
          }}
        />
        <Bar
          dataKey="left"
          name={comparisonFundLabel(comparison, "left")}
          fill={COLORS.left}
          radius={[0, 4, 4, 0]}
          barSize={7}
        />
        <Bar
          dataKey="right"
          name={comparisonFundLabel(comparison, "right")}
          fill={COLORS.right}
          radius={[0, 4, 4, 0]}
          barSize={7}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

const IMPLICIT_SLEEVE_RANK_LIMIT = 10;

function ImplicitSleeveRanking({
  sleeve,
  side,
  sharedMaxWeight,
  sourceLabel,
  relativeLabel,
}: {
  sleeve: ImplicitSleeve;
  side: SelectionSide;
  sharedMaxWeight: number;
  sourceLabel: string;
  relativeLabel: string;
}) {
  const rankedPositions = sleeve.positions.slice(0, IMPLICIT_SLEEVE_RANK_LIMIT);
  const otherWeight = Math.max(0, 100 - sleeve.top10Concentration);

  return (
    <article className={`implicit-sleeve implicit-sleeve--${side}`}>
      <header className="implicit-sleeve__header">
        <div>
          <span className="implicit-sleeve__label">
            {side === "left" ? "ETF A" : "ETF B"} · implicit ETF
          </span>
          <h3>
            <b className={`fund-color--${side}`}>{sourceLabel}</b>{" "}
            <span>
              vs{" "}
              <b className={`fund-color--${side === "left" ? "right" : "left"}`}>
                {relativeLabel}
              </b>
            </span>
          </h3>
        </div>
        <strong>100%</strong>
      </header>

      <div className="implicit-sleeve__stats">
        <span>
          <b>{sleeve.positionsCount}</b>
          active holdings
        </span>
        <span>
          <b>{formatPercent(sleeve.top10Concentration)}</b>
          top 10
        </span>
        <span>
          <b>{formatPercent(sleeve.sourceActiveWeight)}</b>
          source weight
        </span>
      </div>

      {rankedPositions.length > 0 ? (
        <ol className="implicit-ranking">
          {rankedPositions.map((position, index) => (
            <li key={position.securityId}>
              <span className="implicit-ranking__rank">{index + 1}</span>
              <div className="implicit-ranking__security">
                <div>
                  <strong>{position.ticker}</strong>
                  <span>{position.name}</span>
                </div>
                <b>{formatPercent(position.normalizedWeight, 2)}</b>
                <div className="implicit-ranking__track" aria-hidden="true">
                  <span
                    style={{
                      width: `${sharedMaxWeight > 0 ? (position.normalizedWeight / sharedMaxWeight) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="implicit-sleeve__empty">
          No relative overweight remains after removing the shared portfolio.
        </div>
      )}

      <footer className="implicit-sleeve__footer">
        <span>Other active holdings</span>
        <strong>{formatPercent(otherWeight, 2)}</strong>
      </footer>
    </article>
  );
}

function ImplicitSleevesPanel({
  comparison,
}: {
  comparison: ComparisonResult;
}) {
  const leftSleeve = comparison.implicitSleeves.left;
  const rightSleeve = comparison.implicitSleeves.right;
  const leftLabel = comparisonFundLabel(comparison, "left");
  const rightLabel = comparisonFundLabel(comparison, "right");
  const sharedMaxWeight = Math.max(
    leftSleeve.positions[0]?.normalizedWeight ?? 0,
    rightSleeve.positions[0]?.normalizedWeight ?? 0,
  );

  return (
    <section className="panel implicit-sleeves-panel">
      <div className="panel-heading implicit-sleeves-heading">
        <div>
          <span className="eyebrow">Relative portfolio construction</span>
          <h2>Implicit active-sleeve ETFs</h2>
        </div>
        <span className="info-chip">Normalised to 100% · shared scale</span>
      </div>
      <p className="implicit-sleeves-intro">
        Each side contains only that ETF&apos;s relative overweights, rescaled
        to 100%. Choosing <span className="fund-color--left">{leftLabel}</span> over{" "}
        <span className="fund-color--right">{rightLabel}</span> is equivalent to going long the left
        implicit ETF and short the right one at the active-sleeve weight.
      </p>
      <div className="implicit-sleeves-grid">
        <ImplicitSleeveRanking
          sleeve={leftSleeve}
          side="left"
          sharedMaxWeight={sharedMaxWeight}
          sourceLabel={leftLabel}
          relativeLabel={rightLabel}
        />
        <ImplicitSleeveRanking
          sleeve={rightSleeve}
          side="right"
          sharedMaxWeight={sharedMaxWeight}
          sourceLabel={rightLabel}
          relativeLabel={leftLabel}
        />
      </div>
      <div className="implicit-sleeves-formula">
        Normalised weight = security active weight ÷ total active sleeve × 100
      </div>
    </section>
  );
}

function PositionTable({ comparison }: { comparison: ComparisonResult }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "overlap">("active");
  const [activeRankSide, setActiveRankSide] =
    useState<SelectionSide>("left");
  const [expandedView, setExpandedView] = useState<string | null>(null);
  const activeWeightField =
    activeRankSide === "left" ? "leftActiveWeight" : "rightActiveWeight";
  const leftLabel = comparisonFundLabel(comparison, "left");
  const rightLabel = comparisonFundLabel(comparison, "right");
  const activeRankTicker =
    activeRankSide === "left"
      ? leftLabel
      : rightLabel;
  const viewKey = `${comparison.calculatedAt}:${filter}:${activeRankSide}`;
  const isExpanded = expandedView === viewKey;

  const rows = useMemo(() => {
    const filtered = comparison.positions.filter((position) =>
      filter === "active"
        ? position[activeWeightField] > 0
        : position.overlapWeight > 0,
    );
    return filtered
      .sort((a, b) =>
        filter === "active"
          ? b[activeWeightField] - a[activeWeightField]
          : b.overlapWeight - a.overlapWeight,
      );
  }, [activeWeightField, comparison, filter]);
  const matchingRows = rows.filter((position) => matchesHoldingSearch(position, query));
  const visibleRows = isExpanded
    ? matchingRows
    : matchingRows.slice(0, INITIAL_VISIBLE_POSITIONS);
  const hasAdditionalRows = matchingRows.length > INITIAL_VISIBLE_POSITIONS;

  return (
    <section className="panel positions-panel">
      <div className="panel-heading panel-heading--table">
        <div>
          <span className="eyebrow">Security-level analysis</span>
          <h2>
            {filter === "active" ? (
              <>
                Largest{" "}
                <span className={`fund-color--${activeRankSide}`}>
                  {activeRankTicker}
                </span>{" "}
                active weights
              </>
            ) : "Largest shared positions"}
          </h2>
        </div>
        <div className="table-controls">
          {filter === "active" ? (
            <div className="rank-control">
              <span>Rank active sleeve</span>
              <div className="segmented-control" aria-label="Rank active sleeve by ETF">
                <button
                  type="button"
                  aria-pressed={activeRankSide === "left"}
                  className={`${activeRankSide === "left" ? "is-active " : ""}fund-color--left`}
                  onClick={() => setActiveRankSide("left")}
                >
                  {leftLabel}
                </button>
                <button
                  type="button"
                  aria-pressed={activeRankSide === "right"}
                  className={`${activeRankSide === "right" ? "is-active " : ""}fund-color--right`}
                  onClick={() => setActiveRankSide("right")}
                >
                  {rightLabel}
                </button>
              </div>
            </div>
          ) : null}
          <div className="segmented-control" aria-label="Filter positions">
            <button
              type="button"
              aria-pressed={filter === "active"}
              className={filter === "active" ? "is-active" : ""}
              onClick={() => setFilter("active")}
            >
              Active
            </button>
            <button
              type="button"
              aria-pressed={filter === "overlap"}
              className={filter === "overlap" ? "is-active" : ""}
              onClick={() => setFilter("overlap")}
            >
              Shared
            </button>
          </div>
        </div>
      </div>
      <HoldingsTableSearch
        query={query}
        onChange={setQuery}
        controls="security-level-positions"
        count={matchingRows.length}
        total={rows.length}
      />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Security</th>
              <th className="fund-color--left">{leftLabel}</th>
              <th>Overlap</th>
              <th className="fund-color--right">{rightLabel}</th>
              <th>Signal</th>
            </tr>
          </thead>
          <tbody id="security-level-positions">
            {matchingRows.length === 0 ? (
              <tr><td colSpan={5} className="holdings-table-empty">No holdings match your search.</td></tr>
            ) : null}
            {visibleRows.map((position) => (
              <PositionRow
                key={position.securityId}
                position={position}
                leftTicker={leftLabel}
                rightTicker={rightLabel}
              />
            ))}
          </tbody>
        </table>
      </div>
      {hasAdditionalRows ? (
        <button
          type="button"
          className="position-table-toggle"
          aria-controls="security-level-positions"
          aria-expanded={isExpanded}
          onClick={() => setExpandedView(isExpanded ? null : viewKey)}
        >
          <span>
            {isExpanded
              ? `Show first ${INITIAL_VISIBLE_POSITIONS} positions`
              : `Show all ${matchingRows.length} positions`}
          </span>
          <small>
            {isExpanded
              ? `${matchingRows.length} positions displayed`
              : `${INITIAL_VISIBLE_POSITIONS} of ${matchingRows.length} displayed`}
          </small>
          <b aria-hidden="true">{isExpanded ? "↑" : "↓"}</b>
        </button>
      ) : null}
    </section>
  );
}

function PositionRow({
  position,
  leftTicker,
  rightTicker,
}: {
  position: SleevePosition;
  leftTicker: string;
  rightTicker: string;
}) {
  const dominantSide =
    position.leftActiveWeight > position.rightActiveWeight
      ? "left"
      : position.rightActiveWeight > position.leftActiveWeight
        ? "right"
        : "overlap";
  const dominant = dominantSide === "left"
    ? `Overweight ${leftTicker}`
    : dominantSide === "right"
      ? `Overweight ${rightTicker}`
      : "Aligned weight";

  return (
    <tr>
      <td>
        <div className="security-cell">
          <span className="security-avatar">{position.ticker.slice(0, 2)}</span>
          <div>
            <strong className="security-ticker-with-premium"><span>{position.ticker}</span><AdrPremiumBadge security={position} /></strong>
            <span>{position.name}</span>
          </div>
        </div>
      </td>
      <td className="fund-color--left">{formatPercent(position.leftWeight, 2)}</td>
      <td>
        <span className="overlap-pill">
          {formatPercent(position.overlapWeight, 2)}
        </span>
      </td>
      <td className="fund-color--right">{formatPercent(position.rightWeight, 2)}</td>
      <td><span className={`reading fund-color--${dominantSide}`}>{dominant}</span></td>
    </tr>
  );
}

function distortionReading(score: number | null) {
  if (score === null) return "Unavailable";
  if (score < 2) return "Closely aligned with reference weights";
  if (score < 10) return "Limited weighting distortion";
  if (score < 25) return "Material weighting distortion";
  return "High weighting distortion";
}

function DistortionDirectionRanking({ positions, basis, direction }: {
  positions: RankedDistortionPosition[];
  basis: DistortionRankingBasis;
  direction: "over" | "under";
}) {
  const displayed = positions.slice(0, 5);
  return (
    <section className={`distortion-direction distortion-direction--${direction}`} aria-label={`${basis === "absolute" ? "Absolute" : "Relative"} ${direction === "over" ? "overweights" : "underweights"}`}>
      <header className="distortion-direction-heading">
        <h3>{direction === "over" ? "Overweights" : "Underweights"}</h3>
        <span>{positions.length > 5 ? `Top 5 of ${positions.length}` : `${positions.length} position${positions.length === 1 ? "" : "s"}`}</span>
      </header>
      {displayed.length > 0 ? (
        <ol className="distortion-ranking">
          {displayed.map((position, index) => (
            <li key={position.securityId}>
              <span className="distortion-ranking-rank">{index + 1}</span>
              <div className="distortion-ranking-security">
                <div className="distortion-ranking-value">
                  <strong title={position.ticker}>{position.ticker}</strong>
                  <b className={direction === "over" ? "distortion-over" : "distortion-under"}>
                    {basis === "relative" ? relativeDistortionLabel(position.relativeWeight!) : absoluteDistortionLabel(position.weightDelta)}
                  </b>
                </div>
                <span className="distortion-ranking-name" title={position.name}>{position.name}</span>
                <small>{formatPercent(position.actualWeight, 2)} vs {formatPercent(position.counterfactualWeight, 2)}{position.actualWeight === 0 ? " · not held" : ""}</small>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="distortion-ranking-empty">No {direction === "over" ? "overweights" : "underweights"} in this selection.</p>}
    </section>
  );
}

function DistortionRankingPanel({ analysis, basis }: {
  analysis: HoldingsAnalysisResult;
  basis: DistortionRankingBasis;
}) {
  const ranks = useMemo(() => rankDistortionPositions(analysis.positions, basis), [analysis.positions, basis]);
  return (
    <article className="panel holdings-distortion-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{basis === "absolute" ? "Weight differences" : "Weight ratios"}</span>
          <h2>{basis === "absolute" ? "Absolute weight gaps" : "Relative weight multiples"}</h2>
        </div>
        <span className="info-chip">{basis === "absolute" ? "Percentage points" : "×"}</span>
      </div>
      <p className="holdings-method-copy">
        {basis === "absolute" ? "Portfolio weight minus counterfactual weight, ranked by the largest gap on each side." : "Portfolio weight relative to its counterfactual: ×2 means double the weight; ×0.5 means half. ×0 means the security is not held."}
      </p>
      <div className="distortion-direction-grid">
        <DistortionDirectionRanking positions={ranks.overweights} basis={basis} direction="over" />
        <DistortionDirectionRanking positions={ranks.underweights} basis={basis} direction="under" />
      </div>
      {basis === "relative" && ranks.noBenchmarkCount > 0 ? (
        <p className="distortion-ranking-note">{ranks.noBenchmarkCount} holding{ranks.noBenchmarkCount === 1 ? " has" : "s have"} no ACWI weight. Their relative multiple is undefined; they appear in the absolute ranking.</p>
      ) : null}
    </article>
  );
}

function HoldingsDistortionRankings({ analysis }: { analysis: HoldingsAnalysisResult }) {
  return (
    <section aria-label="Absolute and relative distortion rankings">
      <div className="distortion-rankings-grid">
        <DistortionRankingPanel analysis={analysis} basis="absolute" />
        <DistortionRankingPanel analysis={analysis} basis="relative" />
      </div>
      <p className="holdings-method-copy distortion-ranking-method">
        {analysis.distortion.methodology === "tradingview-total-cap"
          ? `The index compares ${analysis.distortion.mode === "market-coverage" ? "the positive equity portfolio with the covered ACWI company universe" : analysis.distortion.mode === "top-holdings" ? `the ${analysis.distortion.topCount} largest positive equity companies` : "all positive equity companies"} using total company capitalization in USD. Each covered distribution is normalized to 100%.`
          : analysis.distortion.mode === "market-coverage"
          ? "The index compares all positive equity positions with the entire ACWI equity universe. ACWI securities absent from the portfolio have zero portfolio weight; portfolio equities outside ACWI have zero benchmark weight. Both equity distributions are normalized to 100%."
          : `The index compares ${analysis.distortion.mode === "top-holdings" ? `the ${analysis.distortion.topCount} largest positive equity positions` : "all positive equity positions"} with ACWI-implied free-float weights for the same covered securities. Each covered distribution is normalized to 100%.`}
        {" "}A score of 0 is aligned; 100 is the theoretical maximum. One point represents 1% of equity weight to reallocate. Cash, non-equity assets and shorts are excluded.
      </p>
      <div className="holdings-method-note">
        <span>
          Coverage {analysis.distortion.coverageWeight.toFixed(1)}% · {analysis.distortion.coveredHoldings}/
          {analysis.distortion.eligibleHoldings} equity holdings
        </span>
        <span>
          ACWI as of {formatDate(analysis.distortion.referenceAsOf)} · {distortionReading(analysis.distortion.score)}
        </span>
      </div>
    </section>
  );
}

function HoldingsDistortionDetails({ analysis }: { analysis: HoldingsAnalysisResult }) {
  const [basis, setBasis] = useState<DistortionWeightingBasis>("free-float");
  const [mode, setMode] = useState<DistortionMode>("top-holdings");
  const [topCount, setTopCount] = useState(DEFAULT_DISTORTION_TOP_COUNT);
  const [attempt, setAttempt] = useState(0);
  const universe = mode === "market-coverage" ? "market" : "holdings";
  const requestKey = `${analysis.etf.id}:${analysis.calculatedAt}:${universe}:${attempt}`;
  const [capitalizationResult, setCapitalizationResult] = useState<{
    key: string; data: CapitalizationReferenceData | null; error: string | null;
  }>({ key: "", data: null, error: null });
  const capitalizations = capitalizationResult.key === requestKey ? capitalizationResult.data : null;
  const capitalizationError = capitalizationResult.key === requestKey ? capitalizationResult.error : null;
  const totalCap = basis === "total-cap";
  const capitalizationLoading = totalCap && capitalizationResult.key !== requestKey;
  useEffect(() => {
    if (!totalCap || capitalizationResult.key === requestKey) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/v1/holdings/${encodeURIComponent(analysis.etf.id)}/capitalization?universe=${universe}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { data?: CapitalizationReferenceData; error?: string };
        if (!response.ok || !payload.data) throw new Error(payload.error ?? "Total market capitalizations are unavailable.");
        if (!controller.signal.aborted) setCapitalizationResult({ key: requestKey, data: payload.data, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setCapitalizationResult({ key: requestKey, data: null, error: error instanceof Error ? error.message : "Total market capitalizations are unavailable." });
      }
    })();
    return () => controller.abort();
  }, [totalCap, analysis.etf.id, universe, requestKey, capitalizationResult.key]);
  const selectionCount = useMemo(() => {
    if (!totalCap || !capitalizations) return analysis.equityHoldingsCount;
    const ids = new Map(capitalizations.observations.map((row) => [row.securityId, row.companyId ?? row.securityId]));
    const weights = new Map<string, number>();
    for (const position of analysis.positions.filter((p) => !p.isCash && p.assetClass.toLowerCase().includes("equity"))) {
      const id = ids.get(position.securityId) ?? position.securityId;
      weights.set(id, (weights.get(id) ?? 0) + position.publishedWeight);
    }
    return [...weights.values()].filter((weight) => weight > 0).length;
  }, [analysis, totalCap, capitalizations]);
  const effectiveCount = Math.min(topCount, selectionCount);
  const selected = useMemo(() => ({
    ...analysis,
    ...(totalCap && capitalizations
      ? calculateTotalCapDistortion(analysis.positions, analysis.distortionReferencePositions, analysis.distortion, capitalizations, mode, effectiveCount)
      : calculateHoldingsDistortion(analysis.positions, analysis.distortionReferencePositions, analysis.distortion, mode, effectiveCount)),
  }), [analysis, mode, effectiveCount, totalCap, capitalizations]);
  const { distortion } = selected;
  const market = mode === "market-coverage";
  const capCoverage = distortion.capitalizationCoverage;
  const issues = capitalizations?.observations.filter((observation) => observation.status !== "available") ?? [];
  const captureDates = capitalizations?.observations.filter((observation) => observation.status === "available" && observation.capturedAt)
    .map((observation) => observation.capturedAt!).sort() ?? [];
  return (
    <>
      <section className="panel distortion-controls" aria-label="Distortion calculation settings">
        <div className="panel-heading">
          <div><span className="eyebrow">Counterfactual weighting</span><h2>Choose the weighting basis</h2></div>
          <div className="segmented-control" role="group" aria-label="Counterfactual weighting basis">
            <button type="button" className={!totalCap ? "is-active" : ""} aria-pressed={!totalCap} onClick={() => setBasis("free-float")}>Free float · ACWI</button>
            <button type="button" className={totalCap ? "is-active" : ""} aria-pressed={totalCap} onClick={() => setBasis("total-cap")}>Total market cap</button>
          </div>
        </div>
        <p className="holdings-method-copy distortion-basis-copy">{totalCap
          ? "Experimental · Company-level market capitalizations in USD. Top / All holdings use the selected companies; Market Coverage reweights the ACWI universe. Equivalent share classes and ADRs count once. Missing or suspect values are excluded, never replaced by free-float weights."
          : "ACWI's published weights provide the free-float proxy. Top / All holdings compare common securities; Market Coverage uses the entire ACWI equity universe."}</p>
        <div className="panel-heading distortion-mode-heading">
          <div><span className="eyebrow">Reference universe</span><h2>Choose the distortion view</h2></div>
          <div className="segmented-control" role="group" aria-label="Distortion mode">
            {([
              ["top-holdings", "Top holdings"],
              ["all-holdings", "All holdings"],
              ["market-coverage", "Market Coverage"],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" className={mode === value ? "is-active" : ""} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>
            ))}
          </div>
        </div>
        {mode === "top-holdings" ? (
          <div className="distortion-top-control">
            <label htmlFor="distortion-top-count">Largest equity positions <strong>Top {effectiveCount}</strong></label>
            <input id="distortion-top-count" type="range" min={Math.min(2, Math.max(1, selectionCount))} max={Math.max(1, selectionCount)} step={1} value={Math.max(1, effectiveCount)} disabled={selectionCount < 2} onChange={(event) => setTopCount(Number(event.target.value))} aria-valuetext={`Top ${effectiveCount} equity positions`} aria-describedby="distortion-top-description" />
            <small id="distortion-top-description">Top 30 by default · {formatPercent(distortion.selectedWeight, 1)} of published portfolio weight selected · recalculates as you move the slider</small>
          </div>
        ) : null}
      </section>
      {capitalizationLoading ? <section className="panel distortion-capitalization-status" role="status"><span className="spinner" /> Loading total market capitalizations{market ? " for the ACWI universe" : " for the holdings"}…</section>
        : totalCap && capitalizationError ? <section className="panel distortion-capitalization-status" role="status"><span>{capitalizationError}</span><button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></section>
        : <>
      {totalCap && capCoverage ? (
        <div className="alert holdings-distortion-alert">
          TradingView total-cap coverage: {formatPercent(distortion.coverageWeight, 2)} of selected equity weight{market ? ` · ${formatPercent(capCoverage.referenceWeightCoverage, 2)} of the ACWI reference weight` : ""}.
          {capCoverage.excludedHoldings > 0 ? ` ${capCoverage.excludedHoldings} selected holding(s) excluded; both distributions are renormalized to the covered universe.` : ""}
          {!capCoverage.scoreAvailable ? " Score unavailable: requires at least 95% selected-weight coverage and, for Market Coverage, 99% ACWI reference coverage." : capCoverage.excludedHoldings > 0 || capCoverage.missingReferenceHoldings > 0 ? " Partial-universe score." : ""}
          {captureDates.length ? ` Capitalizations captured ${formatDate(captureDates[0])}${captureDates[0].slice(0, 10) !== captureDates.at(-1)!.slice(0, 10) ? ` – ${formatDate(captureDates.at(-1)!)}` : ""}; ACWI holdings as of ${formatDate(analysis.distortion.referenceAsOf)}.` : ""}
          {issues.length > 0 ? <details className="distortion-capitalization-issues"><summary>Unavailable or suspect capitalizations ({issues.length})</summary><ul>{issues.map((issue) => <li key={issue.securityId}>{issue.ticker} · {issue.status}</li>)}</ul></details> : null}
        </div>
      ) : null}
      {!totalCap && distortion.coverageStatus !== "complete" ? (
        <div className="alert holdings-distortion-alert">
          ACWI matching coverage is {distortion.coverageWeight.toFixed(1)}%: {distortion.missingHoldings} selected equity holding{distortion.missingHoldings === 1 ? " is" : "s are"} outside the current ACWI universe.
          {market ? " These positions are included with zero benchmark weight. All ACWI securities remain in the benchmark." : " The score uses only common securities, renormalized to 100%."}
        </div>
      ) : null}
      <section className="metric-grid" aria-label="Distortion metrics">
        <MetricCard label={market ? "Market Coverage" : "Weight distortion index"} value={distortion.score === null ? "—" : distortion.score.toFixed(1)} detail="1 point = 1% of equity weight to reallocate · 0 to 100" tone={distortion.score !== null && distortion.score < 2 ? "positive" : "left"} />
        <MetricCard label={totalCap ? "Capitalization coverage" : "ACWI matching coverage"} value={formatPercent(distortion.coverageWeight, totalCap ? 2 : 1)} detail={`${distortion.coveredHoldings} of ${distortion.eligibleHoldings} selected equity holdings`} tone={distortion.coverageStatus === "complete" ? "positive" : "neutral"} />
        <MetricCard label={market ? "ACWI reference universe" : totalCap ? "Covered companies" : "Common equity holdings"} value={`${distortion.referenceHoldings}`} detail={totalCap ? market ? `${formatPercent(capCoverage?.referenceWeightCoverage ?? 0, 2)} of ACWI weight covered` : "Weighted by total capitalization in USD" : market ? "Every ACWI equity position in the benchmark" : "Positions used in both distributions"} />
        <MetricCard label={totalCap && !market ? "Missing capitalizations" : "Outside ACWI"} value={`${distortion.missingHoldings}`} detail={totalCap && !market ? "Selected equity positions excluded from the score" : market ? "Included with zero benchmark weight" : "Equity positions excluded from the score"} tone={distortion.missingHoldings === 0 ? "positive" : "right"} />
      </section>
      {!totalCap || capCoverage?.scoreAvailable ? <HoldingsDistortionRankings analysis={selected} /> : null}
      <DistortionPositionsTable analysis={selected} />
      </>}
    </>
  );
}

function HoldingsSectorPanel({
  analysis,
  weightView,
}: {
  analysis: HoldingsAnalysisResult;
  weightView: HoldingsWeightView;
}) {
  const sectors = useMemo(() => {
    const weights = new Map<string, number>();
    const cashLabels = new Set<string>();
    for (const position of analysis.positions) {
      if (weightView === "securities" && position.isCash) continue;
      const sector = position.isCash
        ? position.name
        : position.sector || "Unclassified";
      if (position.isCash) cashLabels.add(sector);
      weights.set(
        sector,
        (weights.get(sector) ?? 0) +
          holdingsPositionWeight(position, weightView),
      );
    }
    return [...weights.entries()]
      .map(([sector, weight]) => ({ sector, weight }))
      .sort((left, right) => right.weight - left.weight)
      .filter((entry, index) => index < 9 || cashLabels.has(entry.sector));
  }, [analysis.positions, weightView]);
  const largestWeight = Math.max(...sectors.map((sector) => Math.abs(sector.weight)), 1);
  return (
    <article className="panel holdings-sector-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Allocation</span>
          <h2>Sector structure</h2>
        </div>
        <span className="info-chip">
          {weightView === "with-cash" ? "With cash" : "Normalized securities"}
        </span>
      </div>
      <div className="holdings-sector-list">
        {sectors.map((sector) => (
          <div key={sector.sector} className={sector.weight < 0 ? "is-negative" : undefined}>
            <span>{sector.sector}</span>
            <div aria-hidden="true">
              <i className={sector.weight < 0 ? "is-negative" : undefined} style={{ width: `${(Math.abs(sector.weight) / largestWeight) * 100}%` }} />
            </div>
            <strong>{formatPercent(sector.weight, 1)}</strong>
          </div>
        ))}
      </div>
    </article>
  );
}

function HoldingsGeographyPanel({
  analysis,
  weightView,
}: {
  analysis: HoldingsAnalysisResult;
  weightView: HoldingsWeightView;
}) {
  const [grouping, setGrouping] = useState<GeographyGrouping>("country");
  const allocations = useMemo(() => {
    const weights = new Map<string, number>();
    const cashLabels = new Set<string>();
    for (const position of analysis.positions) {
      if (weightView === "securities" && position.isCash) continue;
      const geography = position.isCash
        ? position.name
        : grouping === "country"
          ? geographicCountryLabel(position.country)
          : countryToContinent(position.country);
      if (position.isCash) cashLabels.add(geography);
      weights.set(
        geography,
        (weights.get(geography) ?? 0) +
          holdingsPositionWeight(position, weightView),
      );
    }
    return [...weights.entries()]
      .map(([geography, weight]) => ({ geography, weight }))
      .sort((left, right) => right.weight - left.weight)
      .filter((entry, index) => grouping !== "country" || index < 9 || cashLabels.has(entry.geography));
  }, [analysis.positions, grouping, weightView]);
  const largestWeight = Math.max(
    ...allocations.map((allocation) => Math.abs(allocation.weight)),
    1,
  );

  return (
    <article className="panel holdings-geography-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Allocation</span>
          <h2>Geographic structure</h2>
        </div>
        <div className="segmented-control" role="group" aria-label="Group geography by">
          <button
            type="button"
            className={grouping === "country" ? "is-active" : ""}
            aria-pressed={grouping === "country"}
            onClick={() => setGrouping("country")}
          >
            Countries
          </button>
          <button
            type="button"
            className={grouping === "continent" ? "is-active" : ""}
            aria-pressed={grouping === "continent"}
            onClick={() => setGrouping("continent")}
          >
            Continents
          </button>
        </div>
      </div>
      <div className="holdings-sector-list holdings-geography-list">
        {allocations.map((allocation) => (
          <div key={allocation.geography} className={allocation.weight < 0 ? "is-negative" : undefined}>
            <span>{allocation.geography}</span>
            <div aria-hidden="true">
              <i
                style={{
                  width: `${(Math.abs(allocation.weight) / largestWeight) * 100}%`,
                  background: allocation.weight < 0 ? "var(--negative)" : undefined,
                }}
              />
            </div>
            <strong>{formatPercent(allocation.weight, 1)}</strong>
          </div>
        ))}
      </div>
    </article>
  );
}

function DistortionPositionsTable({
  analysis,
}: {
  analysis: HoldingsAnalysisResult;
}) {
  const [query, setQuery] = useState("");
  const [ranking, setRanking] = useState<DistortionTableRanking>("weight");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const viewKey = `${analysis.calculatedAt}:${analysis.distortion.methodology}:${analysis.distortion.mode}:${analysis.distortion.topCount}:${ranking}`;
  const rows = useMemo(
    () => rankDistortionTablePositions(analysis.positions, ranking),
    [analysis.positions, ranking],
  );
  const isExpanded = expandedKey === viewKey;
  const matchingRows = rows.filter((position) => matchesHoldingSearch(position, query));
  const visibleRows = isExpanded
    ? matchingRows
    : matchingRows.slice(0, INITIAL_VISIBLE_POSITIONS);
  const hasAdditionalRows = matchingRows.length > INITIAL_VISIBLE_POSITIONS;

  return (
    <section className="panel holdings-position-table distortion-position-table">
      <div className="panel-heading panel-heading--table">
        <div>
          <span className="eyebrow">Security-level analysis</span>
          <h2>{analysis.etf.ticker} {analysis.distortion.mode === "market-coverage" ? analysis.distortion.methodology === "tradingview-total-cap" ? "and ACWI company universe" : "and full ACWI universe" : "holdings and counterfactual weights"}</h2>
        </div>
        <div className="segmented-control distortion-table-ranking" role="group" aria-label="Rank holdings">
          <button
            type="button"
            className={ranking === "weight" ? "is-active" : ""}
            aria-pressed={ranking === "weight"}
            onClick={() => setRanking("weight")}
          >
            ETF weight
          </button>
          <button
            type="button"
            className={ranking === "absolute" ? "is-active" : ""}
            aria-pressed={ranking === "absolute"}
            onClick={() => setRanking("absolute")}
          >
            Distortion delta
          </button>
          <button
            type="button"
            className={ranking === "relative" ? "is-active" : ""}
            aria-pressed={ranking === "relative"}
            onClick={() => setRanking("relative")}
          >
            Distortion multiple
          </button>
        </div>
      </div>
      {ranking === "relative" ? (
        <p className="distortion-table-ranking-note">Largest relative departures first, on either side: ×5 and ×0.2 have the same magnitude. ×0 means not held; undefined multiples sort last.</p>
      ) : null}
      <HoldingsTableSearch
        query={query}
        onChange={setQuery}
        controls="holdings-analysis-positions"
        count={matchingRows.length}
        total={rows.length}
      />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Security</th>
              <th>Published weight</th>
              <th>{analysis.distortion.mode === "market-coverage" ? "Equity portfolio weight" : "Selected covered weight"}</th>
              <th>{analysis.distortion.methodology === "tradingview-total-cap" ? "Total-cap implied weight" : "ACWI-implied weight"}</th>
              <th>Delta</th>
              <th>Weight multiple</th>
              <th>Score contribution</th>
            </tr>
          </thead>
          <tbody id="holdings-analysis-positions">
            {matchingRows.length === 0 ? (
              <tr><td colSpan={7} className="holdings-table-empty">No holdings match your search.</td></tr>
            ) : null}
            {visibleRows.map((position) => (
              <tr key={position.securityId}>
                <td>
                  <div className="security-cell">
                    <span className="security-avatar">{position.ticker.slice(0, 2)}</span>
                    <div>
                      <strong className="security-ticker-with-premium"><span>{position.ticker}</span><AdrPremiumBadge security={position} /></strong>
                      <span>{position.name} · {position.country}</span>
                    </div>
                  </div>
                </td>
                <td>{formatPercent(position.publishedWeight, 2)}</td>
                <td>{position.actualWeight === null ? "—" : formatPercent(position.actualWeight, 2)}</td>
                <td>{position.counterfactualWeight === null ? "—" : formatPercent(position.counterfactualWeight, 2)}</td>
                <td>
                  {position.weightDelta === null ? (
                    <span className="reading">
                      {position.distortionStatus === "missing-capitalization" ? "Missing market cap" : analysis.distortion.methodology === "tradingview-total-cap" ? "Insufficient coverage" : position.distortionStatus === "non-equity" ? "Non-equity" : "Not in ACWI"}
                    </span>
                  ) : (
                    <span className={position.weightDelta >= 0 ? "distortion-over" : "distortion-under"}>
                      {absoluteDistortionLabel(position.weightDelta)}
                    </span>
                  )}
                </td>
                <td>
                  {position.relativeWeight === null ? (
                    <span title={position.counterfactualWeight === 0 ? "No benchmark weight; the multiple is undefined." : "No comparable counterfactual weight."}>—</span>
                  ) : (
                    <span className={position.relativeWeight > 1 ? "distortion-over" : position.relativeWeight < 1 ? "distortion-under" : undefined}>
                      {relativeDistortionLabel(position.relativeWeight)}
                    </span>
                  )}
                </td>
                <td>
                  {position.distortionContribution === null
                    ? "—"
                    : position.distortionContribution.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasAdditionalRows ? (
        <button
          type="button"
          className="position-table-toggle"
          aria-controls="holdings-analysis-positions"
          aria-expanded={isExpanded}
          onClick={() => setExpandedKey(isExpanded ? null : viewKey)}
        >
          <span>
            {isExpanded
              ? `Show first ${INITIAL_VISIBLE_POSITIONS} holdings`
              : `Show all ${matchingRows.length} holdings`}
          </span>
          <small>
            {isExpanded
              ? `${matchingRows.length} holdings displayed`
              : `${INITIAL_VISIBLE_POSITIONS} of ${matchingRows.length} displayed`}
          </small>
          <b aria-hidden="true">{isExpanded ? "↑" : "↓"}</b>
        </button>
      ) : null}
    </section>
  );
}

function HoldingsTopPositionsPanel({
  analysis,
  weightView,
}: {
  analysis: HoldingsAnalysisResult;
  weightView: HoldingsWeightView;
}) {
  const positions = analysis.positions
    .filter((position) => weightView === "with-cash" || !position.isCash)
    .map((position) => ({
      ...position,
      displayWeight: holdingsPositionWeight(position, weightView),
    }))
    .sort((left, right) => right.displayWeight - left.displayWeight)
    .slice(0, 10);
  const largestWeight = Math.max(
    ...positions.map((position) => Math.abs(position.displayWeight)),
    1,
  );

  return (
    <article className="panel holdings-top-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Concentration</span>
          <h2>Largest holdings</h2>
        </div>
        <span className="info-chip">
          Top 10 · {weightView === "with-cash" ? "with cash" : "securities"}
        </span>
      </div>
      <div className={`holdings-top-list${analysis.portfolioValuation ? " holdings-top-list--valued" : ""}`}>
        {positions.map((position) => (
          <div key={position.securityId} className={position.displayWeight < 0 ? "is-negative" : undefined}>
            <div>
              <strong>{position.ticker}</strong>
              <span>{position.name}</span>
            </div>
            <div aria-hidden="true">
              <i
                style={{
                  width: `${(Math.abs(position.displayWeight) / largestWeight) * 100}%`,
                  background: position.displayWeight < 0 ? "var(--negative)" : undefined,
                }}
              />
            </div>
            <strong>
              {formatPercent(position.displayWeight, 2)}
              {analysis.portfolioValuation ? <span>{formatPortfolioUsd(portfolioPositionValueUsd(position.publishedWeight, analysis.portfolioValuation))}</span> : null}
            </strong>
          </div>
        ))}
      </div>
    </article>
  );
}

function HoldingsOverviewTable({
  analysis,
  weightView,
}: {
  analysis: HoldingsAnalysisResult;
  weightView: HoldingsWeightView;
}) {
  const [query, setQuery] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const viewKey = `${analysis.calculatedAt}:${weightView}:${analysis.positions.map((position) => position.securityId).join(",")}`;
  const rows = useMemo(
    () =>
      analysis.positions
        .filter(
          (position) => weightView === "with-cash" || !position.isCash,
        )
        .map((position) => ({
          ...position,
          displayWeight: holdingsPositionWeight(position, weightView),
        }))
        .sort((left, right) => right.displayWeight - left.displayWeight),
    [analysis.positions, weightView],
  );
  const isExpanded = expandedKey === viewKey;
  const matchingRows = rows.filter((position) => matchesHoldingSearch(position, query));
  const visibleRows = isExpanded
    ? matchingRows
    : matchingRows.filter((position, index) => index < INITIAL_VISIBLE_POSITIONS || position.isCash);
  const hasAdditionalRows = matchingRows.some(
    (position, index) => index >= INITIAL_VISIBLE_POSITIONS && !position.isCash,
  );

  return (
    <section className="panel holdings-position-table holdings-overview-table">
      <div className="panel-heading panel-heading--table">
        <div>
          <span className="eyebrow">Portfolio composition</span>
          <h2>{analysis.etf.ticker} holdings</h2>
        </div>
        <span className="info-chip">
          {weightView === "with-cash" ? "Portfolio normalized with cash" : "Securities normalized to 100%"}
        </span>
      </div>
      <HoldingsTableSearch
        query={query}
        onChange={setQuery}
        controls="holdings-overview-positions"
        count={matchingRows.length}
        total={rows.length}
      />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Security</th>
              <th>Weight</th>
              {analysis.portfolioValuation ? <th>Exposure (USD)</th> : null}
              <th>Sector</th>
              <th>Country</th>
              <th>Asset class</th>
            </tr>
          </thead>
          <tbody id="holdings-overview-positions">
            {matchingRows.length === 0 ? (
              <tr><td colSpan={analysis.portfolioValuation ? 6 : 5} className="holdings-table-empty">No holdings match your search.</td></tr>
            ) : null}
            {visibleRows.map((position) => (
              <tr
                key={position.securityId}
                className={[position.isCash ? "is-cash-position" : "", position.displayWeight < 0 ? "is-negative" : ""].filter(Boolean).join(" ")}
              >
                <td>
                  <div className="security-cell">
                    <span className="security-avatar">
                      {position.ticker.slice(0, 2)}
                    </span>
                    <div>
                      <strong className="security-ticker-with-premium"><span>{position.ticker}</span><AdrPremiumBadge security={position} /></strong>
                      <span>{position.name}</span>
                    </div>
                  </div>
                </td>
                <td className={position.displayWeight < 0 ? "negative-position-weight" : undefined}>{formatPercent(position.displayWeight, 2)}</td>
                {analysis.portfolioValuation ? <td>{formatPortfolioUsd(portfolioPositionValueUsd(position.publishedWeight, analysis.portfolioValuation))}</td> : null}
                <td>{position.isCash ? "Cash & equivalents" : position.sector}</td>
                <td>{position.country}</td>
                <td>{position.assetClass}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasAdditionalRows ? (
        <button
          type="button"
          className="position-table-toggle"
          aria-controls="holdings-overview-positions"
          aria-expanded={isExpanded}
          onClick={() => setExpandedKey(isExpanded ? null : viewKey)}
        >
          <span>
            {isExpanded
              ? `Show first ${INITIAL_VISIBLE_POSITIONS} holdings`
              : `Show all ${matchingRows.length} holdings`}
          </span>
          <small>
            {isExpanded
              ? `${matchingRows.length} holdings displayed`
              : `${visibleRows.length} of ${matchingRows.length} displayed`}
          </small>
          <b aria-hidden="true">{isExpanded ? "↑" : "↓"}</b>
        </button>
      ) : null}
    </section>
  );
}

function DataUnavailableState({
  leftEtf,
  rightEtf,
  hasError,
  unavailable,
}: {
  leftEtf?: EtfShareClass;
  rightEtf?: EtfShareClass;
  hasError: boolean;
  unavailable: string[];
}) {
  const selections = [leftEtf, rightEtf].filter(
    (etf): etf is EtfShareClass => Boolean(etf),
  );
  const isUnavailable = (etf: EtfShareClass) =>
    hasError && (unavailable.length === 0 || unavailable.includes(etf.id));

  return (
    <section className={`panel no-data-panel ${hasError ? "no-data-panel--error" : ""}`}>
      <div className="no-data-icon" aria-hidden="true">{hasError ? "!" : "↻"}</div>
      <div className="no-data-copy">
        <span className="eyebrow">
          {hasError ? "Source unavailable" : "On-demand data"}
        </span>
        <h2>
          {hasError
            ? "No substitute figures are shown."
            : "Load official holdings to begin."}
        </h2>
        <p>
          {hasError
            ? "The holdings deep dive remains empty until the required source data is available."
            : "Weightings Analytics loads official provider and index data, then caches each response for 24 hours."}
        </p>
      </div>
      <div className="availability-grid">
        {selections.map((etf) => (
          <div className="availability-card" key={etf.id}>
            <strong>{etf.ticker} · {wrapperLabel(etf)}</strong>
            <span>Holdings count</span>
            <b>{isUnavailable(etf) ? "Unavailable" : "Not loaded"}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ComparisonWorkbench({
  catalog, owner, siteMode, ownerOrigin, publicOrigin, catalogRevision,
}: ComparisonWorkbenchProps) {
  const [availableCatalog, setAvailableCatalog] = useState(catalog);
  const revision = useRef(catalogRevision);
  const [resultRevision, setResultRevision] = useState(catalogRevision);
  const [workspaceView, setWorkspaceView] = useState<
    "compare" | "portfolio" | "creator" | "metrics" | "ai"
  >("compare");
  const [leftEtfId, setLeftEtfId] = useState("ivv-us");
  const [rightEtfId, setRightEtfId] = useState("acwi-us");
  const [holdingsView, setHoldingsView] = useState<
    "holdings" | "distortion"
  >("holdings");
  const previousHoldingsView = useRef(holdingsView);
  const distortionDetailsLink = useRef<HTMLButtonElement>(null);
  const holdingsReturnLink = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (previousHoldingsView.current === holdingsView) return;
    (holdingsView === "distortion" ? holdingsReturnLink : distortionDetailsLink).current?.focus();
    previousHoldingsView.current = holdingsView;
  }, [holdingsView]);
  const [holdingsWeightView, setHoldingsWeightView] =
    useState<HoldingsWeightView>("securities");
  const [cashDisplay, setCashDisplay] = useState<HoldingsCashDisplay>("combined");
  const [comparisonMode, setComparisonMode] = useState(false);
  const [analysis, setAnalysis] = useState<HoldingsAnalysisResult | null>(null);
  const [rightAnalysis, setRightAnalysis] =
    useState<HoldingsAnalysisResult | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const researchCatalog = useMemo(
    () =>
      availableCatalog
        .map((group) => ({
          ...group,
          variants: group.variants.filter((etf) => !etf.holdingsSourceEtfId),
        }))
        .filter((group) => group.variants.length > 0),
    [availableCatalog],
  );
  const availableEtfs = useMemo(
    () => researchCatalog.flatMap((group) => group.variants),
    [researchCatalog],
  );
  const leftEtf = availableEtfs.find((etf) => etf.id === leftEtfId);
  const rightEtf = availableEtfs.find((etf) => etf.id === rightEtfId);
  const hasStaleHoldings = Boolean(analysis?.sourceIssues?.length || analysis?.sourceStatus === "stale" || (comparisonMode && (rightAnalysis?.sourceIssues?.length || rightAnalysis?.sourceStatus === "stale")) || comparison?.left.sourceStatus === "stale" || comparison?.right.sourceStatus === "stale");
  const holdingsDisplayAnalysis = useMemo(() => analysis ? {
    ...analysis,
    positions: holdingsCashDisplayPositions(analysis.positions, cashDisplay),
  } : null, [analysis, cashDisplay]);
  const holdingsDisplaySummary = useMemo(() => {
    if (!holdingsDisplayAnalysis) return null;
    return buildHoldingsDisplaySummary(holdingsDisplayAnalysis, holdingsWeightView);
  }, [holdingsDisplayAnalysis, holdingsWeightView]);
  const comparisonReady = Boolean(
    comparisonMode &&
      holdingsView === "holdings" &&
      comparison &&
      rightAnalysis,
  );

  const refreshCatalog = async () => {
    const response = await fetch("/api/v1/catalog", { cache: "no-store" });
    const payload = (await response.json()) as {
      data?: CatalogGroup[];
      error?: string;
    };
    if (!response.ok || !payload.data) {
      throw new Error(payload.error ?? "The ETF catalog could not be refreshed.");
    }
    setAvailableCatalog(payload.data);
  };

  useEffect(() => {
    const controller = new AbortController();
    const sync = async () => {
      try {
        const response = await fetch("/api/v1/catalog", { cache: "no-store", signal: controller.signal });
        if (response.status === 403 && owner) { window.location.assign(ownerOrigin); return; }
        if (!response.ok) return;
        const payload = await response.json();
        if (!payload.data || controller.signal.aborted) return;
        setAvailableCatalog(payload.data);
        if (payload.revision !== revision.current) {
          revision.current = payload.revision;
          setResultRevision(payload.revision);
          setAnalysis(null);
          setRightAnalysis(null);
          setComparison(null);
        }
      } catch { /* Keep the current view during a temporary network failure. */ }
    };
    const onFocus = () => { if (!document.hidden) void sync(); };
    const timer = setInterval(onFocus, 30_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    void sync();
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [owner, ownerOrigin]);

  const loadHoldingsAnalysis = async (forceRefresh = false, selectedPortfolioId?: string) => {
    const selectedId = selectedPortfolioId ?? leftEtfId;
    const startedRevision = revision.current;
    setLoading(true);
    setError(null);
    setUnavailable([]);
    setAnalysis(null);
    setRightAnalysis(null);
    setComparison(null);
    try {
      const analysisRequest = fetch(
        `/api/v1/holdings/${encodeURIComponent(selectedId)}/analysis${forceRefresh ? "?refresh=true" : ""}`,
        { cache: "no-cache" },
      );
      const comparisonRequest = !selectedPortfolioId && comparisonMode && holdingsView === "holdings"
        ? fetch(
            comparisonApiUrl(
              leftEtfId,
              rightEtfId,
              holdingsWeightView,
              forceRefresh,
            ),
            { cache: "no-cache" },
          )
        : null;
      const rightAnalysisRequest = comparisonRequest
        ? fetch(
            `/api/v1/holdings/${encodeURIComponent(rightEtfId)}/analysis${forceRefresh ? "?refresh=true" : ""}`,
            { cache: "no-cache" },
          )
        : null;
      const [analysisResponse, rightAnalysisResponse, comparisonResponse] = await Promise.all([
        analysisRequest,
        rightAnalysisRequest,
        comparisonRequest,
      ]);
      const analysisPayload = (await analysisResponse.json()) as {
        data?: HoldingsAnalysisResult;
        error?: string;
        unavailable?: string[];
      };
      if (!analysisResponse.ok || !analysisPayload.data) {
        setUnavailable(analysisPayload.unavailable ?? []);
        setError(
          analysisPayload.error ??
            "Holdings data is unavailable. No figures are shown.",
        );
        return;
      }
      if (startedRevision !== revision.current) return;
      setAnalysis(analysisPayload.data);

      if (comparisonResponse && rightAnalysisResponse) {
        const rightAnalysisPayload = (await rightAnalysisResponse.json()) as {
          data?: HoldingsAnalysisResult;
          error?: string;
          unavailable?: string[];
        };
        if (!rightAnalysisResponse.ok || !rightAnalysisPayload.data) {
          setUnavailable(rightAnalysisPayload.unavailable ?? [rightEtfId]);
          setError(
            rightAnalysisPayload.error ??
              `Holdings data is unavailable for ${rightEtf?.ticker ?? "the comparison ETF"}.`,
          );
          return;
        }
        if (startedRevision !== revision.current) return;
        setRightAnalysis(rightAnalysisPayload.data);
        const comparisonPayload = (await comparisonResponse.json()) as {
          data?: ComparisonResult;
          error?: string;
          unavailable?: string[];
        };
        if (!comparisonResponse.ok || !comparisonPayload.data) {
          setUnavailable(comparisonPayload.unavailable ?? []);
          setError(
            `The ${leftEtf?.ticker ?? "primary ETF"} deep dive loaded, but the optional comparison is unavailable. ${comparisonPayload.error ?? ""}`.trim(),
          );
        } else {
          if (startedRevision !== revision.current) return;
          setComparison(comparisonPayload.data);
        }
      }
    } catch (requestError) {
      setUnavailable(
        comparisonMode ? [leftEtfId, rightEtfId] : [leftEtfId],
      );
      setError(
        requestError instanceof Error
          ? requestError.message
          : "An unexpected error occurred.",
      );
    } finally {
      setLoading(false);
    }
  };

  const changeHoldingsWeightView = async (next: HoldingsWeightView) => {
    const startedRevision = revision.current;
    if (next === holdingsWeightView) return;
    if (
      !comparisonMode ||
      holdingsView !== "holdings" ||
      !analysis ||
      !rightAnalysis ||
      !comparison
    ) {
      setHoldingsWeightView(next);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        comparisonApiUrl(leftEtfId, rightEtfId, next),
        { cache: "no-cache" },
      );
      const payload = (await response.json()) as {
        data?: ComparisonResult;
        error?: string;
        unavailable?: string[];
      };
      if (!response.ok || !payload.data) {
        setUnavailable(payload.unavailable ?? []);
        setError(
          payload.error ?? "The comparison could not be recalculated.",
        );
        return;
      }
      if (startedRevision !== revision.current) return;
      setComparison(payload.data);
      setHoldingsWeightView(next);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The comparison could not be recalculated.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>Weightings Analytics</span>
        </div>
        <ThemeToggle mobile />
        <nav className="main-nav" aria-label="Primary navigation">
          <button
            className={`nav-item${workspaceView === "compare" ? " nav-item--active" : ""}`}
            type="button"
            aria-pressed={workspaceView === "compare"}
            onClick={() => setWorkspaceView("compare")}
          >
            <span className="nav-icon">◎</span>
            Holdings
          </button>
          <button
            className={`nav-item${workspaceView === "portfolio" ? " nav-item--active" : ""}`}
            type="button"
            aria-pressed={workspaceView === "portfolio"}
            onClick={() => setWorkspaceView("portfolio")}
          >
            <span className="nav-icon">Σ</span>
            Portfolio
          </button>
          {owner ? <button
            className={`nav-item${workspaceView === "creator" ? " nav-item--active" : ""}`}
            type="button"
            aria-pressed={workspaceView === "creator"}
            onClick={() => setWorkspaceView("creator")}
          >
            <span className="nav-icon">+</span>
            ETF Creator
          </button> : null}
          <button
            className={`nav-item${workspaceView === "metrics" ? " nav-item--active" : ""}`}
            type="button"
            aria-pressed={workspaceView === "metrics"}
            onClick={() => setWorkspaceView("metrics")}
          >
            <span className="nav-icon">⌗</span>
            Metrics
          </button>
          {owner ? <button className={`nav-item${workspaceView === "ai" ? " nav-item--active" : ""}`} type="button" aria-pressed={workspaceView === "ai"} onClick={() => setWorkspaceView("ai")}><span className="nav-icon">✦</span>AI analysis</button> : null}
        </nav>
        <div className="sidebar-card">
          <span className="live-pulse" />
          <strong>Official sources</strong>
          <p>Official holdings persisted locally and refreshed every 24 hours.</p>
        </div>
        {siteMode === "web" && <div className="site-access-links">
          {owner ? <><a href={publicOrigin}>Public website</a><a href="/cdn-cgi/access/logout">Sign out</a></> : <a href={ownerOrigin}>Owner sign in</a>}
        </div>}
        <div className="sidebar-footer">
          <span>JL</span>
          <div>
            <strong>Research workspace</strong>
            <small>Version 0.1</small>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            Analysis <span>/</span>{" "}
            {workspaceView === "compare"
              ? "Holdings deep dive"
              : workspaceView === "portfolio"
                ? "Portfolio"
                : workspaceView === "creator"
                  ? "ETF Creator"
                  : workspaceView === "ai" ? "AI analysis" : "Metrics overview"}
          </div>
          <div className="topbar-actions">
            <span
              className={`source-badge ${
                workspaceView === "portfolio" || workspaceView === "creator" || workspaceView === "ai"
                  ? ""
                  : workspaceView === "metrics"
                    ? ""
                  : error || hasStaleHoldings
                    ? "source-badge--error"
                    : analysis
                      ? ""
                      : "source-badge--idle"
              }`}
            >
              <i />
              {workspaceView === "ai" ? "Codex research" : workspaceView === "portfolio"
                ? owner ? "Local portfolio" : "Published portfolios"
                : workspaceView === "creator"
                  ? "Selected ETF universe"
                : workspaceView === "metrics"
                  ? "TradingView"
                : error
                  ? "Unavailable"
                  : hasStaleHoldings
                    ? "Stale data"
                    : analysis
                    ? analysis.sourceStatus === "cached" ? "Cached data" : "Live data"
                    : "Not loaded"}
            </span>
            <ThemeToggle />
          </div>
        </header>

        <div className="workspace">
          <div className="mobile-workspace-switch" aria-label="Analysis module">
            <button
              type="button"
              className={workspaceView === "compare" ? "is-active" : ""}
              onClick={() => setWorkspaceView("compare")}
            >
              Holdings
            </button>
            <button
              type="button"
              className={workspaceView === "portfolio" ? "is-active" : ""}
              onClick={() => setWorkspaceView("portfolio")}
            >
              Portfolio
            </button>
            {owner ? <button
              type="button"
              className={workspaceView === "creator" ? "is-active" : ""}
              onClick={() => setWorkspaceView("creator")}
            >
              ETF Creator
            </button> : null}
            <button
              type="button"
              className={workspaceView === "metrics" ? "is-active" : ""}
              onClick={() => setWorkspaceView("metrics")}
            >
              Metrics
            </button>
            {owner ? <button type="button" className={workspaceView === "ai" ? "is-active" : ""} onClick={() => setWorkspaceView("ai")}>AI analysis</button> : null}
          </div>
          {workspaceView === "compare" ? (
            <div className="holdings-overview">
              <section className="metrics-hero holdings-hero panel">
                <div>
                  <span className="eyebrow">Constituent structure</span>
                  <h1>Holdings deep dive</h1>
                  <p>
                    Explore concentration, sectors and security-level weights for
                    one ETF. Add a peer only when a side-by-side comparison is useful.
                  </p>
                </div>
                <div className="panel-refresh-actions">
                  <div className="metrics-provider-mark">
                    <span>DATA</span>
                    <div>
                      <strong>Official holdings</strong>
                      <small>Fund and index providers · daily cache</small>
                    </div>
                  </div>
                  <ManualRefreshButton
                    loading={loading}
                    onRefresh={() => void loadHoldingsAnalysis(true)}
                  />
                </div>
              </section>

              <section
                className={`comparison-builder holdings-builder${comparisonMode && holdingsView === "holdings" ? "" : " holdings-builder--single"}`}
                id="holdings"
              >
                <FundSelector
                  side="left"
                  label="ETF to analyze"
                  etfId={leftEtfId}
                  catalog={researchCatalog}
                  onEtfChange={(_, value) => {
                    setLeftEtfId(value);
                    setHoldingsView("holdings");
                    setAnalysis(null);
                    setRightAnalysis(null);
                    setComparison(null);
                    setError(null);
                  }}
                />
                {comparisonMode && holdingsView === "holdings" ? (
                  <>
                    <div className="versus" aria-hidden="true"><span>VS</span></div>
                    <FundSelector
                      side="right"
                      label="Optional comparison ETF"
                      etfId={rightEtfId}
                      catalog={researchCatalog}
                      onEtfChange={(_, value) => {
                        setRightEtfId(value);
                        setRightAnalysis(null);
                        setComparison(null);
                        setError(null);
                      }}
                    />
                  </>
                ) : null}
                <div className="builder-action holdings-builder-action">
                  <small>
                    {analysis
                      ? `${analysis.etf.ticker} as of ${formatDate(analysis.asOf)} · ${analysis.cacheTtlHours}h cache`
                      : "Official fund and index holdings · 24h cache"}
                  </small>
                  {holdingsView === "holdings" ? (
                    <button
                      className="secondary-button holdings-compare-toggle"
                      type="button"
                      aria-pressed={comparisonMode}
                      onClick={() => {
                        setComparisonMode((current) => !current);
                        setRightAnalysis(null);
                        setComparison(null);
                        setError(null);
                      }}
                    >
                      {comparisonMode ? "Remove comparison" : "+ Compare another ETF"}
                    </button>
                  ) : null}
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void loadHoldingsAnalysis()}
                    disabled={loading}
                  >
                    {loading ? <span className="spinner" /> : <span>Analyze holdings</span>}
                    {!loading && <b aria-hidden="true">→</b>}
                  </button>
                </div>
              </section>

              {error && <div className="alert alert--error">{error}</div>}
              {analysis?.portfolioValuation ? <PortfolioValuationPanel ticker={analysis.etf.ticker} valuation={analysis.portfolioValuation} /> : null}
              {comparisonMode && rightAnalysis?.portfolioValuation ? <PortfolioValuationPanel ticker={rightAnalysis.etf.ticker} valuation={rightAnalysis.portfolioValuation} /> : null}
              <HoldingsSourceWarning issues={[...(analysis?.sourceIssues ?? []), ...(comparisonMode ? rightAnalysis?.sourceIssues ?? [] : []), ...(comparison?.left.sourceIssues ?? []), ...(comparison?.right.sourceIssues ?? [])]} />

              {analysis ? (
                <>
                  {holdingsView === "holdings" ? (
                    <div
                      id="holdings-overview-panel"
                      role="region"
                      aria-label="Holdings"
                      className="holdings-subview"
                    >
                      <section className="holdings-summary" aria-label="Holdings overview metrics">
                        <section className="panel holdings-summary-group" aria-labelledby="holdings-structure-title">
                          <h2 id="holdings-structure-title">Breadth & concentration</h2>
                          <div className="holdings-summary-metrics">
                            <MetricCard
                              label="Holdings universe"
                              value={comparisonReady && comparison
                                ? <ComparisonPair left={comparison.left.holdingsCount} right={comparison.right.holdingsCount} />
                                : `${analysis.holdingsCount}`}
                              detail={comparisonReady && comparison
                                ? <><ComparisonPair left={comparisonFundLabel(comparison, "left")} right={comparisonFundLabel(comparison, "right")} /> · {holdingsWeightView === "with-cash" ? "cash included" : "cash excluded"}</>
                                : `${analysis.equityHoldingsCount} equity · ${analysis.cashHoldingsCount} cash-like`}
                            />
                            <MetricCard
                              label="Top 10 concentration"
                              value={comparisonReady && comparison
                                ? <ComparisonPair left={formatPercent(comparison.left.top10Concentration, 1)} right={formatPercent(comparison.right.top10Concentration, 1)} />
                                : formatPercent(holdingsDisplaySummary?.top10Concentration ?? 0, 1)}
                              detail={comparisonReady
                                ? <><ComparisonPair left={comparison ? comparisonFundLabel(comparison, "left") : "ETF A"} right={comparison ? comparisonFundLabel(comparison, "right") : "ETF B"} /> · {holdingsWeightView === "with-cash" ? "cash included" : "cash excluded"}</>
                                : "Weight in the ten largest positions"}
                            />
                          </div>
                        </section>
                        <section className="panel holdings-summary-group" aria-labelledby="holdings-positioning-title">
                          <div className="holdings-summary-heading">
                            <h2 id="holdings-positioning-title">Positioning vs ACWI</h2>
                            <button ref={distortionDetailsLink} type="button" className="holdings-summary-details" onClick={() => setHoldingsView("distortion")} aria-label="Open distortion and market coverage details">Details <span aria-hidden="true">↗</span></button>
                          </div>
                          <div className="holdings-summary-metrics">
                            <MetricCard
                              label="Weight distortion index"
                              value={comparisonReady && rightAnalysis
                                ? <ComparisonPair
                                    left={analysis.distortion.score === null ? "—" : analysis.distortion.score.toFixed(1)}
                                    right={rightAnalysis.distortion.score === null ? "—" : rightAnalysis.distortion.score.toFixed(1)}
                                  />
                                : analysis.distortion.score === null ? "—" : analysis.distortion.score.toFixed(1)}
                              detail={comparisonReady && rightAnalysis
                                ? <ComparisonPair left={analysis.etf.ticker} right={rightAnalysis.etf.ticker} />
                                : `Top ${analysis.distortion.topCount} equity positions · ACWI free-float weights`}
                            />
                            <MetricCard
                              label="Market Coverage"
                              value={comparisonReady && rightAnalysis
                                ? <ComparisonPair left={analysis.marketCoverage.score === null ? "—" : analysis.marketCoverage.score.toFixed(1)} right={rightAnalysis.marketCoverage.score === null ? "—" : rightAnalysis.marketCoverage.score.toFixed(1)} />
                                : analysis.marketCoverage.score === null ? "—" : analysis.marketCoverage.score.toFixed(1)}
                              detail={comparisonReady && rightAnalysis ? <ComparisonPair left={analysis.etf.ticker} right={rightAnalysis.etf.ticker} /> : "Full ACWI universe · 0 to 100"}
                            />
                          </div>
                        </section>
                        <section className="panel holdings-summary-group holdings-summary-group--cash" aria-labelledby="holdings-cash-title">
                          <div className="holdings-summary-heading">
                            <h2 id="holdings-cash-title">Cash & liquidity</h2>
                            <button type="button" className="holdings-cash-toggle" role="switch" aria-checked={holdingsWeightView === "with-cash"} disabled={loading} onClick={() => void changeHoldingsWeightView(holdingsWeightView === "with-cash" ? "securities" : "with-cash")}>
                              Include cash <span className="holdings-cash-toggle-track" aria-hidden="true" />
                            </button>
                          </div>
                          <MetricCard
                            label={<span className="holdings-cash-metric-label">
                              <span>Cash & equivalents</span>
                              {holdingsWeightView === "with-cash" && !comparisonReady ? (
                                <select className="holdings-cash-grouping" aria-label="Cash grouping" value={cashDisplay} onChange={(event) => setCashDisplay(event.target.value as HoldingsCashDisplay)}>
                                  <option value="combined">Combined</option>
                                  <option value="positions">Separate</option>
                                </select>
                              ) : null}
                            </span>}
                            value={comparisonReady && rightAnalysis
                              ? <ComparisonPair left={formatPercent(analysis.cashWeight, 2)} right={formatPercent(rightAnalysis.cashWeight, 2)} />
                              : formatPercent(analysis.cashWeight, 2)}
                            detail={comparisonReady && rightAnalysis
                              ? <><ComparisonPair left={analysis.etf.ticker} right={rightAnalysis.etf.ticker} /> · {holdingsWeightView === "with-cash" ? "included in comparison" : "excluded from comparison"}</>
                              : `${analysis.cashHoldingsCount} source position${analysis.cashHoldingsCount === 1 ? "" : "s"} · ${holdingsWeightView === "with-cash" ? "included in view" : "excluded from view"}`}
                          />
                        </section>
                      </section>
                      {!comparisonReady ? (
                        <>
                          <section className="analysis-grid holdings-analysis-grid">
                            <HoldingsTopPositionsPanel analysis={holdingsDisplayAnalysis ?? analysis} weightView={holdingsWeightView} />
                            <HoldingsSectorPanel analysis={holdingsDisplayAnalysis ?? analysis} weightView={holdingsWeightView} />
                            <HoldingsGeographyPanel
                              key={analysis.etf.id}
                              analysis={holdingsDisplayAnalysis ?? analysis}
                              weightView={holdingsWeightView}
                            />
                          </section>
                          <div className="holdings-detail-columns">
                            <HoldingsOverviewTable analysis={holdingsDisplayAnalysis ?? analysis} weightView={holdingsWeightView} />
                            <aside className="portfolio-events-sidebar" aria-label="Earnings calendar sidebar">
                              <PortfolioEvents key={analysis.etf.id} holdings={analysis} />
                            </aside>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      id="distortion-details-panel"
                      role="region"
                      aria-label="Distortion details"
                      className="holdings-subview"
                    >
                      <button ref={holdingsReturnLink} type="button" className="holdings-summary-details holdings-details-back" onClick={() => setHoldingsView("holdings")}>
                        <span aria-hidden="true">←</span> Back to holdings
                      </button>
                      <HoldingsDistortionDetails key={analysis.etf.id} analysis={analysis} />
                    </div>
                  )}
                </>
              ) : !loading ? (
                <DataUnavailableState
                  leftEtf={leftEtf}
                  rightEtf={comparisonMode ? rightEtf : undefined}
                  hasError={Boolean(error)}
                  unavailable={unavailable}
                />
              ) : (
                <section className="metrics-loading panel">
                  <span className="spinner" />
                  <strong>Loading holdings analysis…</strong>
                </section>
              )}

              {comparison && comparisonMode && holdingsView === "holdings" ? (
                <section className="holdings-comparison-section">
                  <div className="holdings-comparison-heading panel">
                    <div>
                      <span className="eyebrow comparison-eyebrow">Optional peer analysis</span>
                      <h2>
                        <span className="fund-color--left">{comparisonFundLabel(comparison, "left")}</span>{" "}
                        <i>vs</i>{" "}
                        <span className="fund-color--right">{comparisonFundLabel(comparison, "right")}</span>
                      </h2>
                      <p>
                        Relative overlap, active sleeves and sector differences use weights normalized to 100%. Cash is {holdingsWeightView === "with-cash" ? "included because Include cash is selected" : "excluded because Securities only is selected"}.
                      </p>
                    </div>
                  </div>
                  {([comparison.left, comparison.right] as const).map((side) =>
                    side.constituentCoverage ? (
                      <div className="alert" key={side.etf.id}>
                        {normalizationMessage(side.etf.ticker, side.constituentCoverage)}
                      </div>
                    ) : null,
                  )}
                  <section className="metric-grid" aria-label="Optional comparison metrics">
                    <MetricCard
                      label="Weighted overlap"
                      value={<span className="fund-color--overlap">{formatPercent(comparison.overlapWeight)}</span>}
                      detail={`${comparison.sharedPositionsCount} shared securities`}
                      tone="positive"
                    />
                    <MetricCard
                      label={<><span className="fund-color--left">{comparisonFundLabel(comparison, "left")}</span> active sleeve</>}
                      value={<span className="fund-color--left">{formatPercent(comparison.leftActiveWeight)}</span>}
                      detail={`Top 10 = ${formatPercent(comparison.left.top10Concentration)}`}
                      tone="left"
                    />
                    <MetricCard
                      label={<><span className="fund-color--right">{comparisonFundLabel(comparison, "right")}</span> active sleeve</>}
                      value={<span className="fund-color--right">{formatPercent(comparison.rightActiveWeight)}</span>}
                      detail={`Top 10 = ${formatPercent(comparison.right.top10Concentration)}`}
                      tone="right"
                    />
                    <MetricCard
                      label="Holdings universe"
                      value={<ComparisonPair left={comparison.left.holdingsCount} right={comparison.right.holdingsCount} />}
                      detail="positions in each ETF"
                    />
                  </section>
                  <section className="analysis-grid">
                    <article className="panel overlap-panel">
                      <div className="panel-heading">
                        <div>
                          <span className="eyebrow">Sleeve decomposition</span>
                          <h2>
                            <span className="fund-color--overlap">Overlap</span>{" "}
                            vs{" "}
                            <span className="comparison-active-label">active</span>
                          </h2>
                        </div>
                        <span className="info-chip">Normalised weights</span>
                      </div>
                      <div className="overlap-layout">
                        <OverlapDonut comparison={comparison} />
                        <div className="overlap-copy">
                          <strong>{comparison.overlapWeight >= 75 ? "Closely aligned exposures" : comparison.overlapWeight >= 45 ? "Material shared core" : "Distinct exposure profiles"}</strong>
                          <p>Overlap is the sum of the lower weight for every shared security. Each portfolio&apos;s residual weight forms its active sleeve.</p>
                          <SleeveBars comparison={comparison} />
                        </div>
                      </div>
                    </article>
                    <article className="panel sector-panel">
                      <div className="panel-heading">
                        <div><span className="eyebrow">Allocation</span><h2>Sector comparison</h2></div>
                        <div className="mini-legend">
                          <span className="fund-color--left"><i style={{ background: COLORS.left }} />{comparisonFundLabel(comparison, "left")}</span>
                          <span className="fund-color--right"><i style={{ background: COLORS.right }} />{comparisonFundLabel(comparison, "right")}</span>
                        </div>
                      </div>
                      <SectorChart comparison={comparison} />
                    </article>
                  </section>
                  <ImplicitSleevesPanel comparison={comparison} />
                  <PositionTable comparison={comparison} />
                </section>
              ) : null}
            </div>
          ) : workspaceView === "portfolio" ? owner ? (
            <PortfolioAnalytics
              catalog={availableCatalog}
              publicationEnabled={siteMode === "web"}
              onCatalogChanged={refreshCatalog}
            />
          ) : (
            <PortfolioOverview
              owner={false}
              portfolios={availableCatalog.flatMap((group) => group.variants).filter((etf) => etf.fundType === "portfolio")}
              onSelect={(id) => { setLeftEtfId(id); setComparisonMode(false); setHoldingsView("holdings"); setWorkspaceView("compare"); void loadHoldingsAnalysis(false, id); }}
            />
          ) : workspaceView === "creator" && owner ? (
            <EtfCreator
              catalog={researchCatalog}
              publicationEnabled={siteMode === "web"}
              onCatalogChanged={refreshCatalog}
            />
          ) : workspaceView === "metrics" ? (
            <MetricsOverview
              key={resultRevision}
              catalog={researchCatalog}
              initialEtfIds={[leftEtfId, rightEtfId]}
            />
          ) : null}

          {owner && workspaceView === "ai" ? <AiAnalysisPanel catalog={availableCatalog} initialEtfId={leftEtfId} /> : null}

          {siteMode === "web" && owner && (workspaceView === "compare" || workspaceView === "metrics") && <PublicationManager catalog={availableCatalog} onChanged={refreshCatalog} />}
          <footer className="disclaimer">
            <span>Weightings Analytics</span>
            Indicative data sourced from fund and index providers. Holdings may
            change without notice. Fundamental metrics are sourced from TradingView.
            This is not investment advice.
          </footer>
        </div>
      </main>
    </div>
  );
}
