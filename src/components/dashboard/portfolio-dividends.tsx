"use client";

import { useEffect, useRef, useState } from "react";
import { SUPPORTED_CASH_CURRENCIES } from "@/domain/portfolio";
import { dividendAmounts, type DividendPayment, type PortfolioDividends } from "@/domain/dividends";

const money = (value: number | null, currency: string | null) => value === null || !currency ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 4 }).format(value);
const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`)) : "—";

function PaymentAdjustment({ payment, portfolioId, onSaved, onCancel }: { payment: DividendPayment; portfolioId: string; onSaved: () => Promise<void>; onCancel: () => void }) {
  const [quantity, setQuantity] = useState(payment.quantity.toString());
  const [amount, setAmount] = useState(payment.amountPerShare.toString());
  const [currency, setCurrency] = useState(payment.currency);
  const [rate, setRate] = useState(payment.withholdingRate.toString());
  const [fees, setFees] = useState(payment.fees.toString());
  const [paymentDate, setPaymentDate] = useState(payment.paymentDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let net: number | null = null;
  try { if (quantity && amount && rate && fees) net = dividendAmounts(Number(quantity), Number(amount), Number(rate), Number(fees)).netAmount; } catch { /* Submission validates the amount. */ }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v1/portfolio/dividends?portfolioId=${encodeURIComponent(portfolioId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentId: payment.id,
          paymentDate, quantity: Number(quantity), amountPerShare: Number(amount), currency, withholdingRate: Number(rate), fees: Number(fees) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Payment could not be updated.");
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Payment could not be updated."); }
    finally { setBusy(false); }
  }
  return <form className="dividend-payment-form" onSubmit={(event) => void submit(event)}>
    <strong>Adjust {payment.ticker} · {money(net, currency)} net</strong>
    <div className="dividend-form-fields">
      <label>Shares<input required type="number" step="any" min="0.000001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <label>Gross / share<input required type="number" step="any" min="0.000001" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label>Currency<select required value={currency} onChange={(event) => setCurrency(event.target.value)}>{SUPPORTED_CASH_CURRENCIES.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Withholding %<input required type="number" step="any" min="0" max="100" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
      <label>Fees<input required type="number" step="any" min="0" value={fees} onChange={(event) => setFees(event.target.value)} /></label>
      <label>Pay-date<input required type="date" min={payment.exDate} max={new Date().toISOString().slice(0, 10)} value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></label>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    <div className="dividend-form-actions"><button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save"}</button><button className="secondary-button" disabled={busy} type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

function DividendDates({ exDate, paymentDate }: { exDate: string | null; paymentDate: string | null }) {
  return <dl className="dividend-dates"><div><dt>Ex-date</dt><dd>{dateLabel(exDate)}</dd></div><div><dt>Pay-date</dt><dd>{dateLabel(paymentDate)}</dd></div></dl>;
}

const cashSignature = (balances: ReadonlyArray<{ currency: string; amount: number }>) => JSON.stringify(balances.map(({ currency, amount }) => [currency, amount]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

export function PortfolioDividendsPanel({ portfolioId, revision, cashBalances, onPayment }: { portfolioId: string; revision?: string; cashBalances?: ReadonlyArray<{ currency: string; amount: number }>; onPayment?: () => Promise<void> }) {
  const [result, setResult] = useState<PortfolioDividends | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<"upcoming" | "recent" | "received">("upcoming");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<DividendPayment | null>(null);
  const onPaymentRef = useRef(onPayment);
  const mounted = useRef(false);
  const seenPayments = useRef<string[] | null>(null);
  const notifiedCash = useRef<string | null>(null);
  const displayedCash = cashBalances ? cashSignature(cashBalances) : null;
  const key = `${portfolioId}:${revision ?? ""}:${attempt}:${displayedCash ?? ""}`;
  const [loadedKey, setLoadedKey] = useState("");
  useEffect(() => { onPaymentRef.current = onPayment; }, [onPayment]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Let settlement requests finish across effect restarts; aborting a
        // response after its cash transaction would hide the refresh signal.
        const response = await fetch(`/api/v1/portfolio/dividends?portfolioId=${encodeURIComponent(portfolioId)}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Dividends unavailable.");
        const data = payload.data as PortfolioDividends;
        const payments = data.payments.filter((payment) => payment.cashCredited).map((payment) => payment.id);
        const currentCash = data.cashBalances ? cashSignature(data.cashBalances) : null;
        const outOfDate = payments.length > 0 && displayedCash !== null && currentCash !== null && displayedCash !== currentCash && notifiedCash.current !== currentCash;
        const cashChanged = data.cashUpdated || outOfDate || (seenPayments.current !== null && payments.some((id) => !seenPayments.current!.includes(id)));
        if (mounted.current) seenPayments.current = payments;
        if (active) { setResult(data); setError(null); setLoadedKey(key); }
        if (mounted.current && cashChanged) { notifiedCash.current = currentCash; await onPaymentRef.current?.(); }
      } catch (cause) { if (active) { setError(cause instanceof Error ? cause.message : "Dividends unavailable."); setLoadedKey(key); } }
    })();
    const timer = setInterval(() => setAttempt((value) => value + 1), 5 * 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [portfolioId, key, displayedCash]);
  const today = new Date().toISOString().slice(0, 10);
  const loading = loadedKey !== key;
  const events = (result?.events ?? []).filter((event) => tab === "upcoming"
    ? (event.exDate && event.exDate >= today) || (event.paymentDate && event.paymentDate >= today)
    : event.exDate && event.exDate < today && event.amountPerShare !== null);
  if (tab === "upcoming") events.sort((a, b) => (a.exDate && a.exDate >= today ? a.exDate : a.paymentDate ?? "").localeCompare(b.exDate && b.exDate >= today ? b.exDate : b.paymentDate ?? ""));
  const payments = [...(result?.payments ?? [])].sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
  const total = tab === "received" ? payments.length : events.length;
  return <section className="panel portfolio-events-panel portfolio-dividends-panel" aria-label="Portfolio dividend calendar" aria-busy={loading}>
    <div className="panel-heading"><h2>Dividend calendar</h2></div>
    <div className="segmented-control" role="group" aria-label="Dividend calendar view">{(["upcoming", "recent", "received"] as const).map((value) => <button type="button" key={value} className={tab === value ? "is-active" : ""} aria-pressed={tab === value} onClick={() => { setTab(value); setExpanded(false); setSelected(null); }}>{value === "upcoming" ? "Upcoming" : value === "recent" ? "Recent" : "Received"}</button>)}</div>
    {loading && !result ? <p className="portfolio-events-message" role="status"><span className="spinner" /> Loading dividends…</p> : error ? <p role="alert">{error}<button className="secondary-button" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></p> : tab === "received" ? <>
      {payments.length ? <ul className="dividend-event-list">{(expanded ? payments : payments.slice(0, 6)).map((payment) => <li key={payment.id}>
        <div className="dividend-row-heading"><strong>{payment.ticker}</strong><span>{money(payment.netAmount, payment.currency)} <small>net</small></span></div>
        <DividendDates exDate={payment.exDate} paymentDate={payment.paymentDate} />
        <button className="dividend-adjust-button" type="button" onClick={() => setSelected(payment)} aria-label={`Adjust ${payment.ticker} dividend paid ${dateLabel(payment.paymentDate)}`}>Adjust</button>
      </li>)}</ul> : <p className="portfolio-events-message">No dividends received yet.</p>}
    </> : <>
      {events.length ? <ul className="dividend-event-list">{(expanded ? events : events.slice(0, 6)).map((event) => <li key={`${event.securityId}:${event.exDate ?? event.paymentDate}`}>
        <div className="dividend-row-heading"><strong>{event.ticker}</strong><span>{money(event.amountPerShare, event.currency)} <small>/ share</small></span></div>
        <span className="dividend-stock-name">{event.name}</span>
        <DividendDates exDate={event.exDate} paymentDate={event.paymentDate} />
      </li>)}</ul> : <p className="portfolio-events-message">{tab === "upcoming" ? "No upcoming dividends." : "No recent dividends."}</p>}
    </>}
    {total > 6 ? <button className="portfolio-events-more" type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer" : `Show all ${total}`}</button> : null}
    {selected ? <PaymentAdjustment key={selected.id} payment={selected} portfolioId={portfolioId} onCancel={() => setSelected(null)} onSaved={async () => { setSelected(null); setAttempt((value) => value + 1); await onPaymentRef.current?.(); }} /> : null}
  </section>;
}
