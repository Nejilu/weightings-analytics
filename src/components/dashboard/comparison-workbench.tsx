"use client";

import { useMemo, useState, type ReactNode } from "react";
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

import { PortfolioAnalytics } from "@/components/dashboard/portfolio-analytics";
import { EtfCreator } from "@/components/dashboard/etf-creator";
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
} from "@/domain/holdings-analysis";
import {
  countryToContinent,
  geographicCountryLabel,
} from "@/domain/geography";
import { EtfSearch } from "./etf-search";

const MetricsOverview = dynamic(
  () => import("@/components/dashboard/metrics-overview").then((module) => module.MetricsOverview),
  {
    ssr: false,
    loading: () => <section className="metrics-loading panel"><span className="spinner" /><strong>Loading metrics workspace…</strong></section>,
  },
);

interface ComparisonWorkbenchProps {
  catalog: CatalogGroup[];
}

type SelectionSide = "left" | "right";
type HoldingsWeightView = "securities" | "with-cash";
type GeographyGrouping = "country" | "continent";

const INITIAL_VISIBLE_POSITIONS = 50;

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
    localStorage.setItem("indexlens-theme", nextTheme);
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

function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: ReactNode;
  value: ReactNode;
  detail: ReactNode;
  tone?: "neutral" | "positive" | "left" | "right";
}) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__label">{label}</div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
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
  const visibleRows = isExpanded
    ? rows
    : rows.slice(0, INITIAL_VISIBLE_POSITIONS);
  const hasAdditionalRows = rows.length > INITIAL_VISIBLE_POSITIONS;

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
              : `Show all ${rows.length} positions`}
          </span>
          <small>
            {isExpanded
              ? `${rows.length} positions displayed`
              : `${INITIAL_VISIBLE_POSITIONS} of ${rows.length} displayed`}
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
            <strong>{position.ticker}</strong>
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
  if (score < 2) return "Closely aligned with free float";
  if (score < 10) return "Limited weighting distortion";
  if (score < 25) return "Material weighting distortion";
  return "High weighting distortion";
}

