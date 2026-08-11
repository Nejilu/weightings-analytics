"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  CreatorFilterMode,
  CreatorOverlapMode,
  EtfCreatorCriteria,
} from "@/domain/etf-creator";
import {
  applyCreatorManualCuration,
  filterCreatorHoldings,
  normalizeCreatorHoldings,
} from "@/domain/etf-creator";
import type {
  CatalogGroup,
  EtfShareClass,
  HoldingsSnapshot,
} from "@/domain/etf";

import { EtfSearch } from "./etf-search";
import { LocalEtfManager } from "./local-etf-manager";

interface EtfCreatorProps {
  catalog: CatalogGroup[];
  onCatalogChanged: () => Promise<void>;
}

function formatPercent(value: number, digits = 2) {
  return `${value.toFixed(digits)}%`;
}

function formatDate(value: string) {
  const date = value.slice(0, 10).split("-");
  return date.length === 3 ? `${date[2]}/${date[1]}/${date[0]}` : value;
}

function ToggleMode({
  value,
  onChange,
}: {
  value: CreatorFilterMode;
  onChange: (value: CreatorFilterMode) => void;
}) {
  return (
    <div className="creator-mode-toggle" aria-label="Filter behavior">
      <button
        type="button"
        className={value === "include" ? "is-active" : ""}
        aria-pressed={value === "include"}
        onClick={() => onChange("include")}
      >
        Keep
      </button>
      <button
        type="button"
        className={value === "exclude" ? "is-active" : ""}
        aria-pressed={value === "exclude"}
        onClick={() => onChange("exclude")}
      >
        Exclude
      </button>
    </div>
  );
}

function FilterOptions({
  options,
  selected,
  onChange,
  emptyLabel,
}: {
  options: { value: string; count: number }[];
  selected: string[];
  onChange: (selected: string[]) => void;
  emptyLabel: string;
}) {
  const selectedSet = new Set(selected);
  return (
    <div className="creator-option-list">
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="checkbox"
            checked={selectedSet.has(option.value)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, option.value]
                  : selected.filter((value) => value !== option.value),
              )
            }
          />
          <span>{option.value}</span>
          <small>{option.count}</small>
        </label>
      ))}
      {options.length === 0 ? <p>{emptyLabel}</p> : null}
    </div>
  );
}

