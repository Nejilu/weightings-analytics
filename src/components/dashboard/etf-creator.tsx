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
import type { LocalEtfDetail } from "@/domain/local-etf";

import { EtfSearch } from "./etf-search";

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
  const customEtfs = useMemo(
    () => sourceEtfs.filter((etf) => etf.fundType === "custom"),
    [sourceEtfs],
  );
  const defaultSourceEtfId =
    sourceEtfs.find((etf) => etf.id === "acwi-us")?.id ?? sourceEtfs[0]?.id ?? "";
  const [sourceEtfId, setSourceEtfId] = useState(defaultSourceEtfId);
  const [workflowMode, setWorkflowMode] = useState<"create" | "edit">("create");
  const [editingEtfId, setEditingEtfId] = useState("");
  const [definitionLoading, setDefinitionLoading] = useState(false);
  const [pendingEditSelection, setPendingEditSelection] = useState<{
    sourceEtfId: string;
    selectedIds: Set<string>;
  } | null>(null);
  const [editUnavailableSelectedIds, setEditUnavailableSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [compositionDirty, setCompositionDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  useEffect(() => {
    if (
      workflowMode !== "edit" ||
      !pendingEditSelection ||
      pendingEditSelection.sourceEtfId !== sourceEtfId ||
      source?.etf.id !== sourceEtfId ||
      sourceLoading ||
      (overlapMode !== "none" &&
        overlapSnapshot?.etf.id !== overlapEtfId)
    ) return;

    queueMicrotask(() => {
      const selectedIds = pendingEditSelection.selectedIds;
      setManualInclusions(
        new Set([...selectedIds].filter((id) => !automaticIds.has(id))),
      );
      setManualExclusions(
        new Set([...automaticIds].filter((id) => !selectedIds.has(id))),
      );
      setPendingEditSelection(null);
      setCompositionDirty(false);
    });
  }, [
    automaticIds,
    overlapMode,
    overlapSnapshot,
    pendingEditSelection,
    source,
    sourceEtfId,
    sourceLoading,
    overlapEtfId,
    workflowMode,
  ]);
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
  const previewNormalizedWeights = normalizedWeights;
  const previewTop10Weight = top10Weight;
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
    setCompositionDirty(true);
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
    setCompositionDirty(true);
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
    setCompositionDirty(true);
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

  const startCreateMode = () => {
    setWorkflowMode("create");
    setEditingEtfId("");
    setConfirmDelete(false);
    setPendingEditSelection(null);
    setEditUnavailableSelectedIds(new Set());
    setCompositionDirty(false);
    setTicker("");
    setName("My Custom ETF");
    setDescription("");
    setSavedEtf(null);
    changeSourceEtf(defaultSourceEtfId);
    setCompositionDirty(false);
  };

  const loadEditableEtf = async (etfId: string) => {
    if (!etfId) return;
    setDefinitionLoading(true);
    setError(null);
    setSavedEtf(null);
    setConfirmDelete(false);
    try {
      const response = await fetch(
        `/api/v1/local-etfs/${encodeURIComponent(etfId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as {
        data?: LocalEtfDetail;
        error?: string;
      };
      if (!response.ok || !payload.data || payload.data.kind !== "custom") {
        throw new Error(payload.error ?? "The custom ETF could not be loaded.");
      }
      const detail = payload.data;
      setWorkflowMode("edit");
      setEditingEtfId(detail.etf.id);
      setTicker(detail.etf.ticker);
      setName(detail.etf.name);
      setDescription(detail.editableDescription);
      setCountryMode(detail.criteria.countryMode);
      setCountries(detail.criteria.countries);
      setSectorMode(detail.criteria.sectorMode);
      setSectors(detail.criteria.sectors);
      setOverlapMode(detail.criteria.overlapMode);
      setOverlapEtfId(detail.criteria.overlapEtfId ?? overlapEtfs[0]?.id ?? "");
      setOverlapSnapshot(null);
      setOverlapLoading(detail.criteria.overlapMode !== "none");
      setManualInclusions(new Set());
      setManualExclusions(new Set());
      setSourceEtfId(detail.sourceEtfId);
      setPendingEditSelection({
        sourceEtfId: detail.sourceEtfId,
        selectedIds: new Set(detail.selectedSecurityIds),
      });
      const availableIds = new Set(
        detail.holdings.map((holding) => holding.securityId),
      );
      setEditUnavailableSelectedIds(
        new Set(
          detail.selectedSecurityIds.filter(
            (securityId) => !availableIds.has(securityId),
          ),
        ),
      );
      setCompositionDirty(false);
      setResultQuery("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The custom ETF could not be loaded.",
      );
    } finally {
      setDefinitionLoading(false);
    }
  };

  const deleteEditingEtf = async () => {
    if (!editingEtfId) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDefinitionLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/local-etfs/${encodeURIComponent(editingEtfId)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "The custom ETF could not be deleted.");
      }
      await onCatalogChanged();
      startCreateMode();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The custom ETF could not be deleted.",
      );
    } finally {
      setDefinitionLoading(false);
    }
  };

  const save = async () => {
    if (pendingEditSelection || source?.etf.id !== sourceEtfId) {
      setError("Wait for the saved ETF definition to finish loading before updating it.");
      return;
    }
    if (overlapMode !== "none" && !overlapSnapshot) {
      setError("Wait for the overlap ETF holdings before saving.");
      return;
    }
    setSaving(true);
    setSavedEtf(null);
    setError(null);
    try {
      const isEditing = workflowMode === "edit" && editingEtfId;
      const response = await fetch(
        isEditing
          ? `/api/v1/local-etfs/${encodeURIComponent(editingEtfId)}`
          : "/api/v1/etf-creator",
        {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          name,
          description,
          selectedSecurityIds: [
            ...selectedHoldings.map((holding) => holding.securityId),
            ...(!compositionDirty ? editUnavailableSelectedIds : []),
          ],
          sourceEtfId,
          criteria,
          ...(isEditing ? { kind: "custom" } : {}),
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
      await onCatalogChanged();
      if (isEditing) {
        await loadEditableEtf(payload.data.id);
        setSavedEtf(payload.data);
      } else {
        setTicker("");
      }
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

  if (sourceLoading && !source) {
    return (
      <section className="panel creator-loading" aria-live="polite">
        <span className="spinner" />
        Loading the selected ETF universe…
      </section>
    );
  }

  return (
    <div className="creator-workspace" id="etf-creator">
      <section className="panel local-etf-workflow-switcher">
        <div>
          <span className="eyebrow">ETF definition</span>
          <h2>{workflowMode === "edit" ? "Edit an existing ETF" : "Create a new ETF"}</h2>
          <p>
            Editing reloads the original source, rules and manual curation.
            Weights always follow the latest available source snapshot.
          </p>
        </div>
        <div className="local-etf-workflow-controls">
          <div className="local-etf-mode-toggle" aria-label="Creator mode">
            <button
              type="button"
              className={workflowMode === "create" ? "is-active" : ""}
              onClick={startCreateMode}
            >
              Create new
            </button>
            <button
              type="button"
              className={workflowMode === "edit" ? "is-active" : ""}
              disabled={customEtfs.length === 0}
              onClick={() => {
                const nextId = editingEtfId || customEtfs[0]?.id || "";
                setWorkflowMode("edit");
                setEditingEtfId(nextId);
                if (nextId) void loadEditableEtf(nextId);
              }}
            >
              Edit existing
            </button>
          </div>
          {workflowMode === "edit" ? (
            <label className="local-etf-picker">
              <span>Custom ETF</span>
              <select
                value={editingEtfId}
                disabled={definitionLoading}
                onChange={(event) => void loadEditableEtf(event.target.value)}
              >
                {customEtfs.map((etf) => (
                  <option key={etf.id} value={etf.id}>
                    {etf.ticker} · {etf.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {workflowMode === "edit" ? (
            <div className="local-etf-delete-control">
              {confirmDelete ? <span>This removes the ETF definition and its saved snapshots.</span> : null}
              <button
                type="button"
                className={confirmDelete ? "is-confirming" : ""}
                disabled={definitionLoading}
                onClick={() => void deleteEditingEtf()}
              >
                {definitionLoading
                  ? "Working…"
                  : confirmDelete
                    ? "Confirm delete"
                    : "Delete ETF"}
              </button>
              {confirmDelete ? (
                <button type="button" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
      <section className="creator-hero">
        <div>
          <span className="eyebrow">Rules-based construction</span>
          <h1>ETF Creator</h1>
          <p>
            Start with any registered ETF, apply geography, sector and overlap
            rules, then curate the securities used by a dynamically weighted
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
            <ToggleMode
              value={countryMode}
              onChange={(value) => {
                setCountryMode(value);
                setCompositionDirty(true);
              }}
            />
          </div>
          <p>Choose countries to keep or remove from the selected ETF universe.</p>
          <FilterOptions
            options={countriesOptions}
            selected={countries}
            onChange={(values) => {
              setCountries(values);
              setCompositionDirty(true);
            }}
            emptyLabel="No countries available."
          />
        </article>

        <article className="panel creator-filter-panel">
          <div className="creator-filter-heading">
            <div>
              <span className="creator-step">02</span>
              <h2>Sectors</h2>
            </div>
            <ToggleMode
              value={sectorMode}
              onChange={(value) => {
                setSectorMode(value);
                setCompositionDirty(true);
              }}
            />
          </div>
          <p>Apply a keep or exclusion rule to GICS sector classifications.</p>
          <FilterOptions
            options={sectorOptions}
            selected={sectors}
            onChange={(values) => {
              setSectors(values);
              setCompositionDirty(true);
            }}
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
                    setCompositionDirty(true);
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
                setCompositionDirty(true);
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
          <strong>{formatPercent(previewTop10Weight)}</strong>
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
                  setCompositionDirty(true);
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
                  setCompositionDirty(true);
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
                    ? formatPercent(previewNormalizedWeights.get(holding.securityId) ?? 0, 3)
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
            <span className="eyebrow">Step 5 · dynamic definition</span>
            <h2>{workflowMode === "edit" ? "Update this ETF" : "Save to supported ETFs"}</h2>
            <p>
              The selected constituent list is saved. Its available free-float
              weights are recalculated and normalized from the latest source
              snapshot whenever this ETF is read.
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
            <span><b>{selectedHoldings.length}</b> selected constituents</span>
            <span><b>100%</b> dynamically normalized</span>
            <span><b>{source ? formatDate(source.asOf) : "—"}</b> current {source?.etf.ticker ?? "source"} snapshot</span>
          </div>
          <button
            className="primary-button creator-save-button"
            type="button"
            disabled={
              saving ||
              definitionLoading ||
              sourceLoading ||
              Boolean(pendingEditSelection) ||
              selectedHoldings.length === 0
            }
            onClick={save}
          >
            {saving ? <span className="spinner" /> : null}
            {saving
              ? "Saving ETF…"
              : workflowMode === "edit"
                ? "Update custom ETF"
                : "Save custom ETF"}
          </button>
          {savedEtf ? (
            <div className="saved-etf-success">
              {savedEtf.ticker} {workflowMode === "edit" ? "was updated" : "is now available in the supported ETF list"} with dynamic source weights.
            </div>
          ) : null}
        </article>
      </section>
    </div>
  );
}
