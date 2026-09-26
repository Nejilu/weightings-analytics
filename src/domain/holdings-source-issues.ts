import type { HoldingsSnapshot } from "./etf";

export interface HoldingsSourceIssue {
  ticker: string;
  asOf: string;
  code: string;
  message: string;
}

export function holdingsSourceIssues(
  snapshots: Pick<HoldingsSnapshot, "etf" | "asOf" | "sourceStatus" | "sourceIssues">[],
): HoldingsSourceIssue[] {
  const issues = snapshots.flatMap((snapshot) => snapshot.sourceIssues?.length
    ? snapshot.sourceIssues
    : snapshot.sourceStatus === "stale"
      ? [{ ticker: snapshot.etf.ticker, asOf: snapshot.asOf,
        code: "REFRESH_FAILED", message: "The latest holdings could not be retrieved." }]
      : []);
  return [...new Map(issues.map((issue) => [
    JSON.stringify([issue.ticker, issue.asOf, issue.code]), issue,
  ])).values()];
}
