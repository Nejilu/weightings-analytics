"use client";

import { useEffect, useRef, useState } from "react";
import { journalEntryTitle, journalPositionKey, reconstructPortfolio, valueCounterfactual, type CounterfactualMarket, type PortfolioJournal } from "@/domain/portfolio-journal";

const money = (value: number | null | undefined) => value === null || value === undefined ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
const quantity = (value: number | null) => value === null ? "Unknown quantity" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
const date = (value: string, full = false) => new Intl.DateTimeFormat("en-GB", { dateStyle: full ? "long" : "medium", timeZone: "UTC" }).format(new Date(value));
const time = (value: string) => new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
type Valuation = { entryId: number; market: CounterfactualMarket; valuation: ReturnType<typeof valueCounterfactual>; currentValuation: ReturnType<typeof valueCounterfactual> };

interface PortfolioJournalExplorerProps {
  portfolioId: string;
  portfolioOptions?: Array<{ id: string; name: string }>;
  onClose: () => void;
}

export function PortfolioJournalExplorer(props: PortfolioJournalExplorerProps) {
  const [activePortfolioId, setActivePortfolioId] = useState(props.portfolioId);
  return <PortfolioJournalExplorerContent key={activePortfolioId} {...props} portfolioId={activePortfolioId} onPortfolioChange={setActivePortfolioId} />;
}

