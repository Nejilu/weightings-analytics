"use client";

import { useEffect, useState } from "react";
import type { EtfShareClass } from "@/domain/etf";
import type { LocalEtfDetail, LocalPortfolioEtfDetail } from "@/domain/local-etf";
import type { FxRate } from "@/domain/portfolio";
import type { PortfolioDashboardEntry } from "@/domain/portfolio-dashboard";
import { PortfolioDashboard } from "./portfolio-dashboard";

interface PortfolioOverviewProps {
  portfolios: EtfShareClass[];
  onCreate?: () => void;
  owner?: boolean;
  onSelect: (id: string, detail?: LocalPortfolioEtfDetail) => void;
}

function PortfolioCard({
  etf,
  onSelect,
  eurRateToUsd,
  eurRateLoading,
}: {
  etf: EtfShareClass;
  onSelect: PortfolioOverviewProps["onSelect"];
  eurRateToUsd: number | null;
  eurRateLoading: boolean;
}) {
  const [detail, setDetail] = useState<LocalPortfolioEtfDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/v1/local-etfs/${encodeURIComponent(etf.id)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { data?: LocalEtfDetail; error?: string };
        if (!response.ok || payload.data?.kind !== "portfolio") {
          throw new Error(payload.error ?? "Portfolio summary unavailable.");
        }
        if (!controller.signal.aborted) setDetail(payload.data);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Portfolio summary unavailable.");
        }
      }
    })();
    return () => controller.abort();
  }, [etf.id, attempt]);

  const record = detail?.portfolio;
  const total = record?.analysis?.totalMarketValueUsd ?? (record && !record.priceError
    && record.items.every((item) => item.currentValueUsd !== undefined)
    && record.cashPositions.every((position) => position.valueUsd !== undefined)
    ? record.items.reduce((sum, item) => sum + (item.currentValueUsd ?? 0), 0)
      + record.cashPositions.reduce((sum, position) => sum + (position.valueUsd ?? 0), 0)
    : undefined);

  return (
    <article className="portfolio-card panel">
      <button className="portfolio-card__open" type="button" onClick={() => onSelect(etf.id, detail ?? undefined)}>
        <span className="portfolio-card__heading">
          <span className="portfolio-card__ticker">{etf.ticker}</span>
          <span className="info-chip">{etf.visibility ?? "private"}</span>
        </span>
        <h2>{etf.name}</h2>
        <p className="portfolio-card__description">
          {detail?.editableDescription || "ETF positions, stocks and cash in one portfolio."}
        </p>
        <span className="portfolio-card__value">
          <span>Net asset value · USD</span>
          <strong>{total !== undefined
            ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(total)
            : record || error ? "Unavailable" : "Loading…"}</strong>
          <small className="portfolio-card__euro-value">
            {total !== undefined && eurRateToUsd !== null
              ? `${new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(total / eurRateToUsd)} EUR`
              : eurRateLoading || (!record && !error) ? "EUR · Loading…" : "EUR · Unavailable"}
          </small>
        </span>
        <span className="portfolio-card__stats">
          <span><b>{record ? record.items.length : "—"}</b> positions</span>
          <span><b>{record ? record.cashPositions.length : "—"}</b> cash balances</span>
          <span><b>{record?.analysis?.positionsCount ?? "—"}</b> underlying holdings</span>
        </span>
        <span className="portfolio-card__footer">
          <span>{record ? `Updated ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(record.updatedAt))}` : "Saved portfolio"}</span>
          <b>View portfolio <span aria-hidden="true">↗</span></b>
        </span>
      </button>
      {error ? (
        <div className="portfolio-card__status" role="status">
          <span>{error}</span>
          <button type="button" className="secondary-button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Retry</button>
        </div>
      ) : record?.priceError || record?.analysisError ? (
        <p className="portfolio-card__status">Some prices or analysis are unavailable. Open the portfolio for details.</p>
      ) : null}
    </article>
  );
}

