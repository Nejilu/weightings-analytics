"use client";

import { useEffect, useState } from "react";
import type { PublishedPortfolio } from "@/domain/published-portfolio";

export function PublishedPortfolioPanel({ etfId }: { etfId: string }) {
  const [data, setData] = useState<PublishedPortfolio | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/v1/published-portfolios/${encodeURIComponent(etfId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = await response.json();
        if (!response.ok) throw new Error("Published amounts are unavailable.");
        if (!controller.signal.aborted) {
          setData(payload.data);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted) {
          setData(null);
          setError("Published amounts are unavailable.");
        }
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [etfId]);
  const number = (value: number | null) =>
    value === null
      ? "—"
      : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return (
    <section className="panel published-portfolio">
      <h2>Published positions{data ? ` · ${data.ticker}` : ""}</h2>
      <p>Read-only positions shared by the owner, including exact amounts.</p>
      {error ? (
        <p role="status">{error}</p>
      ) : !data ? (
        <p>Loading positions…</p>
      ) : (
        <>
          <p>
            Net asset value:{" "}
            <strong>{number(data.totalMarketValueUsd)} USD</strong>
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Shares / cash amount</th>
                  <th>Value (USD)</th>
                  <th>Weight</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={`${item.ticker}-${index}`}>
                    <td>
                      {item.ticker} · {item.name}
                    </td>
                    <td>{number(item.quantity)}</td>
                    <td>{number(item.currentValueUsd)}</td>
                    <td>{number(item.allocationWeight)}%</td>
                  </tr>
                ))}
                {data.cash.map((cash) => (
                  <tr key={cash.currency}>
                    <td>{cash.currency} cash</td>
                    <td>
                      {number(cash.amount)} {cash.currency}
                    </td>
                    <td>{number(cash.valueUsd)} </td>
                    <td>{number(cash.weight)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
