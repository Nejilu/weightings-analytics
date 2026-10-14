"use client";

import { useMemo, useState } from "react";
import type { AdrPairId } from "@/domain/adr-premium";
import { countryToContinent, geographicCountryLabel } from "@/domain/geography";

interface AllocationPosition {
  adrPremiumPairId?: AdrPairId;
  quoteTicker?: string;
  id: string;
  kind: "security" | "cash" | "financing";
  ticker: string;
  name: string;
  weight: number;
  valueUsd: number;
  sector: string;
  country: string;
}

function percent(value: number) { return `${value.toFixed(2)}%`; }

function AllocationList({ entries }: { entries: Array<{ label: string; weight: number }> }) {
  const maximum = Math.max(1, ...entries.map((entry) => Math.abs(entry.weight)));
  return <div className="holdings-sector-list">
    {entries.map((entry) => <div key={entry.label} className={entry.weight < 0 ? "is-negative" : undefined}>
      <span>{entry.label}</span>
      <div aria-hidden="true"><i className={entry.weight < 0 ? "is-negative" : undefined} style={{ width: `${Math.abs(entry.weight) / maximum * 100}%` }} /></div>
      <strong>{percent(entry.weight)}</strong>
    </div>)}
  </div>;
}

export function PortfolioAllocationPanels({ positions, includeCash, formatValue }: {
  positions: AllocationPosition[];
  includeCash: boolean;
  formatValue?: (valueUsd: number) => string;
}) {
  const [grouping, setGrouping] = useState<"country" | "continent">("country");
  const allocations = useMemo(() => {
    const sectors = new Map<string, number>();
    const geographies = new Map<string, number>();
    const cashLabels = new Set<string>();
    for (const position of positions) {
      const isCash = position.kind !== "security";
      const sector = isCash ? position.name : position.sector || "Unclassified";
      const geography = isCash ? position.name : grouping === "country" ? geographicCountryLabel(position.country) : countryToContinent(position.country);
      if (isCash) cashLabels.add(position.name);
      sectors.set(sector, (sectors.get(sector) ?? 0) + position.weight);
      geographies.set(geography, (geographies.get(geography) ?? 0) + position.weight);
    }
    const entries = (weights: Map<string, number>, limit: boolean) => [...weights].map(([label, weight]) => ({ label, weight }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .filter((entry, index) => !limit || index < 9 || cashLabels.has(entry.label));
    return { sectors: entries(sectors, true), geographies: entries(geographies, grouping === "country") };
  }, [positions, grouping]);
  const top = positions.slice(0, 10);
  const maximum = Math.max(1, ...top.map((position) => Math.abs(position.weight)));

  return <section className="analysis-grid holdings-analysis-grid" aria-label="Portfolio allocations">
    <article className="panel holdings-top-panel">
      <div className="panel-heading"><div><span className="eyebrow">Concentration</span><h2>Largest holdings</h2></div><span className="info-chip">Top 10 · {includeCash ? "with cash" : "securities"}</span></div>
      <div className="holdings-top-list holdings-top-list--valued">
        {top.map((position) => <div key={position.id} className={position.weight < 0 ? "is-negative" : undefined}>
          <div><strong>{position.ticker}</strong><span title={position.name}>{position.name}</span></div>
          <div aria-hidden="true"><i style={{ width: `${Math.abs(position.weight) / maximum * 100}%`, background: position.weight < 0 ? "var(--negative)" : undefined }} /></div>
          <strong>{percent(position.weight)}{formatValue ? <span>{formatValue(position.valueUsd)}</span> : null}</strong>
        </div>)}
      </div>
    </article>
    <article className="panel holdings-sector-panel">
      <div className="panel-heading"><div><span className="eyebrow">Allocation</span><h2>Sector structure</h2></div><span className="info-chip">{includeCash ? "With cash" : "Normalized securities"}</span></div>
      <AllocationList entries={allocations.sectors} />
    </article>
    <article className="panel holdings-geography-panel">
      <div className="panel-heading"><div><span className="eyebrow">Allocation</span><h2>Geographic structure</h2></div><div className="segmented-control" role="group" aria-label="Group portfolio geography by">
        <button type="button" className={grouping === "country" ? "is-active" : ""} aria-pressed={grouping === "country"} onClick={() => setGrouping("country")}>Countries</button>
        <button type="button" className={grouping === "continent" ? "is-active" : ""} aria-pressed={grouping === "continent"} onClick={() => setGrouping("continent")}>Continents</button>
      </div></div>
      <AllocationList entries={allocations.geographies} />
    </article>
  </section>;
}
