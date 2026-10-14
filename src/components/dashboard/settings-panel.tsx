"use client";

import { useEffect, useState } from "react";
import type { CountryDividendRate } from "@/data/dividend-withholding";
import type { DividendSettings } from "@/domain/dividends";

interface SettingsData {
  dividends: DividendSettings;
  countryRules: CountryDividendRate[];
  securities: Array<{ id: string; ticker: string | null; name: string; country: string | null }>;
  checkedAt: string;
}

export function SettingsPanel() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [countries, setCountries] = useState<Record<string, string>>({});
  const [stocks, setStocks] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [stockQuery, setStockQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/settings", { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Settings unavailable.");
        if (controller.signal.aborted) return;
        const loaded = payload.data as SettingsData;
        setData(loaded); setError(null);
        setCountries(Object.fromEntries(Object.entries(loaded.dividends.countryRates).map(([key, value]) => [key, String(value)])));
        setStocks(Object.fromEntries(Object.entries(loaded.dividends.securityRates).map(([key, value]) => [key, String(value)])));
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Settings unavailable."); }
    })();
    return () => controller.abort();
  }, [attempt]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null); setError(null);
    try {
      const rates = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== "").map(([key, value]) => [key, Number(value)]));
      const response = await fetch("/api/v1/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dividends: { countryRates: rates(countries), securityRates: rates(stocks) } }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Settings could not be saved.");
      setMessage("Settings saved. New estimates use these rates; confirmed payments keep their recorded amounts.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Settings could not be saved."); }
    finally { setBusy(false); }
  }
  const choices = data?.securities.filter((stock) => stockQuery.trim() && `${stock.ticker} ${stock.name}`.toLowerCase().includes(stockQuery.trim().toLowerCase())).slice(0, 20) ?? [];
  return <section className="panel settings-panel" aria-label="Application settings">
    <div className="panel-heading"><div><span className="eyebrow">Workspace preferences</span><h1>Settings</h1></div></div>
    <details className="settings-section">
      <summary><h2>Dividend withholding</h2></summary>
      <div className="settings-section-content">
        <p>Dividend withholding for directly held stocks. Stock overrides take priority over country overrides, then defaults. Blank fields use the default; 0% is a valid override.</p>
        {!data ? error ? <p role="alert">{error}<button className="secondary-button" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></p> : <p role="status">Loading settings…</p> : <form onSubmit={(event) => void save(event)}>
          <p>Defaults describe ordinary dividends to non-resident individuals before treaty relief. They are not your final income tax. US default: 30%; qualifying treaty residents may use 15% with a valid W-8BEN. Country classifications follow the security mapping, not the stock exchange or ADR ISIN.</p>
          <label className="settings-search">Filter countries<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Country name" /></label>
          <div className="settings-rate-list">{data.countryRules.filter((rule) => rule.country.toLowerCase().includes(query.toLowerCase())).map((rule) => <div className="settings-rate-row" key={rule.country}>
            <div><strong>{rule.country}</strong><span>{rule.rate === null ? "Default unverified — custom rate required" : `${rule.rate}% ${rule.requiresOverride ? "base only — custom rate required" : "default"}`}</span><small>{rule.note}</small>{rule.sourceUrl ? <a href={rule.sourceUrl} target="_blank" rel="noreferrer">Official source</a> : null}</div>
            <label>Custom %<input type="number" step="any" min="0" max="100" placeholder={rule.requiresOverride || rule.rate === null ? "Set rate" : String(rule.rate)} value={countries[rule.country] ?? ""} onChange={(event) => { setCountries((current) => ({ ...current, [rule.country]: event.target.value })); setMessage(null); }} /></label>
          </div>)}</div>
          <h2>Stock overrides</h2><p>Use these for exemptions, special dividends or a rate specific to a security. Fees are entered separately when confirming a payment.</p>
          <label className="settings-search">Find a stock<input type="search" placeholder="Ticker or company" value={stockQuery} onChange={(event) => setStockQuery(event.target.value)} /></label>
          {choices.length ? <div className="settings-stock-options">{choices.map((stock) => <button className="secondary-button" key={stock.id} type="button" onClick={() => { setStocks((current) => ({ ...current, [stock.id]: current[stock.id] ?? "" })); setStockQuery(""); }}>{stock.ticker} · {stock.name}</button>)}</div> : null}
          {Object.entries(stocks).map(([id, value]) => {
            const stock = data.securities.find((stock) => stock.id === id);
            return <div className="settings-stock-row" key={id}><span>{stock?.ticker ?? id} · {stock?.name}</span><label>Custom %<input type="number" step="any" min="0" max="100" value={value} onChange={(event) => setStocks((current) => ({ ...current, [id]: event.target.value }))} /></label><button className="secondary-button" type="button" onClick={() => setStocks((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))}>Remove</button></div>;
          })}
          <p className="portfolio-events-footnote">Defaults checked {data.checkedAt}. Unknown or conditional rates require configuration. Treaty benefits, refunds and domestic taxes are not applied automatically.</p>
          {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
        </form>}
      </div>
    </details>
  </section>;
}
