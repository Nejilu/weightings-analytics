import type { ConsensusHorizon, MetricCaptureWindow, MetricDefinitionView, MetricKey, MetricsOverviewWarning } from "@/domain/metrics";

export const METRIC_GROUPS: Array<{
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
    description: "Typical constituent size after portfolio holding weights.",
    method: "Holding-weighted median market capitalization",
    color: "#8a6bb8",
    keys: ["market_cap"],
  },
];
export const CONSENSUS_OPTIONS: Array<{
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

export const SOURCE_WARNING_LABELS: Record<MetricsOverviewWarning, string> = {
  "holdings-stale": "Holdings cache stale",
  "mapping-unresolved": "Some TradingView mappings unresolved",
  "screener-partial": "Screener coverage partial",
  "screener-unavailable": "Screener unavailable; cached fundamentals retained",
  "estimates-partial": "Consensus estimates partial",
  "estimates-unavailable": "Estimates unavailable; cached series retained",
};

export function formatMetric(value: number | null, definition: MetricDefinitionView): string {
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

export function formatDelta(
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

export function formatNumber(value: number | null, decimals = 1): string {
  return value === null ? "—" : value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCaptureWindow(window: MetricCaptureWindow | null): string {
  if (!window) return "Unavailable";
  const oldest = formatDate(window.oldest);
  const latest = formatDate(window.latest);
  return oldest === latest ? latest : `${oldest}–${latest}`;
}