function PortfolioJournalExplorerContent({ portfolioId, portfolioOptions = [], onClose, onPortfolioChange }: PortfolioJournalExplorerProps & { onPortfolioChange: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const logList = useRef<HTMLOListElement>(null);
  const [journal, setJournal] = useState<PortfolioJournal | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<{ id: number; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [quotes, setQuotes] = useState<Record<number, Valuation>>({});

  useEffect(() => { const element = dialog.current!; if (!element.open) element.showModal(); }, []);
  useEffect(() => {
    const alignSelected = () => {
      const list = logList.current;
      const button = list?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (!list || !button) return;
      if (window.matchMedia("(max-width: 600px)").matches) {
        list.scrollLeft += button.getBoundingClientRect().left - list.getBoundingClientRect().left - (list.clientWidth - button.clientWidth) / 2;
      } else button.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    alignSelected();
    window.addEventListener("resize", alignSelected);
    return () => window.removeEventListener("resize", alignSelected);
  }, [selected, journal]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/v1/portfolio/journal?portfolioId=${encodeURIComponent(portfolioId!)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Journal could not be loaded.");
        if (!controller.signal.aborted) { setJournal(payload.data); setSelected(payload.data.entries.at(-1)?.id ?? null); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Journal unavailable."); }
    })();
    return () => controller.abort();
  }, [portfolioId]);

  const entry = journal?.entries.find((item) => item.id === selected);
  let composition = null, reconstructionError: string | null = null;
  if (journal && selected !== null) {
    try { composition = reconstructPortfolio(journal, selected); }
    catch (cause) { reconstructionError = cause instanceof Error ? cause.message : "Reconstruction unavailable."; }
  }
  const cached = selected !== null ? quotes[selected] : undefined;
  useEffect(() => {
    if (!journal || selected === null || cached || reconstructionError) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/v1/portfolio/counterfactual?portfolioId=${encodeURIComponent(portfolioId!)}&entryId=${selected}`, { cache: "no-store", signal: controller.signal });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? "Valuation unavailable.");
          if (!controller.signal.aborted) { setQuotes((saved) => ({ ...saved, [selected]: payload.data })); setQuoteError(null); }
        } catch (cause) { if (!controller.signal.aborted) setQuoteError({ id: selected, message: cause instanceof Error ? cause.message : "Valuation unavailable." }); }
      })();
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [journal, portfolioId, selected, cached, reconstructionError, retry]);

  const market = cached?.market;
  const valuation = cached?.valuation;
  const currentValuation = cached?.currentValuation;
  const todayValue = valuation?.valueUsd;
  const delta = todayValue !== null && todayValue !== undefined && entry?.valueUsd !== null && entry?.valueUsd !== undefined ? todayValue - entry.valueUsd : null;
  const difference = todayValue !== null && todayValue !== undefined && currentValuation?.valueUsd !== null && currentValuation?.valueUsd !== undefined ? todayValue - currentValuation.valueUsd : null;
  const selectedIndex = journal?.entries.findIndex((item) => item.id === selected) ?? 0;
  const changeIndex = (index: number) => { const target = journal?.entries[index]; if (target) setSelected(target.id); };
  const loading = !cached && quoteError?.id !== selected && !reconstructionError;

  return <dialog ref={dialog} className="portfolio-journal-dialog" aria-labelledby="portfolio-journal-title" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="portfolio-journal-shell">
      <header className="portfolio-journal-header">
        <div><span className="eyebrow">Portfolio history</span><h2 id="portfolio-journal-title">{journal?.current.name ?? "Portfolio journal"}</h2></div>
        {portfolioOptions.length > 1 ?
          <label className="portfolio-journal-selector">Portfolio<select aria-label="Portfolio journal selection" value={portfolioId} onChange={(event) => onPortfolioChange(event.target.value)}>
            {portfolioOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select></label> : null}
        <button type="button" className="secondary-button" onClick={onClose} aria-label="Close portfolio journal">✕</button>
      </header>
      {error ? <p className="portfolio-history-error" role="alert">{error}</p> : !journal ? <p className="portfolio-dashboard-message" role="status">Loading change journal…</p> : <div className="portfolio-journal-layout">
        <aside className="portfolio-journal-sidebar" aria-label="Portfolio change journal">
          <div className="portfolio-journal-section-title"><h3>Change journal</h3><span>{journal.entries.length} entries</span></div>
          <ol ref={logList}>{journal.entries.slice().reverse().map((item) => <li key={item.id}><button type="button" aria-pressed={selected === item.id} className={selected === item.id ? "is-selected" : ""} onClick={() => setSelected(item.id)}>
            <time dateTime={item.capturedAt}>{date(item.capturedAt)} · {time(item.capturedAt)} UTC</time><strong>{journalEntryTitle(item)}</strong>
            <small>{item.patch.items.length} position change{item.patch.items.length === 1 ? "" : "s"}{item.patch.cash.length ? ` · ${item.patch.cash.length} cash` : ""}</small>
          </button></li>)}</ol>
          <p>States are shown <b>after</b> each saved modification. Tracking begins with the first journal entry; earlier edits cannot be recovered.</p>
        </aside>
        <div className="portfolio-journal-main">
          <section className="portfolio-journal-timeline" aria-label="Counterfactual timeline">
            <div><span className="eyebrow">Selected state</span><h3>{entry ? date(entry.capturedAt, true) : "—"}</h3><span className="info-chip">{selectedIndex === journal.entries.length - 1 ? "Current composition" : "Past composition"} · {selectedIndex + 1} / {journal.entries.length}</span></div>
            {entry ? <p className="portfolio-journal-selected-entry">{journalEntryTitle(entry)} · {time(entry.capturedAt)} UTC</p> : null}
            <div className="portfolio-journal-slider"><button className="secondary-button" type="button" aria-label="Previous portfolio state" disabled={selectedIndex <= 0} onClick={() => changeIndex(selectedIndex - 1)}>←</button>
              <input type="range" min={0} max={Math.max(0, journal.entries.length - 1)} step={1} value={Math.max(0, selectedIndex)} onChange={(event) => changeIndex(Number(event.target.value))} aria-label="Portfolio modification timeline" aria-valuetext={entry ? `${date(entry.capturedAt)}: ${journalEntryTitle(entry)}` : "Loading"} disabled={journal.entries.length < 2} />
              <button className="secondary-button" type="button" aria-label="Next portfolio state" disabled={selectedIndex >= journal.entries.length - 1} onClick={() => changeIndex(selectedIndex + 1)}>→</button></div>
            <div className="portfolio-journal-endpoints"><span>{journal.entries[0] ? date(journal.entries[0].capturedAt) : ""}</span><span>{journal.entries.at(-1) ? date(journal.entries.at(-1)!.capturedAt) : ""}</span></div>
          </section>
          {reconstructionError ? <p className="portfolio-history-error" role="alert">{reconstructionError}</p> : <>
            <section className="portfolio-journal-metrics" aria-label="Counterfactual valuation" aria-busy={loading}>
              <article className="portfolio-journal-value"><span>Counterfactual · latest value</span><strong>{loading ? "Valuing…" : money(todayValue)}</strong><small>{delta !== null ? <span className={delta >= 0 ? "is-positive" : "is-negative"}>{delta >= 0 ? "+" : ""}{money(delta)} {entry!.valueUsd! > 0 ? `(${(delta / entry!.valueUsd! * 100).toFixed(2)}%)` : ""} since this entry</span> : "Historical value was not recorded for this entry."}</small></article>
              <article><span>Value at selected entry</span><strong>{money(entry?.valueUsd)}</strong><small>Recorded then · not recalculated</small></article>
              <article><span>Actual portfolio · same quotes</span><strong>{loading ? "Valuing…" : money(currentValuation?.valueUsd)}</strong><small>{difference !== null ? `${difference >= 0 ? "+" : ""}${money(difference)} hypothetical difference` : "Comparison requires complete prices."}</small></article>
            </section>
            {quoteError?.id === selected ? <p className="portfolio-history-error" role="alert">{quoteError.message} <button className="secondary-button" type="button" onClick={() => { setQuoteError(null); setRetry((value) => value + 1); }}>Retry quotes</button></p> : null}
            {valuation?.missing.length ? <p className="portfolio-history-error" role="status">Missing quotes or quantities: {valuation.missing.join(", ")}. The total is unavailable rather than partial.</p> : null}
            <div className="portfolio-journal-section-title"><h3>Positions held at this step</h3><span>{composition?.items.length ?? 0} positions · quantities frozen</span></div>
            <div className="portfolio-journal-positions">{composition?.items.map((item) => {
              const valued = valuation?.items.find((candidate) => journalPositionKey(candidate) === journalPositionKey(item));
              const weight = valued?.valueUsd !== null && valued?.valueUsd !== undefined && todayValue ? valued.valueUsd / todayValue * 100 : null;
              return <article key={journalPositionKey(item)} className={`portfolio-position-bubble portfolio-position-bubble--${item.kind}${(item.quantity ?? 0) < 0 ? " is-short" : ""}`}>
                <div className="portfolio-position-bubble__heading"><strong>{item.ticker}</strong><span>{item.kind === "etf" ? "ETF" : "Stock"}{(item.quantity ?? 0) < 0 ? " · short" : ""}</span></div>
                <p>{item.name}</p><strong>{loading ? "…" : money(valued?.valueUsd)}</strong><div className="portfolio-position-bubble__details"><span>{quantity(item.quantity)} shares</span><b>{weight !== null ? `${weight.toFixed(1)}%` : "—"}</b></div>
              </article>;
            })}{composition?.cashPositions.map((item) => {
              const valued = valuation?.cash.find((candidate) => candidate.currency === item.currency);
              return <article key={item.currency} className="portfolio-position-bubble portfolio-position-bubble--cash"><div className="portfolio-position-bubble__heading"><strong>{item.currency}</strong><span>{item.amount < 0 ? "Borrowing" : "Cash"}</span></div><p>Frozen cash balance · no interest</p><strong>{loading ? "…" : money(valued?.valueUsd)}</strong><div className="portfolio-position-bubble__details"><span>{quantity(item.amount)} {item.currency}</span></div></article>;
            })}</div>
            {entry ? <details className="portfolio-history-table"><summary>Changes in this entry</summary><ul className="portfolio-journal-diff">{entry.patch.items.map((item) => <li key={item.key}><b>{(item.after ?? item.before)!.ticker}</b><span>{quantity(item.before ? item.before.quantity : 0)} → {quantity(item.after ? item.after.quantity : 0)} shares</span></li>)}{entry.patch.cash.map((item) => <li key={item.currency}><b>{item.currency} cash</b><span>{quantity(item.before ?? 0)} → {quantity(item.after ?? 0)}</span></li>)}</ul></details> : null}
            <footer className="portfolio-journal-footnote">
              <p>{valuation ? `Oldest available quote: ${date(valuation.quotesAsOf)}${valuation.stale ? " · Includes stale quotes" : ""}. ` : ""}Later trades, deposits and withdrawals are ignored. Cash amounts stay fixed; non-USD cash uses the latest FX. Dividends, fees, interest and corporate-action adjustments are not simulated.</p>
              <p>Differences in value can include later cash flows; they do not measure alpha. Exploring never modifies or saves a portfolio.{market ? " Quotes are reused for this exploration session." : ""}</p>
            </footer>
          </>}
        </div>
      </div>}
    </div>
  </dialog>;
}