function signedPercent(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function HoldingsDistortionPanel({
  analysis,
}: {
  analysis: HoldingsAnalysisResult;
}) {
  const contributors = analysis.positions
    .filter(
      (position): position is HoldingsAnalysisPosition & {
        actualWeight: number;
        counterfactualWeight: number;
        weightDelta: number;
        distortionContribution: number;
      } => position.distortionStatus === "covered",
    )
    .slice(0, 8);
  const largestContribution = Math.max(
    ...contributors.map((position) => position.distortionContribution),
    0,
  );

  return (
    <article className="panel holdings-distortion-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">ACWI free-float counterfactual</span>
          <h2>Where the weighting departs from free float</h2>
        </div>
        <span className="info-chip">
          {distortionReading(analysis.distortion.score)}
        </span>
      </div>
      <p className="holdings-method-copy">
        The index is the minimum share of portfolio weight that would need to be
        reallocated to match ACWI-implied free-float weights across the same
        covered securities. A score of 0 is aligned; 100 is the theoretical
        maximum.
      </p>
      <div className="distortion-contributors">
        {contributors.map((position) => (
          <div className="distortion-row" key={position.securityId}>
            <div className="distortion-row__identity">
              <strong>{position.ticker}</strong>
              <span>{position.name}</span>
            </div>
            <div className="distortion-row__bar" aria-hidden="true">
              <span
                className={position.weightDelta >= 0 ? "is-over" : "is-under"}
                style={{
                  width: `${largestContribution > 0 ? (position.distortionContribution / largestContribution) * 100 : 0}%`,
                }}
              />
            </div>
            <strong className={position.weightDelta >= 0 ? "is-over" : "is-under"}>
              {signedPercent(position.weightDelta)}
            </strong>
            <small>{position.distortionContribution.toFixed(2)} pts</small>
          </div>
        ))}
      </div>
      <div className="holdings-method-note">
        <span>
          Coverage {analysis.distortion.coverageWeight.toFixed(1)}% · {analysis.distortion.coveredHoldings}/
          {analysis.distortion.eligibleHoldings} equity holdings
        </span>
        <span>
          ACWI as of {formatDate(analysis.distortion.referenceAsOf)} · score
          computed on the covered universe and renormalized to 100%
        </span>
      </div>
    </article>
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
    for (const position of analysis.positions) {
      if (weightView === "securities" && position.isCash) continue;
      const sector = position.isCash
        ? "Cash & equivalents"
        : position.sector || "Unclassified";
      weights.set(
        sector,
        (weights.get(sector) ?? 0) +
          holdingsPositionWeight(position, weightView),
      );
    }
    return [...weights.entries()]
      .map(([sector, weight]) => ({ sector, weight }))
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 9);
  }, [analysis.positions, weightView]);
  const largestWeight = Math.max(...sectors.map((sector) => sector.weight), 1);
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
          <div key={sector.sector}>
            <span>{sector.sector}</span>
            <div aria-hidden="true">
              <i style={{ width: `${(sector.weight / largestWeight) * 100}%` }} />
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
    for (const position of analysis.positions) {
      if (weightView === "securities" && position.isCash) continue;
      const geography = position.isCash
        ? "Cash & equivalents"
        : grouping === "country"
          ? geographicCountryLabel(position.country)
          : countryToContinent(position.country);
      weights.set(
        geography,
        (weights.get(geography) ?? 0) +
          holdingsPositionWeight(position, weightView),
      );
    }
    return [...weights.entries()]
      .map(([geography, weight]) => ({ geography, weight }))
      .sort((left, right) => right.weight - left.weight)
      .slice(0, grouping === "country" ? 9 : undefined);
  }, [analysis.positions, grouping, weightView]);
  const largestWeight = Math.max(
    ...allocations.map((allocation) => allocation.weight),
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
          <div key={allocation.geography}>
            <span>{allocation.geography}</span>
            <div aria-hidden="true">
              <i
                style={{
                  width: `${(allocation.weight / largestWeight) * 100}%`,
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
  const [ranking, setRanking] = useState<"distortion" | "weight">("distortion");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const viewKey = `${analysis.calculatedAt}:${ranking}`;
  const rows = useMemo(
    () =>
      [...analysis.positions].sort((left, right) =>
        ranking === "weight"
          ? right.publishedWeight - left.publishedWeight
          : (right.distortionContribution ?? -1) -
            (left.distortionContribution ?? -1),
      ),
    [analysis.positions, ranking],
  );
  const isExpanded = expandedKey === viewKey;
  const visibleRows = isExpanded
    ? rows
    : rows.slice(0, INITIAL_VISIBLE_POSITIONS);
  const hasAdditionalRows = rows.length > INITIAL_VISIBLE_POSITIONS;

  return (
    <section className="panel holdings-position-table">
      <div className="panel-heading panel-heading--table">
        <div>
          <span className="eyebrow">Security-level analysis</span>
          <h2>{analysis.etf.ticker} holdings and counterfactual weights</h2>
        </div>
        <div className="segmented-control" aria-label="Rank holdings">
          <button
            type="button"
            className={ranking === "distortion" ? "is-active" : ""}
            aria-pressed={ranking === "distortion"}
            onClick={() => setRanking("distortion")}
          >
            Distortion
          </button>
          <button
            type="button"
            className={ranking === "weight" ? "is-active" : ""}
            aria-pressed={ranking === "weight"}
            onClick={() => setRanking("weight")}
          >
            ETF weight
          </button>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Security</th>
              <th>Published weight</th>
              <th>Covered ETF weight</th>
              <th>ACWI-implied weight</th>
              <th>Delta</th>
              <th>Score contribution</th>
            </tr>
          </thead>
          <tbody id="holdings-analysis-positions">
            {visibleRows.map((position) => (
              <tr key={position.securityId}>
                <td>
                  <div className="security-cell">
                    <span className="security-avatar">{position.ticker.slice(0, 2)}</span>
                    <div>
                      <strong>{position.ticker}</strong>
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
                      {position.distortionStatus === "non-equity" ? "Non-equity" : "Not in ACWI"}
                    </span>
                  ) : (
                    <span className={position.weightDelta >= 0 ? "distortion-over" : "distortion-under"}>
                      {signedPercent(position.weightDelta)}
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
              : `Show all ${rows.length} holdings`}
          </span>
          <small>
            {isExpanded
              ? `${rows.length} holdings displayed`
              : `${INITIAL_VISIBLE_POSITIONS} of ${rows.length} displayed`}
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
    ...positions.map((position) => position.displayWeight),
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
      <div className="holdings-top-list">
        {positions.map((position) => (
          <div key={position.securityId}>
            <div>
              <strong>{position.ticker}</strong>
              <span>{position.name}</span>
            </div>
            <div aria-hidden="true">
              <i
                style={{
                  width: `${(position.displayWeight / largestWeight) * 100}%`,
                }}
              />
            </div>
            <strong>{formatPercent(position.displayWeight, 2)}</strong>
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
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const viewKey = `${analysis.calculatedAt}:${weightView}`;
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
  const visibleRows = isExpanded
    ? rows
    : rows.slice(0, INITIAL_VISIBLE_POSITIONS);
  const hasAdditionalRows = rows.length > INITIAL_VISIBLE_POSITIONS;

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
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Security</th>
              <th>Weight</th>
              <th>Sector</th>
              <th>Country</th>
              <th>Asset class</th>
            </tr>
          </thead>
          <tbody id="holdings-overview-positions">
            {visibleRows.map((position) => (
              <tr
                key={position.securityId}
                className={position.isCash ? "is-cash-position" : undefined}
              >
                <td>
                  <div className="security-cell">
                    <span className="security-avatar">
                      {position.ticker.slice(0, 2)}
                    </span>
                    <div>
                      <strong>{position.ticker}</strong>
                      <span>{position.name}</span>
                    </div>
                  </div>
                </td>
                <td>{formatPercent(position.displayWeight, 2)}</td>
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
              : `Show all ${rows.length} holdings`}
          </span>
          <small>
            {isExpanded
              ? `${rows.length} holdings displayed`
              : `${INITIAL_VISIBLE_POSITIONS} of ${rows.length} displayed`}
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
            : "IndexLens loads official provider and index data, then caches each response for 24 hours."}
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
  catalog,
}: ComparisonWorkbenchProps) {
  const [availableCatalog, setAvailableCatalog] = useState(catalog);
  const [workspaceView, setWorkspaceView] = useState<
    "compare" | "portfolio" | "creator" | "metrics"
  >("compare");
  const [leftEtfId, setLeftEtfId] = useState("ivv-us");
  const [rightEtfId, setRightEtfId] = useState("acwi-us");
  const [holdingsView, setHoldingsView] = useState<
    "holdings" | "distortion"
  >("holdings");
  const [holdingsWeightView, setHoldingsWeightView] =
    useState<HoldingsWeightView>("securities");
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
  const holdingsDisplaySummary = useMemo(() => {
    if (!analysis) return null;
    return buildHoldingsDisplaySummary(analysis, holdingsWeightView);
  }, [analysis, holdingsWeightView]);
  const leftComparisonSummary = useMemo(
    () => analysis
      ? buildHoldingsDisplaySummary(analysis, holdingsWeightView)
      : null,
    [analysis, holdingsWeightView],
  );
  const rightComparisonSummary = useMemo(
    () => rightAnalysis
      ? buildHoldingsDisplaySummary(rightAnalysis, holdingsWeightView)
      : null,
    [holdingsWeightView, rightAnalysis],
  );
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

  const loadHoldingsAnalysis = async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    setUnavailable([]);
    setAnalysis(null);
    setRightAnalysis(null);
    setComparison(null);
    try {
      const analysisRequest = fetch(
        `/api/v1/holdings/${encodeURIComponent(leftEtfId)}/analysis${forceRefresh ? "?refresh=true" : ""}`,
        { cache: "no-cache" },
      );
      const comparisonRequest = comparisonMode && holdingsView === "holdings"
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
          <span>IndexLens</span>
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
          <button
            className={`nav-item${workspaceView === "creator" ? " nav-item--active" : ""}`}
            type="button"
            aria-pressed={workspaceView === "creator"}
            onClick={() => setWorkspaceView("creator")}
          >
            <span className="nav-icon">+</span>
            ETF Creator
          </button>
          <button
            className={`nav-item${workspaceView === "metrics" ? " nav-item--active" : ""}`}
            type="button"
            aria-pressed={workspaceView === "metrics"}
            onClick={() => setWorkspaceView("metrics")}
          >
            <span className="nav-icon">⌗</span>
            Metrics
          </button>
        </nav>
        <div className="sidebar-card">
          <span className="live-pulse" />
          <strong>Official sources</strong>
          <p>Official holdings persisted locally and refreshed every 24 hours.</p>
        </div>
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
                ? "Portfolio analytics"
                : workspaceView === "creator"
                  ? "ETF Creator"
                  : "Metrics overview"}
          </div>
          <div className="topbar-actions">
            <span
              className={`source-badge ${
                workspaceView === "portfolio" || workspaceView === "creator"
                  ? ""
                  : workspaceView === "metrics"
                    ? ""
                  : error
                    ? "source-badge--error"
                    : analysis
                      ? ""
                      : "source-badge--idle"
              }`}
            >
              <i />
              {workspaceView === "portfolio"
                ? "Local portfolio"
                : workspaceView === "creator"
                  ? "Selected ETF universe"
                : workspaceView === "metrics"
                  ? "TradingView"
                : error
                  ? "Unavailable"
                  : analysis
                    ? "Live data"
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
            <button
              type="button"
              className={workspaceView === "creator" ? "is-active" : ""}
              onClick={() => setWorkspaceView("creator")}
            >
              ETF Creator
            </button>
            <button
              type="button"
              className={workspaceView === "metrics" ? "is-active" : ""}
              onClick={() => setWorkspaceView("metrics")}
            >
              Metrics
            </button>
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

              {analysis ? (
                <>
                  <section className="holdings-view-switch panel">
                    <div>
                      <span className="eyebrow">Analysis view</span>
                      <strong>
                        {holdingsView === "holdings"
                          ? "Portfolio composition"
                          : "Free-float distortion"}
                      </strong>
                    </div>
                    <div
                      className="holdings-view-tabs"
                      role="tablist"
                      aria-label="Holdings analysis view"
                    >
                      <button
                        id="holdings-overview-tab"
                        type="button"
                        role="tab"
                        aria-selected={holdingsView === "holdings"}
                        aria-controls="holdings-overview-panel"
                        onClick={() => setHoldingsView("holdings")}
                      >
                        Holdings
                      </button>
                      <button
                        id="distortion-details-tab"
                        type="button"
                        role="tab"
                        aria-selected={holdingsView === "distortion"}
                        aria-controls="distortion-details-panel"
                        onClick={() => setHoldingsView("distortion")}
                      >
                        Distortion details
                      </button>
                    </div>
                  </section>

                  {holdingsView === "holdings" ? (
                    <div
                      id="holdings-overview-panel"
                      role="tabpanel"
                      aria-labelledby="holdings-overview-tab"
                      className="holdings-subview"
                    >
                      {comparisonReady ? (
                        <section className="holdings-weight-control panel" aria-label="Comparison weight basis">
                          <div>
                            <span className="eyebrow">Comparison basis</span>
                            <strong>
                              {holdingsWeightView === "with-cash"
                                ? "Portfolios normalized with cash"
                                : "Securities normalized to 100%"}
                            </strong>
                            <small>
                              {holdingsWeightView === "with-cash"
                                ? "Cash is included in overlap, active sleeves, concentration and sector comparisons."
                                : "Cash is shown in the summary figures but excluded from every comparison measure."}
                            </small>
                          </div>
                          <div className="holdings-weight-toggle" role="group" aria-label="Comparison cash treatment">
                            <button
                              type="button"
                              aria-pressed={holdingsWeightView === "securities"}
                              disabled={loading}
                              onClick={() => void changeHoldingsWeightView("securities")}
                            >
                              Securities only
                            </button>
                            <button
                              type="button"
                              aria-pressed={holdingsWeightView === "with-cash"}
                              disabled={loading}
                              onClick={() => void changeHoldingsWeightView("with-cash")}
                            >
                              Include cash
                            </button>
                          </div>
                        </section>
                      ) : (
                        <section className="holdings-weight-control panel" aria-label="Holdings weight display">
                          <div>
                            <span className="eyebrow">Weight basis</span>
                            <strong>
                              {holdingsWeightView === "with-cash"
                                ? "Portfolio normalized with cash"
                                : "Securities normalized to 100%"}
                            </strong>
                            <small>
                              {holdingsWeightView === "with-cash"
                                ? "Cash, money-market and collateral positions are included in the allocation."
                                : "Cash-like positions are excluded and the remaining securities are rescaled to 100%."}
                            </small>
                          </div>
                          <div className="holdings-weight-toggle" role="group" aria-label="Cash treatment">
                            <button
                              type="button"
                              aria-pressed={holdingsWeightView === "securities"}
                              disabled={loading}
                              onClick={() => void changeHoldingsWeightView("securities")}
                            >
                              Securities only
                            </button>
                            <button
                              type="button"
                              aria-pressed={holdingsWeightView === "with-cash"}
                              disabled={loading}
                              onClick={() => void changeHoldingsWeightView("with-cash")}
                            >
                              Include cash
                            </button>
                          </div>
                        </section>
                      )}
                      <section className="metric-grid holdings-metric-grid" aria-label="Holdings overview metrics">
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
                            : "Open Distortion details for the full breakdown"}
                          tone={comparisonReady ? "neutral" : analysis.distortion.score !== null && analysis.distortion.score < 2 ? "positive" : "left"}
                        />
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
                          label="Cash & equivalents"
                          value={comparisonReady && rightAnalysis
                            ? <ComparisonPair left={formatPercent(analysis.cashWeight, 2)} right={formatPercent(rightAnalysis.cashWeight, 2)} />
                            : formatPercent(analysis.cashWeight, 2)}
                          detail={comparisonReady && rightAnalysis
                            ? <><ComparisonPair left={analysis.etf.ticker} right={rightAnalysis.etf.ticker} /> · {holdingsWeightView === "with-cash" ? "included in comparison" : "excluded from comparison"}</>
                            : `${analysis.cashHoldingsCount} source position${analysis.cashHoldingsCount === 1 ? "" : "s"} · ${holdingsWeightView === "with-cash" ? "included in view" : "excluded from view"}`}
                          tone={analysis.cashWeight > 0 ? "positive" : "neutral"}
                        />
                        <MetricCard
                          label="Top 10 concentration"
                          value={comparisonReady && comparison
                            ? <ComparisonPair left={formatPercent(comparison.left.top10Concentration, 1)} right={formatPercent(comparison.right.top10Concentration, 1)} />
                            : formatPercent(holdingsDisplaySummary?.top10Concentration ?? 0, 1)}
                          detail={comparisonReady
                            ? <><ComparisonPair left={comparison ? comparisonFundLabel(comparison, "left") : "ETF A"} right={comparison ? comparisonFundLabel(comparison, "right") : "ETF B"} /> · {holdingsWeightView === "with-cash" ? "cash included" : "cash excluded"}</>
                            : "Share held by the ten largest displayed positions"}
                          tone={comparisonReady ? "neutral" : "right"}
                        />
                        <MetricCard
                          label="Largest holding"
                          value={comparisonReady
                            ? <ComparisonPair left={leftComparisonSummary?.topPosition?.ticker ?? "—"} right={rightComparisonSummary?.topPosition?.ticker ?? "—"} />
                            : holdingsDisplaySummary?.topPosition?.ticker ?? "—"}
                          detail={comparisonReady
                            ? <ComparisonPair
                                left={`${comparison ? comparisonFundLabel(comparison, "left") : "ETF A"} ${formatPercent(leftComparisonSummary?.topPosition?.displayWeight ?? 0, 2)}`}
                                right={`${comparison ? comparisonFundLabel(comparison, "right") : "ETF B"} ${formatPercent(rightComparisonSummary?.topPosition?.displayWeight ?? 0, 2)}`}
                              />
                            : holdingsDisplaySummary?.topPosition ? `${holdingsDisplaySummary.topPosition.name} · ${formatPercent(holdingsDisplaySummary.topPosition.displayWeight, 2)}` : "No positions"}
                        />
                      </section>
                      {!comparisonReady ? (
                        <>
                          <section className="analysis-grid holdings-analysis-grid">
                            <HoldingsTopPositionsPanel analysis={analysis} weightView={holdingsWeightView} />
                            <HoldingsSectorPanel analysis={analysis} weightView={holdingsWeightView} />
                            <HoldingsGeographyPanel
                              key={analysis.etf.id}
                              analysis={analysis}
                              weightView={holdingsWeightView}
                            />
                          </section>
                          <HoldingsOverviewTable analysis={analysis} weightView={holdingsWeightView} />
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      id="distortion-details-panel"
                      role="tabpanel"
                      aria-labelledby="distortion-details-tab"
                      className="holdings-subview"
                    >
                      {analysis.distortion.coverageStatus !== "complete" ? (
                        <div className="alert holdings-distortion-alert">
                          Distortion coverage is {analysis.distortion.coverageWeight.toFixed(1)}%:
                          {" "}{analysis.distortion.missingHoldings} equity holding{analysis.distortion.missingHoldings === 1 ? " is" : "s are"} absent from the current ACWI universe. The score is calculated only on common securities and renormalized to 100%.
                        </div>
                      ) : null}
                      <section className="metric-grid" aria-label="Distortion metrics">
                        <MetricCard
                          label="Weight distortion index"
                          value={analysis.distortion.score === null ? "—" : analysis.distortion.score.toFixed(1)}
                          detail="1 point = 1% of weight to reallocate · 0 to 100"
                          tone={analysis.distortion.score !== null && analysis.distortion.score < 2 ? "positive" : "left"}
                        />
                        <MetricCard
                          label="ACWI coverage"
                          value={formatPercent(analysis.distortion.coverageWeight, 1)}
                          detail={`${analysis.distortion.coveredHoldings} of ${analysis.distortion.eligibleHoldings} equity holdings`}
                          tone={analysis.distortion.coverageStatus === "complete" ? "positive" : "neutral"}
                        />
                        <MetricCard
                          label="Common equity holdings"
                          value={`${analysis.distortion.coveredHoldings}`}
                          detail="Positions used in both distributions"
                        />
                        <MetricCard
                          label="Outside ACWI"
                          value={`${analysis.distortion.missingHoldings}`}
                          detail="Equity positions excluded from the score"
                          tone={analysis.distortion.missingHoldings === 0 ? "positive" : "right"}
                        />
                      </section>
                      <HoldingsDistortionPanel analysis={analysis} />
                      <DistortionPositionsTable analysis={analysis} />
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
          ) : workspaceView === "portfolio" ? (
            <PortfolioAnalytics
              catalog={availableCatalog}
              onCatalogChanged={refreshCatalog}
            />
          ) : workspaceView === "creator" ? (
            <EtfCreator
              catalog={researchCatalog}
              onCatalogChanged={refreshCatalog}
            />
          ) : (
            <MetricsOverview
              catalog={researchCatalog}
              initialEtfIds={[leftEtfId, rightEtfId]}
            />
          )}

          <footer className="disclaimer">
            <span>IndexLens</span>
            Indicative data sourced from fund and index providers. Holdings may
            change without notice. Fundamental metrics are sourced from TradingView.
            This is not investment advice.
          </footer>
        </div>
      </main>
    </div>
  );
}
