export const METRIC_KEYS = [
  "pe_estimate_window_0",
  "pe_estimate_window_1",
  "pe_estimate_window_2",
  "pe_estimate_window_3",
  "pe_estimate_window_4",
  "eps_growth_estimate_forward_4q",
  "price_earnings_ttm",
  "price_to_book",
  "price_to_sales",
  "enterprise_value_to_ebitda",
  "price_to_free_cash_flow",
  "operating_margin",
  "return_on_invested_capital",
  "revenue_growth_ttm",
  "eps_diluted_growth_ttm",
  "market_cap",
  "dividend_yield",
  "return_on_equity",
  "debt_to_equity",
  "beta_1y",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export const DERIVED_METRIC_KEYS = [
  "pe_estimate_window_0",
  "pe_estimate_window_1",
  "pe_estimate_window_2",
  "pe_estimate_window_3",
  "pe_estimate_window_4",
  "eps_growth_estimate_forward_4q",
] as const satisfies readonly MetricKey[];

export interface MetricDefinitionView {
  key: MetricKey;
  name: string;
  shortName: string;
  description: string;
  category: "Valuation" | "Earnings" | "Quality" | "Income & risk" | "Size";
  unit: "multiple" | "percent" | "number" | "compact_number";
  tradingViewColumn: string | null;
  decimals: number;
  aggregate: boolean;
  showInOverview: boolean;
  formula?: string;
  aggregation?: "weighted_mean" | "weighted_harmonic" | "weighted_earnings_yield_growth" | "weighted_median";
  validRange?: { min: number; max: number };
}

const ESTIMATE_PE_DEFINITIONS = ([0, 1, 2, 3, 4] as const).map((window): MetricDefinitionView => ({
  key: `pe_estimate_window_${window}` as MetricKey,
  name: window === 0
    ? "P/E on the four latest historical consensus estimates"
    : window === 4
      ? "P/E on the next four quarterly consensus estimates"
      : `P/E estimate path (+${window} quarter${window > 1 ? "s" : ""})`,
  shortName: window === 0
    ? "P/E estimated trailing 4Q"
    : window === 4
      ? "P/E estimated forward 4Q"
      : `P/E estimate +${window}Q`,
  description: window === 0
    ? "Current local-currency price divided by the sum of the consensus estimates attached to the four latest reported quarters; reported EPS is never used."
    : window === 4
      ? "Current local-currency price divided by the sum of the next four quarterly consensus estimates."
      : "Current local-currency price divided by a rolling four-quarter EPS window built exclusively from consensus estimates.",
  category: "Valuation",
  unit: "multiple",
  tradingViewColumn: null,
  decimals: 1,
  aggregate: true,
  showInOverview: window === 0 || window === 4,
  formula: `local_price / sum(consensus_eps_quarters_${window}_through_${window + 3})`,
  aggregation: "weighted_harmonic",
}));

export const METRIC_DEFINITIONS: readonly MetricDefinitionView[] = [
  ...ESTIMATE_PE_DEFINITIONS,
  {
    key: "eps_growth_estimate_forward_4q",
    name: "Expected EPS growth (next four quarters)",
    shortName: "Estimated EPS growth next 4Q",
    description: "Aggregate earnings growth reconstructed from the holding-weighted historical and forward earnings yields; components need positive historical and forward P/E.",
    category: "Earnings",
    unit: "percent",
    tradingViewColumn: null,
    decimals: 1,
    aggregate: true,
    showInOverview: true,
    formula: "(sum(holding_weight / pe_forward) / sum(holding_weight / pe_historical) - 1) * 100",
    aggregation: "weighted_earnings_yield_growth",
  },
  {
    key: "price_earnings_ttm",
    name: "Price / earnings (TTM)",
    shortName: "P/E TTM",
    description: "Holding-weighted harmonic trailing price-to-earnings multiple on profitable companies.",
    category: "Valuation",
    unit: "multiple",
    tradingViewColumn: "price_earnings_ttm",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
    formula: "sum(holding_weight) / sum(holding_weight / price_earnings_ttm)",
    aggregation: "weighted_harmonic",
  },
  {
    key: "price_to_book",
    name: "Price / book",
    shortName: "P/B",
    description: "Holding-weighted harmonic price-to-book multiple on positive book value.",
    category: "Valuation",
    unit: "multiple",
    tradingViewColumn: "price_book_fq",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
    formula: "sum(holding_weight) / sum(holding_weight / price_to_book)",
    aggregation: "weighted_harmonic",
  },
  {
    key: "price_to_sales",
    name: "Price / sales",
    shortName: "P/S",
    description: "Holding-weighted harmonic price-to-sales multiple on positive sales.",
    category: "Valuation",
    unit: "multiple",
    tradingViewColumn: "price_sales_current",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
    formula: "sum(holding_weight) / sum(holding_weight / price_to_sales)",
    aggregation: "weighted_harmonic",
  },
  {
    key: "enterprise_value_to_ebitda",
    name: "Enterprise value / EBITDA (TTM)",
    shortName: "EV/EBITDA",
    description: "Holding-weighted harmonic EV/EBITDA multiple on positive EBITDA.",
    category: "Valuation",
    unit: "multiple",
    tradingViewColumn: "enterprise_value_ebitda_ttm",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
    formula: "sum(holding_weight) / sum(holding_weight / enterprise_value_to_ebitda)",
    aggregation: "weighted_harmonic",
  },
  {
    key: "price_to_free_cash_flow",
    name: "Price / free cash flow (TTM)",
    shortName: "P/FCF",
    description: "Holding-weighted harmonic price-to-free-cash-flow multiple on positive free cash flow.",
    category: "Valuation",
    unit: "multiple",
    tradingViewColumn: "price_free_cash_flow_ttm",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
    formula: "sum(holding_weight) / sum(holding_weight / price_to_free_cash_flow)",
    aggregation: "weighted_harmonic",
  },
  {
    key: "operating_margin",
    name: "Operating margin",
    shortName: "Operating margin",
    description: "Holding-weighted operating margin, including profitable and loss-making constituents.",
    category: "Quality",
    unit: "percent",
    tradingViewColumn: "operating_margin",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
  },
  {
    key: "return_on_invested_capital",
    name: "Return on invested capital",
    shortName: "ROIC",
    description: "Holding-weighted return on invested capital.",
    category: "Quality",
    unit: "percent",
    tradingViewColumn: "return_on_invested_capital",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
  },
  {
    key: "revenue_growth_ttm",
    name: "Revenue growth (TTM YoY)",
    shortName: "Revenue growth",
    description: "Holding-weighted trailing revenue growth versus the prior-year period.",
    category: "Earnings",
    unit: "percent",
    tradingViewColumn: "total_revenue_yoy_growth_ttm",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
  },
  {
    key: "eps_diluted_growth_ttm",
    name: "Diluted EPS growth (TTM YoY)",
    shortName: "EPS growth TTM",
    description: "Holding-weighted trailing diluted EPS growth versus the prior-year period.",
    category: "Earnings",
    unit: "percent",
    tradingViewColumn: "earnings_per_share_diluted_yoy_growth_ttm",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
  },
  {
    key: "market_cap",
    name: "Market-cap profile",
    shortName: "Market cap",
    description: "Holding-weighted median TradingView market capitalization on its global comparison basis.",
    category: "Size",
    unit: "compact_number",
    tradingViewColumn: "market_cap_basic",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
    formula: "weighted_median(market_cap_basic, holding_weight)",
    aggregation: "weighted_median",
  },
  {
    key: "dividend_yield",
    name: "Dividend yield",
    shortName: "Dividend",
    description: "Weighted average current dividend yield.",
    category: "Income & risk",
    unit: "percent",
    tradingViewColumn: "dividends_yield_current",
    decimals: 2,
    aggregate: true,
    showInOverview: true,
  },
  {
    key: "return_on_equity",
    name: "Return on equity",
    shortName: "ROE",
    description: "Weighted average return on common equity.",
    category: "Quality",
    unit: "percent",
    tradingViewColumn: "return_on_equity",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
  },
  {
    key: "debt_to_equity",
    name: "Debt / equity",
    shortName: "Debt / equity",
    description: "Weighted average debt-to-equity ratio.",
    category: "Quality",
    unit: "number",
    tradingViewColumn: "debt_to_equity",
    decimals: 1,
    aggregate: true,
    showInOverview: true,
  },
  {
    key: "beta_1y",
    name: "Beta (1 year)",
    shortName: "Beta",
    description: "Weighted average one-year equity beta.",
    category: "Income & risk",
    unit: "number",
    tradingViewColumn: "beta_1_year",
    decimals: 2,
    aggregate: true,
    showInOverview: true,
  },
];

export const SOURCE_METRIC_DEFINITIONS = METRIC_DEFINITIONS.filter(
  (definition): definition is MetricDefinitionView & { tradingViewColumn: string } =>
    definition.tradingViewColumn !== null,
);

export const OVERVIEW_METRIC_DEFINITIONS = METRIC_DEFINITIONS.filter(
  (definition) => definition.showInOverview,
);

export interface EstimateSeriesPoint {
  fiscalPeriod: string;
  estimate: number;
  isHistorical: boolean;
  estimateDate: string | null;
  analystCount: number | null;
}

export interface SecurityEstimateSeries {
  providerSymbol: string;
  currency: string;
  price: number;
  points: EstimateSeriesPoint[];
}

export interface SecurityMetricValues {
  securityId: string;
  providerSymbol: string;
  values: Partial<Record<MetricKey, number>>;
  estimateSeries?: SecurityEstimateSeries;
  capturedAtByKey?: Partial<Record<MetricKey, string>>;
  estimateCapturedAt?: string;
}

export interface MetricCaptureWindow {
  oldest: string;
  latest: string;
}

export interface WeightedMetric {
  key: MetricKey;
  value: number | null;
  coverageWeight: number;
  coveredHoldings: number;
  totalHoldings: number;
  captureWindow: MetricCaptureWindow | null;
}

export const CONSENSUS_HORIZONS = ["4q", "2q", "1q"] as const;

export type ConsensusHorizon = (typeof CONSENSUS_HORIZONS)[number];

export interface ConsensusAggregate {
  value: number | null;
  coverageWeight: number;
  coveredHoldings: number;
  totalHoldings: number;
  captureWindow: MetricCaptureWindow | null;
}

export interface ConsensusWindowView {
  quarters: 1 | 2 | 4;
  annualizationFactor: 1 | 2 | 4;
  valuationPath: ConsensusAggregate[];
  growth: ConsensusAggregate;
}

export interface ComponentValuationPoint {
  /** Stable v1 identity fields retained for existing API consumers. */
  securityId: string;
  ticker: string;
  name: string;
  sector: string;
  country: string;
  providerSymbol: string;
  weight: number;
  peHistoricalEstimate4q: number;
  peForwardEstimate4q: number;
  epsGrowthEstimate4q: number;
  /** Stable v1 detail fields retained for existing API consumers. */
  historicalEstimateSum: number;
  forwardEstimateSum: number;
  price: number;
  currency: string;
  estimatePoints: EstimateSeriesPoint[];
}

export interface ComponentValuationView {
  points: ComponentValuationPoint[];
  /** v1 counted complete metric points before P/E/display filtering. */
  eligibleCount: number;
  /** Current transparent count of all positive-weight equity holdings. */
  eligibleHoldingCount: number;
  displayedCount: number;
  /** Stable v1 field; finite outliers are not clipped. */
  excludedOutlierCount: number;
  missingMetricCount: number;
  excludedNonPositivePeCount: number;
  truncatedCount: number;
  representedWeight: number;
  axisLimits: {
    minGrowth: number;
    maxGrowth: number;
    maxPe: number;
  };
}

export interface EtfMetricsOverview {
  etfId: string;
  ticker: string;
  name: string;
  asOf: string;
  holdingsCount: number;
  mappedHoldings: number;
  mappingCoverageWeight: number;
  metrics: WeightedMetric[];
  consensusWindows: Record<ConsensusHorizon, ConsensusWindowView>;
  componentValuation: ComponentValuationView;
}

export type MetricsOverviewWarning =
  | "holdings-stale"
  | "mapping-unresolved"
  | "screener-partial"
  | "screener-unavailable"
  | "estimates-partial"
  | "estimates-unavailable";

export interface MetricsOverviewResult {
  calculatedAt: string;
  fundamentalsCaptureWindow: MetricCaptureWindow | null;
  estimatesCaptureWindow: MetricCaptureWindow | null;
  source: "TradingView Screener + Estimates";
  sourceStatus: "live" | "cached" | "partial" | "stale";
  sourceWarnings: MetricsOverviewWarning[];
  cacheTtlHours: number;
  definitions: MetricDefinitionView[];
  etfs: EtfMetricsOverview[];
}
