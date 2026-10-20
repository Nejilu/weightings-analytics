"use client";

import { INVESTED_RETURN_NOTE, type PortfolioReturnBasis } from "@/domain/portfolio-invested-return";

export function InvestedReturnMethodology() {
  return <details className="portfolio-history-table"><summary>How invested return is calculated</summary>
    <p className="portfolio-history-note">{INVESTED_RETURN_NOTE} USD and EUR use the exchange rates saved at each capture.</p>
  </details>;
}

export function PortfolioReturnToggle({ value, onChange }: { value: PortfolioReturnBasis; onChange: (value: PortfolioReturnBasis) => void }) {
  return <div className="segmented-control" role="group" aria-label="Portfolio return basis">
    <button type="button" aria-pressed={value === "total"} className={value === "total" ? "is-active" : ""} onClick={() => onChange("total")}>Total portfolio</button>
    <button type="button" aria-pressed={value === "invested"} className={value === "invested" ? "is-active" : ""} onClick={() => onChange("invested")}>Invested · 1× gross</button>
  </div>;
}
