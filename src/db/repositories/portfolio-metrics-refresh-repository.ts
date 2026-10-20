import { getSqlite } from "../client";

const KEY = "portfolio-metrics-daily-refresh";

export function portfolioMetricsDayClaimed(date: string): boolean {
  return Boolean(getSqlite().prepare(`SELECT 1 FROM application_settings
    WHERE key=? AND json_extract(value_json, '$.date')=?`).get(KEY, date));
}

export function portfolioMetricsTargets(): string[] {
  return (getSqlite().prepare(`SELECT e.id FROM etfs e
    WHERE e.active=1 AND e.fund_type='portfolio'
      AND EXISTS (SELECT 1 FROM portfolio_items p WHERE p.portfolio_id=e.portfolio_id)
    ORDER BY e.id`).all() as { id: string }[]).map((row) => row.id);
}

export function claimPortfolioMetricsDay(date: string, startedAt: string): boolean {
  return getSqlite().prepare(`INSERT INTO application_settings(key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    WHERE COALESCE(json_extract(application_settings.value_json, '$.date'), '') <> ?`)
    .run(KEY, JSON.stringify({ date, startedAt, status: "running" }), startedAt, date).changes === 1;
}

export function finishPortfolioMetricsDay(date: string, startedAt: string, details: {
  portfolios: number; securities: number; errors: string[];
}): void {
  const now = new Date().toISOString();
  getSqlite().prepare(`UPDATE application_settings SET value_json=?, updated_at=?
    WHERE key=? AND json_extract(value_json, '$.date')=? AND json_extract(value_json, '$.startedAt')=?`)
    .run(JSON.stringify({ date, startedAt, completedAt: now,
      status: details.errors.length ? "partial" : "complete", ...details }), now, KEY, date, startedAt);
}
