"use client";

import { useState } from "react";
import type { PortfolioHoldingsValuation } from "@/domain/portfolio-valuation";
import { AdrPremiumBadge } from "./adr-premium-badge";
import { usePortfolioFx } from "./use-portfolio-fx";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const shares = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
export const formatPortfolioUsd = (value: number | null) => value === null ? "—" : usd.format(value);

export function PortfolioValuationPanel({
  ticker,
  valuation,
}: {
  ticker: string;
  valuation: PortfolioHoldingsValuation;
}) {
  const [currency, setCurrency] = useState<"USD" | "EUR">("USD");
  const fx = usePortfolioFx();
  const formatValue = (value: number | null, selected: "USD" | "EUR" = currency) => value === null ? "—"
    : selected === "EUR" && !fx.rate ? fx.loading ? "EUR · Loading…" : "EUR · Unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: selected }).format(value / (selected === "EUR" ? fx.rate! : 1));
  return (
    <section className="panel holdings-position-table portfolio-valuation-panel" aria-label={`${ticker} portfolio value`}>
      <div className="panel-heading panel-heading--table">
        <div>
          <span className="eyebrow">Portfolio value · {ticker}</span>
          <h2>{formatValue(valuation.totalMarketValueUsd)}</h2>
          <small className="portfolio-total-equivalent">{formatValue(valuation.totalMarketValueUsd, currency === "USD" ? "EUR" : "USD")} {currency === "USD" && fx.rate ? "EUR" : currency === "EUR" ? "USD" : ""}</small>
          <p className="holdings-method-copy">Net asset value in {currency}, including cash and short positions. Amounts use the latest available quotes and exchange rates.</p>
          {fx.error ? <div className="portfolio-currency-error" role="status">{fx.error} <button className="secondary-button" type="button" onClick={fx.retry}>Retry</button></div> : null}
        </div>
        <div className="portfolio-valuation-controls"><span className="info-chip">Actual holdings</span>
          <div className="portfolio-currency-toggle" role="group" aria-label={`${ticker} portfolio display currency`}>
            {(["USD", "EUR"] as const).map((option) => <button key={option} type="button" aria-pressed={currency === option} className={currency === option ? "is-active" : ""} disabled={option === "EUR" && !fx.rate} onClick={() => setCurrency(option)}>{option}</button>)}
          </div>
        </div>
      </div>
      <details key={ticker}>
        <summary>Positions, amounts and shares · {valuation.items.length + valuation.cash.length} lines</summary>
        <p className="holdings-method-copy">Shares below are the instruments held. The analysis table shows underlying exposure through ETF sleeves; its dollar amounts always use net asset value, even when weights exclude cash.</p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Position</th><th>NAV weight</th><th>Value ({currency})</th><th>Shares / cash amount</th></tr></thead>
            <tbody>
              {valuation.items.map((item, index) => (
                <tr key={`${item.ticker}-${index}`} className={item.allocationWeight < 0 ? "is-negative" : undefined}>
                  <td><div className="security-cell"><div><strong className="security-ticker-with-premium"><span>{item.ticker}</span><AdrPremiumBadge security={item} /></strong><span>{item.name} · {item.kind === "etf" ? "ETF sleeve" : "Direct security"}</span></div></div></td>
                  <td>{item.allocationWeight.toFixed(2)}%</td>
                  <td>{formatValue(item.currentValueUsd)}</td>
                  <td>{item.quantity === null ? "—" : shares.format(item.quantity)} shares</td>
                </tr>
              ))}
              {valuation.cash.map((cash) => (
                <tr key={cash.currency} className={cash.amount < 0 ? "is-negative" : "is-cash-position"}>
                  <td>{cash.currency} {cash.amount < 0 ? "borrowed cash" : "cash"}</td>
                  <td>{cash.weight === null ? "—" : `${cash.weight.toFixed(2)}%`}</td>
                  <td>{formatValue(cash.valueUsd)}</td>
                  <td>{shares.format(cash.amount)} {cash.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
