"use client";

import { useEffect, useMemo, useState } from "react";

import type { CatalogGroup, EtfShareClass } from "@/domain/etf";
import type { LocalEtfDetail } from "@/domain/local-etf";
import {
  SUPPORTED_CASH_CURRENCIES,
  type PortfolioCashPosition,
  type PortfolioExposureMode,
  type MarketPrice,
  type PortfolioAssetKind,
  type PortfolioInputMode,
  type PortfolioItem,
  type PortfolioRecord,
} from "@/domain/portfolio";
import { EtfSearch } from "./etf-search";

interface PortfolioAnalyticsProps {
  catalog: CatalogGroup[];
  onCatalogChanged: () => Promise<void>;
}

interface SecuritySearchResult {
  securityId: string;
  ticker: string;
  name: string;
  sector: string;
  country: string;
  quoteSymbol?: string;
  instrumentType?: "ADR" | "GDR";
  underlyingTicker?: string;
}

interface CompositionRow {
  id: string;
  kind: "security" | "cash" | "financing";
  ticker: string;
  name: string;
  weight: number;
  sources: Array<{ id: string; label: string; weight: number }>;
}

function formatPercent(value: number, digits = 2) {
  return `${value.toFixed(digits)}%`;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(value);
}

function createItemId() {
  return globalThis.crypto?.randomUUID?.() ??
    `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function PortfolioAnalytics({
  catalog,
  onCatalogChanged,
}: PortfolioAnalyticsProps) {
  const sourceCatalog = useMemo(
    () =>
      catalog
        .map((benchmark) => ({
          ...benchmark,
          variants: benchmark.variants.filter(
            (etf) =>
              etf.fundType !== "portfolio" && etf.fundType !== "custom",
          ),
        }))
        .filter((benchmark) => benchmark.variants.length > 0),
    [catalog],
  );
  const etfs = useMemo(
    () => sourceCatalog.flatMap((benchmark) => benchmark.variants),
    [sourceCatalog],
  );
  const portfolioEtfs = useMemo(
    () =>
      catalog
        .flatMap((benchmark) => benchmark.variants)
        .filter((etf) => etf.fundType === "portfolio"),
    [catalog],
  );
  const [workflowMode, setWorkflowMode] = useState<"create" | "edit">("create");
  const [editingEtfId, setEditingEtfId] = useState("");
  const [definitionLoading, setDefinitionLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [items, setItems] = useState<PortfolioItem[]>([]);
  const [cashPositions, setCashPositions] = useState<PortfolioCashPosition[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioRecord | null>(null);
  const [kind, setKind] = useState<PortfolioAssetKind>("etf");
  const [selectedEtfId, setSelectedEtfId] = useState(etfs[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SecuritySearchResult[]>([]);
  const [selectedSecurity, setSelectedSecurity] =
    useState<SecuritySearchResult | null>(null);
  const [inputMode, setInputMode] = useState<PortfolioInputMode>("value");
  const [inputAmount, setInputAmount] = useState("1000");
  const [cashCurrency, setCashCurrency] = useState<PortfolioCashPosition["currency"]>("USD");
  const [cashAmount, setCashAmount] = useState("1000");
  const [exposureMode, setExposureMode] =
    useState<PortfolioExposureMode>("gross-normalized");
  const [quote, setQuote] = useState<MarketPrice | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [resultFilter, setResultFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEtf, setSavingEtf] = useState(false);
  const [savedEtf, setSavedEtf] = useState<EtfShareClass | null>(null);
  const [etfTicker, setEtfTicker] = useState("");
  const [etfName, setEtfName] = useState("My Portfolio ETF");
  const [etfDescription, setEtfDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const applyPortfolioRecord = (record: PortfolioRecord) => {
    setPortfolio(record);
    setItems(record.items);
    setCashPositions(record.cashPositions ?? []);
  };

  const loadDefaultPortfolio = async () => {
    setDefinitionLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/portfolio", { cache: "no-store" });
      const payload = (await response.json()) as {
        data?: PortfolioRecord;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error ?? "The saved portfolio could not be loaded.");
      }
      applyPortfolioRecord(payload.data);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The saved portfolio could not be loaded.",
      );
    } finally {
      setDefinitionLoading(false);
    }
  };

  const startCreateMode = () => {
    setWorkflowMode("create");
    setEditingEtfId("");
    setConfirmDelete(false);
    setEtfTicker("");
    setEtfName("My Portfolio ETF");
    setEtfDescription("");
    setSavedEtf(null);
    void loadDefaultPortfolio();
  };

  const loadEditablePortfolioEtf = async (etfId: string) => {
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
      if (!response.ok || !payload.data || payload.data.kind !== "portfolio") {
        throw new Error(payload.error ?? "The portfolio ETF could not be loaded.");
      }
      setWorkflowMode("edit");
      setEditingEtfId(payload.data.etf.id);
      setEtfTicker(payload.data.etf.ticker);
      setEtfName(payload.data.etf.name);
      setEtfDescription(payload.data.editableDescription);
      applyPortfolioRecord(payload.data.portfolio);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The portfolio ETF could not be loaded.",
      );
    } finally {
      setDefinitionLoading(false);
    }
  };

  const deleteEditingPortfolioEtf = async () => {
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
        throw new Error(payload.error ?? "The portfolio ETF could not be deleted.");
      }
      await onCatalogChanged();
      startCreateMode();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The portfolio ETF could not be deleted.",
      );
    } finally {
      setDefinitionLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/v1/portfolio", { cache: "no-store" });
        const payload = (await response.json()) as {
          data?: PortfolioRecord;
          error?: string;
        };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error ?? "The saved portfolio could not be loaded.");
        }
        if (active) {
          applyPortfolioRecord(payload.data);
        }
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "The saved portfolio could not be loaded.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      kind !== "security" ||
      query.trim().length < 2 ||
      selectedSecurity
    ) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/v1/securities/search?q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        );
        const payload = (await response.json()) as {
          data?: SecuritySearchResult[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error ?? "Security search is unavailable.");
        }
        setSearchResults(payload.data ?? []);
      } catch (searchError) {
        if (!controller.signal.aborted) {
          setSearchResults([]);
          setError(
            searchError instanceof Error
              ? searchError.message
              : "Security search is unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [kind, query, selectedSecurity]);

  const selectedEtf =
    kind === "etf"
      ? etfs.find((etf) => etf.id === selectedEtfId)
      : undefined;
  const selectedHoldingsSourceEtf = selectedEtf?.holdingsSourceEtfId
    ? etfs.find((etf) => etf.id === selectedEtf.holdingsSourceEtfId)
    : undefined;
  const selectedReferenceId =
    kind === "etf" ? selectedEtfId : selectedSecurity?.securityId;

  useEffect(() => {
    if (!selectedReferenceId) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setQuoteLoading(true);
        setQuoteError(null);
      }
    });
    void (async () => {
      try {
        const response = await fetch(
          `/api/v1/prices/quote?kind=${kind}&referenceId=${encodeURIComponent(selectedReferenceId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = (await response.json()) as {
          data?: MarketPrice;
          error?: string;
        };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error ?? "The market price is unavailable.");
        }
        setQuote(payload.data);
      } catch (quoteLoadError) {
        if (!controller.signal.aborted) {
          setQuote(null);
          setQuoteError(
            quoteLoadError instanceof Error
              ? quoteLoadError.message
              : "The market price is unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setQuoteLoading(false);
      }
    })();
    return () => controller.abort();
  }, [kind, selectedReferenceId]);
  const activeQuote =
    quote?.assetKind === kind && quote.assetId === selectedReferenceId
      ? quote
      : null;
  const activeQuoteLoading = Boolean(selectedReferenceId) && quoteLoading;

  const draftPositionsValue = items.reduce(
    (sum, item) =>
      sum +
      (Number.isFinite(item.currentValueUsd)
        ? Number(item.currentValueUsd)
        : (item.quantity ?? 0) * (item.currentPriceUsd ?? 0)),
    0,
  );
  const draftCashValue = cashPositions.reduce(
    (sum, position) =>
      sum +
      (Number.isFinite(position.valueUsd)
        ? Number(position.valueUsd)
        : position.amount * (position.fxToUsd ?? 0)),
    0,
  );
  const draftMarketValue = draftPositionsValue + draftCashValue;
  const normalizedItems = useMemo(
    () =>
      items.map((item) => {
        const currentValueUsd =
          item.currentValueUsd ??
          (item.quantity ?? 0) * (item.currentPriceUsd ?? 0);
        return {
          ...item,
          currentValueUsd,
          allocationWeight:
            draftMarketValue > 0 ? (currentValueUsd / draftMarketValue) * 100 : 0,
        };
      }),
    [items, draftMarketValue],
  );
  const hasUnsavedChanges =
    JSON.stringify({
      items:
      normalizedItems.map(({ id, kind: itemKind, referenceId, quantity }) => ({
        id,
        kind: itemKind,
        referenceId,
        quantity,
      })),
      cashPositions: cashPositions.map(({ currency, amount }) => ({ currency, amount })),
    }) !==
    JSON.stringify({
      items:
      (portfolio?.items ?? []).map(
        ({ id, kind: itemKind, referenceId, quantity }) => ({
          id,
          kind: itemKind,
          referenceId,
          quantity,
        }),
      ),
      cashPositions: (portfolio?.cashPositions ?? []).map(({ currency, amount }) => ({
        currency,
        amount,
      })),
    });

  const addItem = () => {
    const numericAmount = Number(inputAmount);
    if (!Number.isFinite(numericAmount) || numericAmount === 0) {
      setError(
        inputMode === "value"
          ? "Enter a non-zero position value. Use a negative value for a short."
          : "Enter a non-zero share quantity. Use a negative quantity for a short.",
      );
      return;
    }

    const etfSelection = selectedEtf;
    const securitySelection = kind === "security" ? selectedSecurity : null;
    if (!etfSelection && !securitySelection) {
      setError(
        kind === "etf"
          ? "Select an ETF."
          : "Select a security from the ACWI search results.",
      );
      return;
    }

    const referenceId =
      kind === "etf" ? etfSelection!.id : securitySelection!.securityId;
    const ticker =
      kind === "etf" ? etfSelection!.ticker : securitySelection!.ticker;
    const name =
      kind === "etf" ? etfSelection!.name : securitySelection!.name;
    const existing = items.find(
      (item) => item.kind === kind && item.referenceId === referenceId,
    );
    if (existing) {
      setError(`${ticker} is already in the portfolio. Edit its shares below.`);
      return;
    }
    if (!activeQuote || activeQuote.assetId !== referenceId) {
      setError(quoteError ?? "Wait for a current market price before adding this position.");
      return;
    }
    const quantity =
      inputMode === "shares" ? numericAmount : numericAmount / activeQuote.priceUsd;
    const currentValueUsd = quantity * activeQuote.priceUsd;

    setItems((current) =>
      [
        ...current,
        {
          id: createItemId(),
          kind,
          referenceId,
          ticker,
          name,
          allocationWeight: 0,
          inputMode,
          inputAmount: numericAmount,
          quantity,
          initialPriceUsd: activeQuote.priceUsd,
          initialValueUsd: currentValueUsd,
          priceSymbol: activeQuote.providerSymbol,
          priceCurrency: activeQuote.currency,
          currentPrice: activeQuote.price,
          currentPriceUsd: activeQuote.priceUsd,
          currentValueUsd,
          priceAsOf: activeQuote.asOf,
          priceStatus: activeQuote.sourceStatus,
        },
      ],
    );
    setError(null);
    if (kind === "security") {
      setQuery("");
      setSelectedSecurity(null);
      setSearchResults([]);
    }
  };

  const addCashPosition = () => {
    const amount = Number(cashAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      setError("Enter a non-zero cash amount. Use a negative amount for borrowing.");
      return;
    }
    if (cashPositions.some((position) => position.currency === cashCurrency)) {
      setError(`${cashCurrency} cash already exists. Edit the existing line instead.`);
      return;
    }
    setCashPositions((current) => [...current, { currency: cashCurrency, amount }]);
    setError(null);
  };

  const save = async () => {
    if (normalizedItems.some((item) => !item.quantity || !Number.isFinite(item.quantity))) {
      setError("Every security line must have a non-zero share quantity.");
      return;
    }
    if (cashPositions.some((position) => !position.amount || !Number.isFinite(position.amount))) {
      setError("Every cash line must have a non-zero amount.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const isEditing = workflowMode === "edit" && editingEtfId;
      const response = await fetch(
        isEditing
          ? `/api/v1/local-etfs/${encodeURIComponent(editingEtfId)}`
          : "/api/v1/portfolio",
        {
        method: isEditing ? "PATCH" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isEditing
            ? {
                kind: "portfolio",
                ticker: etfTicker,
                name: etfName,
                description: etfDescription,
              }
            : {}),
          items: normalizedItems.map(({ id, kind: itemKind, referenceId, quantity }) => ({
            id,
            kind: itemKind,
            referenceId,
            inputMode: "shares",
            inputAmount: quantity,
          })),
          cashPositions: cashPositions.map(({ currency, amount }) => ({
            currency,
            amount,
          })),
        }),
      });
      const payload = (await response.json()) as {
        data?: PortfolioRecord | EtfShareClass;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error ?? "The portfolio could not be saved.");
      }
      if (isEditing) {
        await onCatalogChanged();
        await loadEditablePortfolioEtf(editingEtfId);
      } else {
        applyPortfolioRecord(payload.data as PortfolioRecord);
      }
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The portfolio could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  const saveAsEtf = async () => {
    const isEditing = workflowMode === "edit" && editingEtfId;
    if (!isEditing && hasUnsavedChanges) {
      setError("Save and analyse the portfolio before creating its ETF.");
      return;
    }
    setSavingEtf(true);
    setSavedEtf(null);
    setError(null);
    try {
      const response = await fetch(
        isEditing
          ? `/api/v1/local-etfs/${encodeURIComponent(editingEtfId)}`
          : "/api/v1/portfolio/save-as-etf",
        {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: etfTicker,
          name: etfName,
          description: etfDescription,
          ...(isEditing
            ? {
                kind: "portfolio",
                items: normalizedItems.map(
                  ({ id, kind: itemKind, referenceId, quantity }) => ({
                    id,
                    kind: itemKind,
                    referenceId,
                    inputMode: "shares",
                    inputAmount: quantity,
                  }),
                ),
                cashPositions: cashPositions.map(({ currency, amount }) => ({
                  currency,
                  amount,
                })),
              }
            : {}),
        }),
      });
      const payload = (await response.json()) as {
        data?: EtfShareClass;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error ?? "The portfolio ETF could not be saved.");
      }
      setSavedEtf(payload.data);
      await onCatalogChanged();
      if (isEditing) {
        await loadEditablePortfolioEtf(payload.data.id);
        setSavedEtf(payload.data);
      } else {
        setEtfTicker("");
      }
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The portfolio ETF could not be saved.",
      );
    } finally {
      setSavingEtf(false);
    }
  };

  const compositionRows = useMemo<CompositionRow[]>(() => {
    const analysis = portfolio?.analysis;
    if (!analysis) return [];
    const scale = exposureMode === "gross-normalized" && analysis.grossExposureWeight > 0
      ? 100 / analysis.grossExposureWeight
      : 1;
    const rows: CompositionRow[] = analysis.positions.map((position) => ({
      id: position.securityId,
      kind: "security",
      ticker: position.ticker,
      name: position.name,
      weight: position.weight * scale,
      sources: position.contributions.map((contribution) => ({
        id: contribution.itemId,
        label: contribution.ticker,
        weight: contribution.weight * scale,
      })),
    }));
    if (exposureMode === "net-total") {
      for (const position of portfolio.cashPositions ?? []) {
        rows.push({
          id: `cash:${position.currency}`,
          kind: "cash",
          ticker: position.currency,
          name: "Cash & cash equivalents",
          weight: position.weight ?? 0,
          sources: [{
            id: `cash:${position.currency}`,
            label: position.amount < 0 ? "Borrowed cash" : "Cash",
            weight: position.weight ?? 0,
          }],
        });
      }
      if (Math.abs(analysis.financingWeight) > 0.000001) {
        rows.push({
          id: "cash:implicit-financing",
          kind: "financing",
          ticker: "FIN",
          name: "Implicit leveraged-ETF financing",
          weight: analysis.financingWeight,
          sources: [{
            id: "cash:implicit-financing",
            label: "ETF financing",
            weight: analysis.financingWeight,
          }],
        });
      }
    }
    return rows.sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight));
  }, [portfolio, exposureMode]);

  const filteredPositions = useMemo(() => {
    const normalizedFilter = resultFilter.trim().toLocaleUpperCase("en-US");
    return compositionRows.filter(
      (position) =>
        !normalizedFilter ||
        position.ticker.toLocaleUpperCase("en-US").includes(normalizedFilter) ||
        position.name.toLocaleUpperCase("en-US").includes(normalizedFilter),
    );
  }, [compositionRows, resultFilter]);

  if (loading) {
    return (
      <section className="panel portfolio-loading" aria-live="polite">
        <span className="spinner" />
        Loading your saved portfolio…
      </section>
    );
  }

  const analysis = portfolio?.analysis;
  const maxPositionWeight = compositionRows.reduce(
    (maximum, position) => Math.max(maximum, Math.abs(position.weight)),
    0,
  );
  const exposureScale =
    exposureMode === "gross-normalized" && (analysis?.grossExposureWeight ?? 0) > 0
      ? 100 / (analysis?.grossExposureWeight ?? 100)
      : 1;
  const displayedSectors = analysis
    ? [
        ...analysis.sectors.map((sector) => ({
          ...sector,
          weight: sector.weight * exposureScale,
        })),
        ...(exposureMode === "net-total" && Math.abs(analysis.cashWeight) > 0.000001
          ? [{ sector: "Cash & financing", weight: analysis.cashWeight }]
          : []),
      ].sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight))
    : [];
  const displayedTop10 = compositionRows
    .slice(0, 10)
    .reduce((sum, position) => sum + Math.abs(position.weight), 0);
  const numericInputAmount = Number(inputAmount);
  const previewQuantity =
    activeQuote && numericInputAmount !== 0
      ? inputMode === "shares"
        ? numericInputAmount
        : numericInputAmount / activeQuote.priceUsd
      : 0;
  const previewValueUsd =
    activeQuote && previewQuantity !== 0
      ? previewQuantity * activeQuote.priceUsd
      : 0;

  return (
    <div className="portfolio-workspace" id="portfolio">
      <section className="panel local-etf-workflow-switcher">
        <div>
          <span className="eyebrow">Portfolio ETF definition</span>
          <h2>{workflowMode === "edit" ? "Edit an existing portfolio ETF" : "Create a new portfolio ETF"}</h2>
          <p>
            Editing reloads the saved ETF sleeves, stocks, cash balances and
            share quantities into the same portfolio builder.
          </p>
        </div>
        <div className="local-etf-workflow-controls">
          <div className="local-etf-mode-toggle" aria-label="Portfolio ETF mode">
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
              disabled={portfolioEtfs.length === 0}
              onClick={() => {
                const nextId = editingEtfId || portfolioEtfs[0]?.id || "";
                setWorkflowMode("edit");
                setEditingEtfId(nextId);
                if (nextId) void loadEditablePortfolioEtf(nextId);
              }}
            >
              Edit existing
            </button>
          </div>
          {workflowMode === "edit" ? (
            <label className="local-etf-picker">
              <span>Portfolio ETF</span>
              <select
                value={editingEtfId}
                disabled={definitionLoading}
                onChange={(event) =>
                  void loadEditablePortfolioEtf(event.target.value)
                }
              >
                {portfolioEtfs.map((etf) => (
                  <option key={etf.id} value={etf.id}>
                    {etf.ticker} · {etf.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {workflowMode === "edit" ? (
            <div className="local-etf-delete-control">
              {confirmDelete ? <span>This removes the ETF and its saved portfolio.</span> : null}
              <button
                type="button"
                className={confirmDelete ? "is-confirming" : ""}
                disabled={definitionLoading}
                onClick={() => void deleteEditingPortfolioEtf()}
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
      <section className="portfolio-hero">
        <div>
          <span className="eyebrow">Look-through aggregation</span>
          <h1>Portfolio Analytics</h1>
          <p>
            Combine ETF sleeves and individual ACWI stocks into one synthetic
            portfolio, then see your true security-level ranking.
          </p>
        </div>
        <div className="portfolio-total">
          <span>Draft net asset value</span>
          <strong>{formatUsd(draftMarketValue)}</strong>
          <small>
            {items.length} priced position{items.length === 1 ? "" : "s"} ·{" "}
            {cashPositions.length} cash line{cashPositions.length === 1 ? "" : "s"}
          </small>
        </div>
      </section>

      {error ? <div className="alert alert--error">{error}</div> : null}
      {portfolio?.priceError ? (
        <div className="alert alert--error">{portfolio.priceError}</div>
      ) : null}
      {portfolio?.analysisError ? (
        <div className="alert alert--error">{portfolio.analysisError}</div>
      ) : null}

      <section className="portfolio-builder-grid">
        <article className="panel portfolio-add-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Step 1</span>
              <h2>Add a position</h2>
            </div>
            <span className="info-chip">Max. 50 lines</span>
          </div>

          <div className="asset-kind-tabs" aria-label="Position type">
            <button
              type="button"
              className={kind === "etf" ? "is-active" : ""}
              aria-pressed={kind === "etf"}
              onClick={() => {
                setKind("etf");
                setSearchResults([]);
                setSearching(false);
              }}
            >
              ETF
              <small>Supported funds and accumulating share classes</small>
            </button>
            <button
              type="button"
              className={kind === "security" ? "is-active" : ""}
              aria-pressed={kind === "security"}
              onClick={() => {
                setKind("security");
                setSearchResults([]);
                setSearching(false);
              }}
            >
              Individual stock
              <small>ACWI security universe</small>
            </button>
          </div>

          {kind === "etf" ? (
            <EtfSearch
              catalog={sourceCatalog}
              selectedId={selectedEtfId}
              label="Search ETF or accumulating share class"
              onSelect={setSelectedEtfId}
            />
          ) : (
            <div className="security-search">
              <label className="field">
                <span>Search ACWI constituents</span>
                <input
                  type="search"
                  value={query}
                  placeholder="Ticker or company name"
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedSecurity(null);
                    setSearchResults([]);
                    setSearching(false);
                  }}
                />
              </label>
              {query.trim().length >= 2 && !selectedSecurity ? (
                <div className="security-search-results" role="listbox">
                  {searching ? (
                    <div className="security-search-message">Searching ACWI…</div>
                  ) : searchResults.length > 0 ? (
                    searchResults.map((security) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        key={security.securityId}
                        onClick={() => {
                          setSelectedSecurity(security);
                          setQuery(`${security.ticker} · ${security.name}`);
                          setSearchResults([]);
                          setSearching(false);
                        }}
                      >
                        <strong>{security.ticker}</strong>
                        <span>{security.name}</span>
                        <small>
                          {security.instrumentType && security.quoteSymbol
                            ? `${security.instrumentType} · Yahoo ${security.quoteSymbol} · underlying ${security.underlyingTicker}`
                            : security.sector}
                        </small>
                      </button>
                    ))
                  ) : (
                    <div className="security-search-message">
                      No matching ACWI security.
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <div className="position-input-mode" aria-label="Position entry mode">
            <button
              type="button"
              className={inputMode === "value" ? "is-active" : ""}
              aria-pressed={inputMode === "value"}
              onClick={() => setInputMode("value")}
            >
              Value (USD)
            </button>
            <button
              type="button"
              className={inputMode === "shares" ? "is-active" : ""}
              aria-pressed={inputMode === "shares"}
              onClick={() => setInputMode("shares")}
            >
              Shares
            </button>
          </div>

          <div className="portfolio-add-action">
            <label className="field allocation-field">
              <span>
                {inputMode === "value" ? "Position value" : "Number of shares"}
              </span>
              <span className="position-amount-input">
                {inputMode === "value" ? <b>$</b> : null}
                <input
                  type="number"
                  step={inputMode === "value" ? "0.01" : "0.000001"}
                  value={inputAmount}
                  onChange={(event) => setInputAmount(event.target.value)}
                />
                {inputMode === "shares" ? <b>shares</b> : null}
              </span>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={activeQuoteLoading || !activeQuote}
              onClick={addItem}
            >
              Add position
            </button>
          </div>
          <div className="market-quote-preview" aria-live="polite">
            {activeQuoteLoading ? (
              <span><span className="spinner" /> Loading market price…</span>
            ) : activeQuote ? (
              <>
                <span>
                  {activeQuote.providerSymbol}: <b>{activeQuote.price.toLocaleString("en-US")} {activeQuote.currency}</b>
                  {" · "}{formatUsd(activeQuote.priceUsd)} per share
                </span>
                {previewQuantity !== 0 ? (
                  <strong>
                    {formatQuantity(previewQuantity)} shares · {formatUsd(previewValueUsd)}
                    {previewQuantity < 0 ? " · short" : " · long"}
                  </strong>
                ) : null}
                <small>
                  {activeQuote.sourceStatus} price - cached for up to 24 hours
                  {selectedHoldingsSourceEtf
                    ? ` - ${selectedHoldingsSourceEtf.ticker} look-through holdings`
                    : ""}
                </small>
              </>
            ) : quoteError ? (
              <span className="is-error">{quoteError}</span>
            ) : (
              <span>Select an instrument to load its market price.</span>
            )}
          </div>
        </article>

        <article className="panel portfolio-lines-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Step 2</span>
              <h2>Positions and cash</h2>
            </div>
            <span className="info-chip">{items.length + cashPositions.length} lines</span>
          </div>

          {items.length > 0 ? (
            <div className="portfolio-lines">
              {normalizedItems.map((item) => (
                <div className="portfolio-line" key={item.id}>
                  <span className={`asset-badge ${
                    item.quantity && item.quantity < 0
                      ? "asset-badge--short"
                      : `asset-badge--${item.kind}`
                  }`}>
                    {item.quantity && item.quantity < 0
                      ? `Short ${item.kind === "etf" ? "ETF" : "stock"}`
                      : item.kind === "etf" ? "ETF" : "Stock"}
                  </span>
                  <div className="portfolio-line__identity">
                    <strong>{item.ticker}</strong>
                    <span>{item.name}</span>
                  </div>
                  <div className="portfolio-line__valuation">
                    <span className="shares-input">
                    <input
                      aria-label={`${item.ticker} shares`}
                      type="number"
                      step="0.000001"
                      value={item.quantity ?? ""}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setItems((current) =>
                          current.map((candidate) =>
                            candidate.id === item.id
                              ? {
                                  ...candidate,
                                  inputMode: "shares",
                                  inputAmount: value,
                                  quantity: value,
                                  currentValueUsd:
                                    value * (candidate.currentPriceUsd ?? 0),
                                }
                              : candidate,
                          ),
                        );
                      }}
                    />
                    <b>shares</b>
                    </span>
                    <small>
                      {formatUsd(item.currentValueUsd ?? 0)} ·{" "}
                      {formatPercent(item.allocationWeight)}
                    </small>
                  </div>
                  <button
                    className="remove-line"
                    type="button"
                    aria-label={`Remove ${item.ticker}`}
                    onClick={() =>
                      setItems((current) =>
                        current.filter((candidate) => candidate.id !== item.id),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="portfolio-empty-lines">
              Add an ETF, a stock, or a cash balance to build the portfolio.
            </div>
          )}

          <div className="cash-editor">
            <div className="cash-editor__heading">
              <div>
                <strong>Cash & cash equivalents</strong>
                <span>Positive balance or negative borrowing, converted to USD.</span>
              </div>
              <span className="info-chip">{SUPPORTED_CASH_CURRENCIES.length} currencies</span>
            </div>
            {cashPositions.length > 0 ? (
              <div className="cash-lines">
                {cashPositions.map((position) => (
                  <div className="cash-line" key={position.currency}>
                    <span className={`asset-badge ${position.amount < 0 ? "asset-badge--short" : "asset-badge--cash"}`}>
                      {position.amount < 0 ? "Borrowed" : "Cash"}
                    </span>
                    <strong>{position.currency}</strong>
                    <input
                      aria-label={`${position.currency} cash amount`}
                      type="number"
                      step="0.01"
                      value={position.amount}
                      onChange={(event) => {
                        const amount = Number(event.target.value);
                        setCashPositions((current) =>
                          current.map((candidate) =>
                            candidate.currency === position.currency
                              ? {
                                  ...candidate,
                                  amount,
                                  valueUsd: candidate.fxToUsd !== undefined
                                    ? amount * candidate.fxToUsd
                                    : undefined,
                                }
                              : candidate,
                          ),
                        );
                      }}
                    />
                    <small>
                      {position.valueUsd !== undefined
                        ? `${formatUsd(position.valueUsd)} · ${formatPercent(position.weight ?? 0)}`
                        : "USD value calculated on save"}
                    </small>
                    <button
                      className="remove-line"
                      type="button"
                      aria-label={`Remove ${position.currency} cash`}
                      onClick={() => setCashPositions((current) =>
                        current.filter((candidate) => candidate.currency !== position.currency)
                      )}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="cash-add-row">
              <label className="field">
                <span>Currency</span>
                <select
                  value={cashCurrency}
                  onChange={(event) => setCashCurrency(
                    event.target.value as PortfolioCashPosition["currency"],
                  )}
                >
                  {SUPPORTED_CASH_CURRENCIES.map((currency) => (
                    <option key={currency} value={currency}>{currency}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Cash amount</span>
                <input
                  type="number"
                  step="0.01"
                  value={cashAmount}
                  onChange={(event) => setCashAmount(event.target.value)}
                />
              </label>
              <button className="secondary-button" type="button" onClick={addCashPosition}>
                Add cash
              </button>
            </div>
            <small className="cash-editor__hint">
              Example: USD −100,000 with USD 200,000 of equities produces −100% cash and 200% equity exposure on a USD 100,000 NAV.
            </small>
          </div>

          <div className="portfolio-save-row">
            <span>
              {hasUnsavedChanges
                ? "Unsaved portfolio changes"
                : portfolio
                  ? "Portfolio saved locally"
                  : "Ready to save"}
            </span>
            <button
              className="primary-button"
              type="button"
              disabled={saving || (items.length === 0 && cashPositions.length === 0)}
              onClick={save}
            >
              {saving ? <span className="spinner" /> : "Save & analyse"}
            </button>
          </div>
        </article>
      </section>

      {analysis ? (
        <>
          <section className="panel portfolio-exposure-switch" aria-label="Composition display mode">
            <div>
              <span className="eyebrow">Composition basis</span>
              <h2>
                {exposureMode === "gross-normalized"
                  ? "Equity exposure normalized to 100%"
                  : "Total net exposure including cash"}
              </h2>
              <p>
                {exposureMode === "gross-normalized"
                  ? "Cash is hidden. Long and short look-through positions are scaled by gross absolute equity exposure."
                  : "Every weight uses net asset value: cash, borrowing, long positions and shorts remain signed."}
              </p>
            </div>
            <div className="exposure-mode-toggle" role="group" aria-label="Exposure basis">
              <button
                type="button"
                className={exposureMode === "gross-normalized" ? "is-active" : ""}
                aria-pressed={exposureMode === "gross-normalized"}
                onClick={() => setExposureMode("gross-normalized")}
              >
                Equity normalized
                <small>No cash · gross = 100%</small>
              </button>
              <button
                type="button"
                className={exposureMode === "net-total" ? "is-active" : ""}
                aria-pressed={exposureMode === "net-total"}
                onClick={() => setExposureMode("net-total")}
              >
                Total net exposure
                <small>Cash included · signed weights</small>
              </button>
            </div>
          </section>

          <section className="portfolio-metrics" aria-label="Portfolio metrics">
            <article>
              <span>Net asset value</span>
              <strong>
                {formatUsd(analysis.totalMarketValueUsd ?? draftMarketValue)}
              </strong>
              <small>positions + cash − borrowing</small>
            </article>
            <article>
              <span>Gross equity exposure</span>
              <strong>{formatPercent(analysis.grossExposureWeight)}</strong>
              <small>sum of absolute look-through weights</small>
            </article>
            <article>
              <span>Top 10 concentration</span>
              <strong>{formatPercent(displayedTop10)}</strong>
              <small>on the selected composition basis</small>
            </article>
            <article>
              <span>Cash & financing</span>
              <strong>{formatPercent(analysis.cashWeight)}</strong>
              <small>
                {formatPercent(analysis.explicitCashWeight)} explicit ·{" "}
                {formatPercent(analysis.financingWeight)} ETF financing
              </small>
            </article>
          </section>

          <section className="panel save-portfolio-etf-panel">
            <div className="save-portfolio-etf-copy">
              <span className="eyebrow">Reusable local instrument</span>
              <h2>{workflowMode === "edit" ? "Update this portfolio ETF" : "Save this portfolio as an ETF"}</h2>
              <p>
                IndexLens stores the number of ETF and stock shares, not frozen
                percentages or a frozen holdings list. Component weights are
                recalculated from market prices, and ETF look-through is rebuilt
                from the latest persisted source files whenever it is opened or
                compared.
              </p>
              <div className="component-definition">
                {normalizedItems.map((item) => (
                  <span key={item.id}>
                    <b>{formatQuantity(item.quantity ?? 0)} shares</b>{" "}
                    {item.ticker}
                    <small>
                      {formatUsd(item.currentValueUsd ?? 0)} ·{" "}
                      {formatPercent(item.allocationWeight)} now
                    </small>
                  </span>
                ))}
                {cashPositions.map((position) => (
                  <span key={`cash:${position.currency}`}>
                    <b>{formatQuantity(position.amount)} {position.currency}</b>{" "}
                    {position.amount < 0 ? "borrowed cash" : "cash"}
                    <small>
                      {position.valueUsd !== undefined
                        ? `${formatUsd(position.valueUsd)} · ${formatPercent(position.weight ?? 0)} now`
                        : "valued at the latest FX rate"}
                    </small>
                  </span>
                ))}
              </div>
            </div>
            <div className="save-portfolio-etf-form">
              <div className="saved-etf-fields">
                <label className="field">
                  <span>Local ticker</span>
                  <input
                    value={etfTicker}
                    maxLength={10}
                    placeholder="MYETF"
                    onChange={(event) =>
                      setEtfTicker(event.target.value.toUpperCase())
                    }
                  />
                </label>
                <label className="field">
                  <span>ETF name</span>
                  <input
                    value={etfName}
                    maxLength={80}
                    onChange={(event) => setEtfName(event.target.value)}
                  />
                </label>
              </div>
              <label className="field">
                <span>Investment description (optional)</span>
                <textarea
                  value={etfDescription}
                  maxLength={240}
                  placeholder="Purpose, strategy or investment role…"
                  onChange={(event) => setEtfDescription(event.target.value)}
                />
              </label>
              <div className="save-etf-action">
                <span>
                  {workflowMode === "edit"
                    ? "Updates the selected ETF in place."
                    : hasUnsavedChanges
                      ? "Save the latest changes first."
                      : "Ready for the ETF catalog."}
                </span>
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    savingEtf ||
                    (workflowMode !== "edit" && hasUnsavedChanges) ||
                    (items.length === 0 && cashPositions.length === 0)
                  }
                  onClick={saveAsEtf}
                >
                  {savingEtf ? (
                    <span className="spinner" />
                  ) : workflowMode === "edit" ? (
                    "Update ETF"
                  ) : (
                    "Save as ETF"
                  )}
                </button>
              </div>
              {savedEtf ? (
                <div className="saved-etf-success">
                  <strong>{savedEtf.ticker}</strong>{" "}
                  {workflowMode === "edit"
                    ? "was updated in Saved portfolios."
                    : "is now available in ETF comparison under Saved portfolios."}
                </div>
              ) : null}
            </div>
          </section>

          <section className="portfolio-results-grid">
            <article className="panel synthetic-etf-panel">
              <div className="synthetic-etf-heading">
                <div>
                  <span className="eyebrow">Your synthetic ETF</span>
                  <h2>Real portfolio composition</h2>
                </div>
                <label className="result-search">
                  <span className="sr-only">Filter portfolio holdings</span>
                  <input
                    type="search"
                    value={resultFilter}
                    placeholder="Filter holdings"
                    onChange={(event) => setResultFilter(event.target.value)}
                  />
                </label>
              </div>

              <div className="synthetic-ranking">
                <div className="synthetic-ranking__header">
                  <span>#</span>
                  <span>Security</span>
                  <span>Sources</span>
                  <span>{exposureMode === "gross-normalized" ? "Normalized weight" : "NAV weight"}</span>
                </div>
                {filteredPositions.slice(0, 30).map((position) => {
                  const rank =
                    compositionRows.findIndex(
                      (candidate) => candidate.id === position.id,
                    ) + 1;
                  return (
                    <div className={`synthetic-ranking__row ${position.weight < 0 ? "is-negative" : ""}`} key={position.id}>
                      <span className="synthetic-rank">{rank}</span>
                      <div className="synthetic-security">
                        <strong>{position.ticker}</strong>
                        <span>{position.name}</span>
                        <i aria-hidden="true">
                          <b
                            className={position.weight < 0 ? "is-negative" : ""}
                            style={{
                              width: `${
                                maxPositionWeight > 0
                                  ? (Math.abs(position.weight) / maxPositionWeight) * 100
                                  : 0
                              }%`,
                            }}
                          />
                        </i>
                      </div>
                      <div className="contribution-list">
                        {position.sources.map((source) => (
                          <span key={source.id}>
                            {source.label} {formatPercent(source.weight)}
                          </span>
                        ))}
                      </div>
                      <strong className="synthetic-weight">
                        {formatPercent(position.weight)}
                      </strong>
                    </div>
                  );
                })}
              </div>
            </article>

            <aside className="portfolio-side-panels">
              <article className="panel sector-exposure-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">Look-through allocation</span>
                    <h2>Sector exposure</h2>
                  </div>
                </div>
                <div className="sector-exposure-list">
                  {displayedSectors.slice(0, 8).map((sector) => (
                    <div key={sector.sector}>
                      <span>{sector.sector}</span>
                      <strong>{formatPercent(sector.weight)}</strong>
                      <i aria-hidden="true">
                        <b
                          className={sector.weight < 0 ? "is-negative" : ""}
                          style={{
                            width: `${maxPositionWeight > 0
                              ? Math.min(100, Math.abs(sector.weight))
                              : 0}%`,
                          }}
                        />
                      </i>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel portfolio-sources-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">Underlying files</span>
                    <h2>ETF sources</h2>
                  </div>
                </div>
                {analysis.sources.length > 0 ? (
                  <div className="portfolio-source-list">
                    {analysis.sources.map((source) => (
                      <div key={source.referenceId}>
                        <strong>{source.ticker}</strong>
                        <span>as of {source.asOf}</span>
                        <b>{source.sourceStatus}</b>
                        {source.constituentCoverage ? (
                          <small>
                            Normalization used {source.constituentCoverage.used} of{" "}
                            {source.constituentCoverage.total} configured constituents
                            {source.constituentCoverage.missingTickers.length > 0
                              ? `. Missing from the current ACWI snapshot: ${source.constituentCoverage.missingTickers.join(", ")}.`
                              : "."}
                          </small>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="direct-only-note">
                    Direct-stock portfolio. No ETF file is required.
                  </p>
                )}
              </article>
            </aside>
          </section>
        </>
      ) : (
        <section className="panel portfolio-analysis-empty">
          <span className="portfolio-analysis-empty__icon">Σ</span>
          <div>
            <span className="eyebrow">Synthetic ETF output</span>
            <h2>Save the portfolio to calculate its real composition</h2>
            <p>
              ETF holdings will be expanded and merged with direct positions.
              Nothing is estimated when an official source is unavailable.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