export function EtfCreator({
  catalog,
  onCatalogChanged,
}: EtfCreatorProps) {
  const sourceEtfs = useMemo(
    () => catalog.flatMap((group) => group.variants),
    [catalog],
  );
  const defaultSourceEtfId =
    sourceEtfs.find((etf) => etf.id === "acwi-us")?.id ?? sourceEtfs[0]?.id ?? "";
  const [sourceEtfId, setSourceEtfId] = useState(defaultSourceEtfId);
  const overlapCatalog = useMemo(
    () =>
      catalog
        .map((group) => ({
          ...group,
          variants: group.variants.filter((etf) => etf.id !== sourceEtfId),
        }))
        .filter((group) => group.variants.length > 0),
    [catalog, sourceEtfId],
  );
  const overlapEtfs = useMemo(
    () => overlapCatalog.flatMap((group) => group.variants),
    [overlapCatalog],
  );
  const [source, setSource] = useState<HoldingsSnapshot | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [countryMode, setCountryMode] =
    useState<CreatorFilterMode>("include");
  const [countries, setCountries] = useState<string[]>([]);
  const [sectorMode, setSectorMode] =
    useState<CreatorFilterMode>("include");
  const [sectors, setSectors] = useState<string[]>([]);
  const [overlapMode, setOverlapMode] =
    useState<CreatorOverlapMode>("none");
  const [overlapEtfId, setOverlapEtfId] = useState(
    overlapEtfs[0]?.id ?? "",
  );
  const [overlapSnapshot, setOverlapSnapshot] =
    useState<HoldingsSnapshot | null>(null);
  const [overlapLoading, setOverlapLoading] = useState(false);
  const [manualInclusions, setManualInclusions] = useState<Set<string>>(
    () => new Set(),
  );
  const [manualExclusions, setManualExclusions] = useState<Set<string>>(
    () => new Set(),
  );
  const [resultQuery, setResultQuery] = useState("");
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("My Custom ETF");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedEtf, setSavedEtf] = useState<EtfShareClass | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceEquities = useMemo(
    () =>
      source?.holdings.filter((holding) => holding.assetClass === "Equity") ?? [],
    [source],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setSourceLoading(true);
      try {
        const response = await fetch(
          `/api/v1/holdings/${encodeURIComponent(sourceEtfId)}`,
          {
          cache: "no-store",
          signal: controller.signal,
          },
        );
        const payload = (await response.json()) as {
          data?: HoldingsSnapshot;
          error?: string;
        };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error ?? "The selected ETF universe is unavailable.");
        }
        setSource(payload.data);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "The selected ETF universe is unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setSourceLoading(false);
      }
    })();
    return () => controller.abort();
  }, [sourceEtfId]);

  useEffect(() => {
    if (overlapMode === "none" || !overlapEtfId) {
      return;
    }

    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setOverlapLoading(true);
        setOverlapSnapshot(null);
        setError(null);
      }
    });
    void (async () => {
      try {
        const response = await fetch(
          `/api/v1/holdings/${encodeURIComponent(overlapEtfId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = (await response.json()) as {
          data?: HoldingsSnapshot;
          error?: string;
        };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error ?? "The overlap ETF is unavailable.");
        }
        setOverlapSnapshot(payload.data);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setOverlapSnapshot(null);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "The overlap ETF is unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setOverlapLoading(false);
      }
    })();
    return () => controller.abort();
  }, [overlapEtfId, overlapMode]);

  const countriesOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const holding of sourceEquities) {
      counts.set(holding.country, (counts.get(holding.country) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => left.value.localeCompare(right.value));
  }, [sourceEquities]);

  const sectorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const holding of sourceEquities) {
      counts.set(holding.sector, (counts.get(holding.sector) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => left.value.localeCompare(right.value));
  }, [sourceEquities]);

  const criteria: EtfCreatorCriteria = useMemo(
    () => ({
      countryMode,
      countries,
      sectorMode,
      sectors,
      overlapMode,
      overlapEtfId: overlapMode === "none" ? undefined : overlapEtfId,
    }),
    [countryMode, countries, sectorMode, sectors, overlapMode, overlapEtfId],
  );
  const overlapSecurityIds = useMemo(
    () =>
      new Set(
        overlapSnapshot?.holdings.map((holding) => holding.securityId) ?? [],
      ),
    [overlapSnapshot],
  );
  const automaticSelection = useMemo(
    () =>
      filterCreatorHoldings(
        sourceEquities,
        criteria,
        overlapSecurityIds,
      ),
    [criteria, overlapSecurityIds, sourceEquities],
  );
  const automaticIds = useMemo(
    () => new Set(automaticSelection.map((holding) => holding.securityId)),
    [automaticSelection],
  );
  const selectedHoldings = useMemo(
    () =>
      applyCreatorManualCuration(
        sourceEquities,
        automaticSelection,
        manualInclusions,
        manualExclusions,
      ),
    [
      automaticSelection,
      manualExclusions,
      manualInclusions,
      sourceEquities,
    ],
  );
  const selectedIds = useMemo(
    () => new Set(selectedHoldings.map((holding) => holding.securityId)),
    [selectedHoldings],
  );
  const normalized = useMemo(
    () => normalizeCreatorHoldings(selectedHoldings),
    [selectedHoldings],
  );
  const sourceWeight = selectedHoldings.reduce(
    (sum, holding) => sum + holding.weight,
    0,
  );
  const top10Weight = normalized
    .slice(0, 10)
    .reduce((sum, holding) => sum + holding.weight, 0);
  const representedCountries = new Set(
    selectedHoldings.map((holding) => holding.country),
  ).size;
  const visibleHoldings = useMemo(() => {
    const query = resultQuery.trim().toLocaleUpperCase("en-US");
    return sourceEquities.filter(
      (holding) =>
        !query ||
        holding.ticker.toLocaleUpperCase("en-US").includes(query) ||
        holding.name.toLocaleUpperCase("en-US").includes(query),
    );
  }, [resultQuery, sourceEquities]);
  const normalizedWeights = useMemo(
    () => new Map(normalized.map((holding) => [holding.securityId, holding.weight])),
    [normalized],
  );
  const effectiveManualInclusions = useMemo(
    () =>
      sourceEquities.filter(
        (holding) =>
          manualInclusions.has(holding.securityId) &&
          !automaticIds.has(holding.securityId) &&
          !manualExclusions.has(holding.securityId),
      ),
    [automaticIds, manualExclusions, manualInclusions, sourceEquities],
  );
  const effectiveManualExclusions = useMemo(
    () =>
      sourceEquities.filter(
        (holding) =>
          automaticIds.has(holding.securityId) &&
          manualExclusions.has(holding.securityId),
      ),
    [automaticIds, manualExclusions, sourceEquities],
  );
  const overlapEtf = overlapEtfs.find((etf) => etf.id === overlapEtfId);

  const updateManualSelection = (securityId: string, checked: boolean) => {
    const automaticallySelected = automaticIds.has(securityId);
    setManualInclusions((current) => {
      const next = new Set(current);
      if (checked && !automaticallySelected) next.add(securityId);
      else next.delete(securityId);
      return next;
    });
    setManualExclusions((current) => {
      const next = new Set(current);
      if (!checked && automaticallySelected) next.add(securityId);
      else next.delete(securityId);
      return next;
    });
  };

  const resetFilters = () => {
    setCountries([]);
    setSectors([]);
    setOverlapMode("none");
    setOverlapSnapshot(null);
    setOverlapLoading(false);
    setManualInclusions(new Set());
    setManualExclusions(new Set());
    setResultQuery("");
  };

  const changeSourceEtf = (nextSourceEtfId: string) => {
    setSourceEtfId(nextSourceEtfId);
    if (nextSourceEtfId === overlapEtfId) {
      const replacement = overlapEtfs.find(
        (etf) => etf.id !== nextSourceEtfId,
      );
      setOverlapEtfId(replacement?.id ?? "");
    }
    setCountries([]);
    setSectors([]);
    setOverlapMode("none");
    setOverlapSnapshot(null);
    setOverlapLoading(false);
    setManualInclusions(new Set());
    setManualExclusions(new Set());
    setResultQuery("");
    setSavedEtf(null);
    setError(null);
  };

  const save = async () => {
    if (overlapMode !== "none" && !overlapSnapshot) {
      setError("Wait for the overlap ETF holdings before saving.");
      return;
    }
    setSaving(true);
    setSavedEtf(null);
    setError(null);
    try {
      const response = await fetch("/api/v1/etf-creator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          name,
          description,
          selectedSecurityIds: selectedHoldings.map(
            (holding) => holding.securityId,
          ),
          sourceEtfId,
          criteria,
        }),
      });
      const payload = (await response.json()) as {
        data?: EtfShareClass;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error ?? "The custom ETF could not be saved.");
      }
      setSavedEtf(payload.data);
      setTicker("");
      await onCatalogChanged();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The custom ETF could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (sourceLoading) {
    return (
      <section className="panel creator-loading" aria-live="polite">
        <span className="spinner" />
        Loading the selected ETF universe…
      </section>
    );
  }

  return (
    <div className="creator-workspace" id="etf-creator">
      <section className="creator-hero">
        <div>
          <span className="eyebrow">Rules-based construction</span>
          <h1>ETF Creator</h1>
          <p>
            Start with any registered ETF, apply geography, sector and overlap
            rules, then curate the remaining securities before freezing a
            synthetic ETF.
          </p>
          <div className="creator-source-selector">
            <EtfSearch
              catalog={catalog}
              selectedId={sourceEtfId}
              label="Base ETF universe"
              onSelect={changeSourceEtf}
            />
            <small>
              ACWI is selected by default as the general free-float universe.
            </small>
          </div>
        </div>
        <div className="creator-source-card">
          <span>Source universe</span>
          <strong>{source?.etf.ticker ?? "—"}</strong>
          <small>
            {source ? `${formatDate(source.asOf)} · ${source.cacheTtlHours}h cache` : "Unavailable"}
          </small>
        </div>
      </section>

      {error ? <div className="alert alert--error">{error}</div> : null}

      <section className="creator-filter-grid">
        <article className="panel creator-filter-panel">
          <div className="creator-filter-heading">
            <div>
              <span className="creator-step">01</span>
              <h2>Geography</h2>
            </div>
            <ToggleMode value={countryMode} onChange={setCountryMode} />
          </div>
          <p>Choose countries to keep or remove from the selected ETF universe.</p>
          <FilterOptions
            options={countriesOptions}
            selected={countries}
            onChange={setCountries}
            emptyLabel="No countries available."
          />
        </article>

        <article className="panel creator-filter-panel">
          <div className="creator-filter-heading">
            <div>
              <span className="creator-step">02</span>
              <h2>Sectors</h2>
            </div>
            <ToggleMode value={sectorMode} onChange={setSectorMode} />
          </div>
          <p>Apply a keep or exclusion rule to GICS sector classifications.</p>
          <FilterOptions
            options={sectorOptions}
            selected={sectors}
            onChange={setSectors}
            emptyLabel="No sectors available."
          />
        </article>

        <article className="panel creator-filter-panel creator-overlap-panel">
          <div className="creator-filter-heading">
            <div>
              <span className="creator-step">03</span>
              <h2>ETF overlap</h2>
            </div>
          </div>
          <p>Keep only, or remove, securities also held by another ETF.</p>
          <div className="creator-overlap-modes">
            {(["none", "include", "exclude"] as CreatorOverlapMode[]).map(
              (mode) => (
                <button
                  type="button"
                  key={mode}
                  className={overlapMode === mode ? "is-active" : ""}
                  aria-pressed={overlapMode === mode}
                  onClick={() => {
                    setOverlapMode(mode);
                    setOverlapSnapshot(null);
                    setOverlapLoading(mode !== "none");
                  }}
                >
                  {mode === "none" ? "No rule" : mode === "include" ? "Keep overlap" : "Remove overlap"}
                </button>
              ),
            )}
          </div>
          {overlapMode !== "none" ? (
            <EtfSearch
              catalog={overlapCatalog}
              selectedId={overlapEtfId}
              label="Reference ETF"
              onSelect={(etfId) => {
                setOverlapSnapshot(null);
                setOverlapEtfId(etfId);
              }}
            />
          ) : (
            <div className="creator-no-overlap">
              All securities from the base ETF pass this step.
            </div>
          )}
          <div className="creator-overlap-status" aria-live="polite">
            {overlapLoading ? (
              <><span className="spinner" /> Loading reference holdings…</>
            ) : overlapSnapshot ? (
              <>
                <strong>{overlapSecurityIds.size}</strong> reference holdings · as of {formatDate(overlapSnapshot.asOf)}
              </>
            ) : null}
          </div>
        </article>
      </section>

      <section className="creator-metrics" aria-label="ETF preview metrics">
        <article>
          <span>Selected securities</span>
          <strong>{selectedHoldings.length}</strong>
          <small>of {sourceEquities.length} base ETF equities</small>
        </article>
        <article>
          <span>Original source weight</span>
          <strong>{formatPercent(sourceWeight)}</strong>
          <small>before normalization</small>
        </article>
        <article>
          <span>Normalized total</span>
          <strong>{normalized.length ? "100.00%" : "0.00%"}</strong>
          <small>free-float weighted</small>
        </article>
        <article>
          <span>Top 10 concentration</span>
          <strong>{formatPercent(top10Weight)}</strong>
          <small>{representedCountries} countries represented</small>
        </article>
      </section>

      <section className="creator-review-grid">
        <article className="panel creator-holdings-panel">
          <div className="panel-heading creator-review-heading">
            <div>
              <span className="eyebrow">Step 4 · manual curation</span>
              <h2>Review constituents</h2>
              <p>
                Search the full base universe to add securities outside the
                rules or remove rule matches.
              </p>
            </div>
            <div className="creator-review-actions">
              <label>
                <span className="sr-only">Search all base ETF securities</span>
                <input
                  type="search"
                  value={resultQuery}
                  placeholder="Ticker or company"
                  onChange={(event) => setResultQuery(event.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  setManualInclusions(
                    new Set(sourceEquities.map((holding) => holding.securityId)),
                  );
                  setManualExclusions(new Set());
                }}
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => {
                  setManualInclusions(new Set());
                  setManualExclusions(
                    new Set(sourceEquities.map((holding) => holding.securityId)),
                  );
                }}
              >
                Clear all
              </button>
              <button type="button" onClick={resetFilters}>Reset</button>
            </div>
          </div>
          <div className="creator-holdings-table">
            <div className="creator-holdings-header">
              <span>Keep</span>
              <span>Security</span>
              <span>Country / sector</span>
                <span>{source?.etf.ticker ?? "Source"}</span>
              <span>New weight</span>
            </div>
            {visibleHoldings.slice(0, 250).map((holding) => (
              <label className="creator-holding-row" key={holding.securityId}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(holding.securityId)}
                  onChange={(event) =>
                    updateManualSelection(
                      holding.securityId,
                      event.target.checked,
                    )
                  }
                />
                <span className="creator-security">
                  <strong>{holding.ticker}</strong>
                  <small>{holding.name}</small>
                  {!automaticIds.has(holding.securityId) &&
                  selectedIds.has(holding.securityId) ? (
                    <em>Added manually</em>
                  ) : null}
                </span>
                <span className="creator-classification">
                  <strong>{holding.country}</strong>
                  <small>{holding.sector}</small>
                </span>
                <span>{formatPercent(holding.weight, 3)}</span>
                <strong>
                  {selectedIds.has(holding.securityId)
                    ? formatPercent(normalizedWeights.get(holding.securityId) ?? 0, 3)
                    : "Excluded"}
                </strong>
              </label>
            ))}
            {visibleHoldings.length === 0 ? (
              <div className="creator-empty-selection">
                No base ETF security matches this search.
              </div>
            ) : null}
          </div>
          {visibleHoldings.length > 250 ? (
            <p className="creator-table-note">
              Showing the first 250 of {visibleHoldings.length} base securities.
              Use search to find another constituent.
            </p>
          ) : null}
          <aside className="creator-recipe" aria-label="Final recipe applied">
            <div className="creator-recipe-heading">
              <div>
                <span className="eyebrow">Final recipe applied</span>
                <strong>{selectedHoldings.length} securities selected</strong>
              </div>
              <small>{automaticSelection.length} from rules</small>
            </div>
            <dl>
              <div>
                <dt>Geography</dt>
                <dd>
                  {countries.length === 0
                    ? "No filter"
                    : `${countryMode === "include" ? "Keep" : "Exclude"} ${countries.join(", ")}`}
                </dd>
              </div>
              <div>
                <dt>Sectors</dt>
                <dd>
                  {sectors.length === 0
                    ? "No filter"
                    : `${sectorMode === "include" ? "Keep" : "Exclude"} ${sectors.join(", ")}`}
                </dd>
              </div>
              <div>
                <dt>Overlap</dt>
                <dd>
                  {overlapMode === "none"
                    ? "No rule"
                    : `${overlapMode === "include" ? "Keep" : "Remove"} overlap with ${overlapEtf?.ticker ?? "reference ETF"}`}
                </dd>
              </div>
              <div>
                <dt>Manual</dt>
                <dd>
                  <span className="creator-recipe-addition">
                    +{effectiveManualInclusions.length} added
                  </span>
                  <span className="creator-recipe-removal">
                    −{effectiveManualExclusions.length} removed
                  </span>
                </dd>
              </div>
            </dl>
            {effectiveManualInclusions.length > 0 ||
            effectiveManualExclusions.length > 0 ? (
              <p>
                {effectiveManualInclusions.length > 0
                  ? `Added: ${effectiveManualInclusions
                      .slice(0, 6)
                      .map((holding) => holding.ticker)
                      .join(", ")}${effectiveManualInclusions.length > 6 ? ` +${effectiveManualInclusions.length - 6}` : ""}. `
                  : ""}
                {effectiveManualExclusions.length > 0
                  ? `Removed: ${effectiveManualExclusions
                      .slice(0, 6)
                      .map((holding) => holding.ticker)
                      .join(", ")}${effectiveManualExclusions.length > 6 ? ` +${effectiveManualExclusions.length - 6}` : ""}.`
                  : ""}
              </p>
            ) : null}
          </aside>
        </article>

        <article className="panel creator-save-panel">
          <div>
            <span className="eyebrow">Step 5 · freeze definition</span>
            <h2>Save to supported ETFs</h2>
            <p>
              The constituent list and normalized weights are frozen at save
              time. Future changes in the selected source ETF will not alter
              this ETF.
            </p>
          </div>
          <div className="creator-save-fields">
            <label className="field">
              <span>Ticker</span>
              <input
                value={ticker}
                maxLength={10}
                placeholder="MYETF"
                onChange={(event) => setTicker(event.target.value.toUpperCase())}
              />
            </label>
            <label className="field">
              <span>ETF name</span>
              <input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field creator-description-field">
              <span>Description (optional)</span>
              <textarea
                value={description}
                maxLength={240}
                placeholder="Investment objective or selection rationale"
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
          <div className="creator-definition-summary">
            <span><b>{selectedHoldings.length}</b> frozen constituents</span>
            <span><b>100%</b> normalized weight</span>
            <span><b>{source ? formatDate(source.asOf) : "—"}</b> {source?.etf.ticker ?? "Source"} snapshot</span>
          </div>
          <button
            className="primary-button creator-save-button"
            type="button"
            disabled={saving || selectedHoldings.length === 0}
            onClick={save}
          >
            {saving ? <span className="spinner" /> : null}
            {saving ? "Saving ETF…" : "Save custom ETF"}
          </button>
          {savedEtf ? (
            <div className="saved-etf-success">
              {savedEtf.ticker} is now available in the supported ETF list with its frozen source weights.
            </div>
          ) : null}
        </article>
      </section>
      <LocalEtfManager
        catalog={catalog}
        fundType="custom"
        onCatalogChanged={onCatalogChanged}
        onDeleted={(etfId) => {
          if (sourceEtfId === etfId) {
            const replacement = sourceEtfs.find(
              (etf) => etf.id !== etfId && etf.id === "acwi-us",
            ) ?? sourceEtfs.find((etf) => etf.id !== etfId);
            if (replacement) changeSourceEtf(replacement.id);
          }
          if (overlapEtfId === etfId) {
            setOverlapMode("none");
            setOverlapSnapshot(null);
            setOverlapLoading(false);
            setOverlapEtfId(
              overlapEtfs.find((etf) => etf.id !== etfId)?.id ?? "",
            );
          }
        }}
      />
    </div>
  );
}