function PublicPortfolioCard({ etf, entry, onSelect }: { etf: EtfShareClass; entry?: PortfolioDashboardEntry; onSelect: PortfolioOverviewProps["onSelect"] }) {
  const latest = entry?.snapshots.at(-1);
  const money = (value: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  return <article className="portfolio-card panel"><button className="portfolio-card__open" type="button" onClick={() => onSelect(etf.id)}>
    <span className="portfolio-card__heading"><span className="portfolio-card__ticker">{etf.ticker}</span><span className="info-chip">{etf.visibility === "public" ? "Public" : "Weights only"}</span></span>
    <h2>{etf.name}</h2><p className="portfolio-card__description">Published portfolio composition and evolution.</p>
    <span className="portfolio-card__value"><span>{etf.visibility === "public" ? "Last saved value · USD" : "Relative evolution · USD"}</span>
      <strong>{etf.visibility === "public" ? latest?.valueUsd !== undefined ? money(latest.valueUsd, "USD") : "No saved value" : latest ? `${latest.indexUsd >= 100 ? "+" : ""}${(latest.indexUsd - 100).toFixed(2)}%` : "No snapshots"}</strong>
      <small className="portfolio-card__euro-value">{etf.visibility === "public" ? latest?.valueEur !== undefined ? `${money(latest.valueEur, "EUR")} EUR` : "EUR · Unavailable" : "Since first saved snapshot · amounts private"}</small>
    </span>
    <span className="portfolio-card__stats"><span>{entry?.positionsCount ?? "—"} positions</span><span>{entry?.cashCount ?? "—"} cash balances</span></span>
    <span className="portfolio-card__footer"><span>{latest ? `Snapshot ${latest.date}` : "Saved portfolio"}</span><b>View portfolio ↗</b></span>
  </button></article>;
}

export function PortfolioOverview({ portfolios, onCreate, onSelect, owner = true }: PortfolioOverviewProps) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([portfolios.map((etf) => [etf.id, etf.visibility]), attempt]);
  const [dashboard, setDashboard] = useState<{ key: string; data: PortfolioDashboardEntry[]; error: string | null }>({ key: "", data: [], error: null });
  const [eurRate, setEurRate] = useState<{ rateToUsd: number | null; loading: boolean }>({
    rateToUsd: null,
    loading: true,
  });
  const hasPortfolios = portfolios.length > 0;

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/v1/portfolio/overview", { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { data?: PortfolioDashboardEntry[]; error?: string };
        if (!response.ok || !payload.data) throw new Error(payload.error ?? "Portfolio histories are unavailable.");
        if (!controller.signal.aborted) setDashboard({ key, data: payload.data, error: null });
      } catch (cause) {
        if (!controller.signal.aborted) setDashboard({ key, data: [], error: cause instanceof Error ? cause.message : "Portfolio histories are unavailable." });
      } finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [key, attempt]);
  const entries = dashboard.key === key ? dashboard.data.filter((entry) => portfolios.some((etf) => etf.id === entry.id)) : [];

  useEffect(() => {
    if (!hasPortfolios || !owner) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/prices/fx?currency=EUR", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { data?: FxRate };
        const rateToUsd = payload.data?.rateToUsd;
        if (!response.ok || !Number.isFinite(rateToUsd) || !rateToUsd || rateToUsd <= 0) {
          throw new Error("The EUR exchange rate is unavailable.");
        }
        if (!controller.signal.aborted) setEurRate({ rateToUsd, loading: false });
      } catch {
        if (!controller.signal.aborted) setEurRate({ rateToUsd: null, loading: false });
      }
    })();
    return () => controller.abort();
  }, [hasPortfolios, owner]);

  return (
    <div className="portfolio-workspace" id="portfolio">
      <section className="portfolio-overview-heading">
        <div>
          <span className="eyebrow">{owner ? "Your investments" : "Published portfolios"}</span>
          <h1>Portfolio</h1>
          <p>{owner ? "Explore your saved portfolios, positions and underlying exposure." : "Compare portfolio evolution and explore published holdings."}</p>
        </div>
        {owner ? <button className="primary-button" type="button" onClick={onCreate}>
          <span aria-hidden="true">＋</span> Create New
        </button> : null}
      </section>
      {hasPortfolios ? <PortfolioDashboard entries={entries} owner={owner} loading={dashboard.key !== key} error={dashboard.key === key ? dashboard.error : null} onRetry={() => setAttempt((value) => value + 1)} /> : null}
      <div className="portfolio-overview-label">
        <h2>{owner ? "Your portfolios" : "Published portfolios"}</h2>
        <span>{portfolios.length} saved portfolio{portfolios.length === 1 ? "" : "s"}</span>
      </div>
      {portfolios.length > 0 ? (
        <section className="portfolio-card-grid" aria-label="Saved portfolios">
          {portfolios.map((etf) => owner ? <PortfolioCard key={etf.id} etf={etf} onSelect={onSelect} eurRateToUsd={eurRate.rateToUsd} eurRateLoading={eurRate.loading} /> : <PublicPortfolioCard key={etf.id} etf={etf} entry={entries.find((entry) => entry.id === etf.id)} onSelect={onSelect} />)}
        </section>
      ) : (
        <section className="panel portfolio-overview-empty">
          <span className="portfolio-analysis-empty__icon" aria-hidden="true">◈</span>
          <h2>{owner ? "Your first portfolio starts here" : "No portfolios published yet"}</h2>
          <p>{owner ? "Create a portfolio to bring your ETF positions, stocks and cash together." : "Published portfolios will appear here when shared by the owner."}</p>
          {owner ? <button className="secondary-button" type="button" onClick={onCreate}>＋ Create New</button> : null}
        </section>
      )}
    </div>
  );
}
