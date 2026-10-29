"use client";
import { AdrPremiumBadge } from "./adr-premium-badge";
import type { AdrPairId } from "@/domain/adr-premium";

import { HoldingsSourceWarning } from "./holdings-source-warning";

import { VisibilitySelect } from "./visibility-select";
import type { EtfVisibility } from "@/domain/visibility";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { CatalogGroup, EtfShareClass } from "@/domain/etf";
import type { LocalEtfDetail, LocalPortfolioEtfDetail } from "@/domain/local-etf";
import { mergeCashPosition } from "@/domain/processors/merge-cash-position";
import { mergePortfolioPosition } from "@/domain/processors/merge-portfolio-position";
import {
  SUPPORTED_CASH_CURRENCIES,
  MAX_PORTFOLIO_ITEMS,
  type PortfolioCashPosition,
  type PortfolioExposureMode,
  type MarketPrice,
  type PortfolioAssetKind,
  type PortfolioInputMode,
  type PortfolioItem,
  type PortfolioRecord,
} from "@/domain/portfolio";
import { EtfSearch } from "./etf-search";
import { ManualRefreshButton } from "./manual-refresh-button";
import { PortfolioOverview } from "./portfolio-overview";
import { PortfolioValueHistory } from "./portfolio-value-history";
import { usePortfolioFx } from "./use-portfolio-fx";
import { PortfolioEvents } from "./portfolio-events";
import { PortfolioDividendsPanel } from "./portfolio-dividends";
import { MetricCard } from "./metric-card";
import { PortfolioAllocationPanels } from "./portfolio-allocation-panels";
import { PortfolioCloneBuilder } from "./portfolio-clone-builder";
import { PortfolioJournalExplorer } from "./portfolio-journal-explorer";
import type { HoldingsCashDisplay } from "@/domain/holdings-cash-display";

interface PortfolioAnalyticsProps {
  owner?: boolean;
  publicationEnabled: boolean;
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
  underlyingSharesPerReceipt?: number;
}

interface CompositionRow {
  adrPremiumPairId?: AdrPairId;
  id: string;
  kind: "security" | "cash" | "financing";
  ticker: string;
  name: string;
  quoteSecurityId?: string;
  quoteTicker?: string;
  sector: string;
  country: string;
  weight: number;
  valueUsd: number;
  sources: Array<{ id: string; label: string; weight: number }>;
}

type PortfolioDisplayCurrency = "USD" | "EUR";
const COMPOSITION_INITIAL_COUNT = 10;
const COMPOSITION_LOAD_MORE_COUNT = 30;

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

function formatPortfolioTotal(
  valueUsd: number,
  currency: PortfolioDisplayCurrency,
  rateToUsd: number,
) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(valueUsd / rateToUsd);
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
  owner = true,
  publicationEnabled,
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
  const [panelView, setPanelView] = useState<"overview" | "view" | "editor">("overview");
  const [journalOpen, setJournalOpen] = useState(false);
  const isEditor = owner && panelView === "editor";
  const [editingEtfId, setEditingEtfId] = useState("");
  const [definitionLoading, setDefinitionLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [items, setItems] = useState<PortfolioItem[]>([]);
  const [cashPositions, setCashPositions] = useState<PortfolioCashPosition[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioRecord | null>(null);
  useLayoutEffect(() => {
    // Reset after both the navigation and the asynchronous detail render.
    // Instant scrolling overrides the global smooth-scroll rule and anchoring
    // from the portfolio card that was just removed from the document.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [panelView, editingEtfId, portfolio?.id]);
  const amountsVisible = owner || portfolio?.amountsVisible === true;
  const [compositionPrices, setCompositionPrices] = useState<
    Record<string, MarketPrice>
  >({});
  const [compositionPricesLoading, setCompositionPricesLoading] = useState(false);
  const [displayCurrency, setDisplayCurrency] =
    useState<PortfolioDisplayCurrency>("USD");
  const portfolioFx = usePortfolioFx(panelView !== "overview" && amountsVisible);
  const eurRateToUsd = portfolioFx.rate;
  const currencyLoading = portfolioFx.loading;
  const currencyError = portfolioFx.error;
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
  const [cashDisplay, setCashDisplay] = useState<HoldingsCashDisplay>("combined");
  const [compositionVisibleCount, setCompositionVisibleCount] = useState(COMPOSITION_INITIAL_COUNT);
  const [compositionRefreshRevision, setCompositionRefreshRevision] = useState(0);
  const forcedCompositionQuotes = useRef(new Set<string>());
  const [quote, setQuote] = useState<MarketPrice | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [resultFilter, setResultFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingEtf, setSavingEtf] = useState(false);
  const [savedEtf, setSavedEtf] = useState<EtfShareClass | null>(null);
  const [etfTicker, setEtfTicker] = useState("");
  const [etfName, setEtfName] = useState("My Portfolio ETF");
  const [etfDescription, setEtfDescription] = useState("");
  const [visibility, setVisibility] = useState<EtfVisibility>("private");
  const [error, setError] = useState<string | null>(null);
  const definitionRequestId = useRef(0);
  const [savedDefinition, setSavedDefinition] = useState<LocalPortfolioEtfDetail | null>(null);

  const applyPortfolioRecord = (record: PortfolioRecord) => {
    setPortfolio(record);
    setItems(record.items);
    setCashPositions(record.cashPositions ?? []);
  };

  const startCreateMode = () => {
    definitionRequestId.current += 1;
    setWorkflowMode("create");
    setPanelView("editor");
    setSavedDefinition(null);
    setEditingEtfId("");
    setDefinitionLoading(false);
    setConfirmDelete(false);
    setItems([]);
    setCashPositions([]);
    setPortfolio(null);
    setCloning(false);
    setCompositionPrices({});
    setCompositionPricesLoading(false);
    setResultFilter("");
    setCompositionVisibleCount(COMPOSITION_INITIAL_COUNT);
    setEtfTicker("");
    setEtfName("My Portfolio");
    setEtfDescription("");
    setVisibility("private");
    setSavedEtf(null);
    setError(null);
  };

  const showOverview = () => {
    definitionRequestId.current += 1;
    setPanelView("overview");
    setDefinitionLoading(false);
    setConfirmDelete(false);
    setError(null);
    setPortfolio(null);
    setItems([]);
    setCashPositions([]);
    setCompositionPrices({});
  };

  const loadEditablePortfolioEtf = async (
    etfId: string,
    detail?: LocalPortfolioEtfDetail,
    forceRefresh = false,
  ) => {
    if (!etfId) return;
    const requestId = ++definitionRequestId.current;
    forcedCompositionQuotes.current.clear();
    setCompositionRefreshRevision(0);
    setPanelView("view");
    setEditingEtfId(etfId);
    setWorkflowMode("edit");
    setPortfolio(null);
    setItems([]);
    setCashPositions([]);
    setCompositionPrices({});
    setCompositionPricesLoading(false);
    setResultFilter("");
    setCompositionVisibleCount(COMPOSITION_INITIAL_COUNT);
    setDefinitionLoading(true);
    if (forceRefresh) setRefreshing(true);
    setError(null);
    setSavedEtf(null);
    setConfirmDelete(false);
    try {
      let loaded = detail;
      if (!loaded) {
        const response = await fetch(
          `${owner ? "/api/v1/local-etfs" : "/api/v1/portfolio/published"}/${encodeURIComponent(etfId)}${forceRefresh ? "?refresh=true" : ""}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as {
          data?: LocalEtfDetail;
          error?: string;
        };
        if (!response.ok || payload.data?.kind !== "portfolio") {
          throw new Error(payload.error ?? "The portfolio could not be loaded.");
        }
        loaded = payload.data;
      }
      if (requestId !== definitionRequestId.current) return;
      setSavedDefinition(loaded);
      setWorkflowMode("edit");
      setEditingEtfId(loaded.etf.id);
      setEtfTicker(loaded.etf.ticker);
      setEtfName(loaded.etf.name);
      setEtfDescription(loaded.editableDescription);
      setVisibility(loaded.etf.visibility ?? "private");
      applyPortfolioRecord(loaded.portfolio);
      if (forceRefresh) {
        forcedCompositionQuotes.current.clear();
        setCompositionRefreshRevision((value) => value + 1);
      }
    } catch (loadError) {
      if (requestId !== definitionRequestId.current) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The portfolio ETF could not be loaded.",
      );
    } finally {
      if (requestId === definitionRequestId.current) {
        setDefinitionLoading(false);
        setRefreshing(false);
      }
    }
  };

  const cancelEditing = () => {
    const definition = savedDefinition;
    if (workflowMode === "create" || !definition) {
      showOverview();
      return;
    }
    applyPortfolioRecord(definition.portfolio);
    setEtfTicker(definition.etf.ticker);
    setEtfName(definition.etf.name);
    setEtfDescription(definition.editableDescription);
    setVisibility(definition.etf.visibility ?? "private");
    setConfirmDelete(false);
    setError(null);
    setPanelView("view");
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
      showOverview();
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
    if (
      !isEditor || kind !== "security" ||
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
  }, [isEditor, kind, query, selectedSecurity]);

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
    if (!isEditor || !selectedReferenceId) return;
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
  }, [isEditor, kind, selectedReferenceId]);
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
  const draftMarketValue = amountsVisible ? draftPositionsValue + draftCashValue : 0;
  const embeddedEurRate = cashPositions.find(
    (position) => position.currency === "EUR" && position.fxToUsd,
  )?.fxToUsd;
  const displayRateToUsd = displayCurrency === "USD"
    ? 1
    : eurRateToUsd ?? embeddedEurRate ?? 1;
  const displayedDraftMarketValue = formatPortfolioTotal(
    draftMarketValue,
    displayCurrency,
    displayRateToUsd,
  );

  const changeDisplayCurrency = (next: PortfolioDisplayCurrency) => {
    if (!amountsVisible || next === "USD" || eurRateToUsd || embeddedEurRate) setDisplayCurrency(next);
  };
  const normalizedItems = useMemo(
    () =>
      items.map((item) => {
        const currentValueUsd =
          item.currentValueUsd ??
          (item.quantity ?? 0) * (item.currentPriceUsd ?? 0);
        return {
          ...item,
          valueAvailable: item.currentValueUsd !== undefined || item.currentPriceUsd !== undefined,
          currentValueUsd,
          allocationWeight:
            amountsVisible ? draftMarketValue > 0 ? (currentValueUsd / draftMarketValue) * 100 : 0 : item.allocationWeight,
        };
      }),
    [items, draftMarketValue, amountsVisible],
  );
  const hasUnsavedChanges = (workflowMode === "edit" && savedDefinition !== null && (
    etfTicker !== savedDefinition.etf.ticker ||
    etfName !== savedDefinition.etf.name ||
    etfDescription !== savedDefinition.editableDescription ||
    visibility !== (savedDefinition.etf.visibility ?? "private")
  )) ||
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
          : "Select a security from the search results.",
      );
      return;
    }

    const referenceId =
      kind === "etf" ? etfSelection!.id : securitySelection!.securityId;
    const ticker =
      kind === "etf" ? etfSelection!.ticker : securitySelection!.ticker;
    const name =
      kind === "etf" ? etfSelection!.name : securitySelection!.name;
    if (!activeQuote || activeQuote.assetId !== referenceId) {
      setError(quoteError ?? "Wait for a current market price before adding this position.");
      return;
    }
    const quantity =
      inputMode === "shares" ? numericAmount : numericAmount / activeQuote.priceUsd;
    const currentValueUsd = quantity * activeQuote.priceUsd;

    setItems((current) =>
      mergePortfolioPosition(current, {
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
        }),
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
    setCashPositions((current) => mergeCashPosition(current, cashCurrency, amount));
    setError(null);
  };

  const save = async (forceRefresh = false) => {
    if (normalizedItems.some((item) => !item.quantity || !Number.isFinite(item.quantity))) {
      setError("Every security line must have a non-zero share quantity.");
      return false;
    }
    if (cashPositions.some((position) => !position.amount || !Number.isFinite(position.amount))) {
      setError("Every cash line must have a non-zero amount.");
      return false;
    }

    if (forceRefresh) setRefreshing(true);
    else setSaving(true);
    setError(null);
    try {
      const isEditing = workflowMode === "edit" && editingEtfId;
      const response = await fetch(
        `${isEditing
          ? `/api/v1/local-etfs/${encodeURIComponent(editingEtfId)}`
          : "/api/v1/portfolio"}${forceRefresh ? "?refresh=true" : ""}`,
        {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isEditing
            ? {
                kind: "portfolio",
                ticker: etfTicker,
                name: etfName,
                description: etfDescription,
                visibility,
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
        setSavedEtf(payload.data as EtfShareClass);
      } else {
        applyPortfolioRecord(payload.data as PortfolioRecord);
      }
      return true;
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The portfolio could not be saved.",
      );
      return false;
    } finally {
      if (forceRefresh) setRefreshing(false);
      else setSaving(false);
    }
  };

  const saveAsEtf = async () => {
    const isEditing = workflowMode === "edit" && editingEtfId;
    if (isEditing) {
      await save();
      return;
    }
    setSavingEtf(true);
    setSavedEtf(null);
    setError(null);
    try {
      const response = await fetch(
        "/api/v1/portfolio/save-as-etf",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: etfTicker,
          name: etfName,
          description: etfDescription,
          visibility,
          items: normalizedItems.map(({ id, kind: itemKind, referenceId, quantity }) => ({
            id, kind: itemKind, referenceId, inputMode: "shares", inputAmount: quantity,
          })),
          cashPositions: cashPositions.map(({ currency, amount }) => ({ currency, amount })),
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
      await loadEditablePortfolioEtf(payload.data.id);
      setSavedEtf(payload.data);
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
    const netAssetValueUsd = analysis.totalMarketValueUsd ?? draftMarketValue;
    const scale = exposureMode === "gross-normalized" && analysis.grossExposureWeight > 0
      ? 100 / analysis.grossExposureWeight
      : 1;
    const rows: CompositionRow[] = analysis.positions.map((position) => ({
      id: position.securityId,
      kind: "security",
      ticker: position.ticker,
      name: position.name,
      sector: position.sector,
      country: position.country,
      quoteSecurityId: position.quoteSecurityId,
      quoteTicker: position.quoteTicker,
      adrPremiumPairId: position.adrPremiumPairId,
      weight: position.weight * scale,
      valueUsd: netAssetValueUsd * position.weight / 100,
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
          name: `${position.currency} ${(position.weight ?? 0) < 0 ? "borrowing" : "cash"}`,
          sector: "Cash & equivalents",
          country: "Not applicable",
          weight: position.weight ?? 0,
          valueUsd: position.valueUsd ?? netAssetValueUsd * (position.weight ?? 0) / 100,
          sources: [{
            id: `cash:${position.currency}`,
            label: `${position.currency} ${(position.weight ?? 0) < 0 ? "borrowing" : "cash"}`,
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
          sector: "Cash & equivalents",
          country: "Not applicable",
          weight: analysis.financingWeight,
          valueUsd: netAssetValueUsd * analysis.financingWeight / 100,
          sources: [{
            id: "cash:implicit-financing",
            label: "ETF financing",
            weight: analysis.financingWeight,
          }],
        });
      }
      if (cashDisplay === "combined") {
        const cash = rows.filter((row) => row.kind !== "security");
        if (cash.length > 0) {
          const securities = rows.filter((row) => row.kind === "security");
          rows.splice(0, rows.length, ...securities, {
            id: "display:net-cash", kind: "cash", ticker: "CASH",
            name: "Net cash (all positions)", sector: "Cash & equivalents", country: "Not applicable",
            weight: cash.reduce((sum, row) => sum + row.weight, 0),
            valueUsd: cash.reduce((sum, row) => sum + row.valueUsd, 0),
            sources: cash.flatMap((row) => row.sources),
          });
        }
      }
    }
    return rows.sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight));
  }, [draftMarketValue, portfolio, exposureMode, cashDisplay]);

  const filteredPositions = useMemo(() => {
    const normalizedFilter = resultFilter.trim().toLocaleUpperCase("en-US");
    return compositionRows.filter(
      (position) =>
        !normalizedFilter ||
        position.ticker.toLocaleUpperCase("en-US").includes(normalizedFilter) ||
        position.name.toLocaleUpperCase("en-US").includes(normalizedFilter),
    );
  }, [compositionRows, resultFilter]);
  const visibleCompositionPositions = useMemo(
    () => filteredPositions.slice(0, compositionVisibleCount),
    [filteredPositions, compositionVisibleCount],
  );
  const visibleSecurityQuotesKey = visibleCompositionPositions
    .filter((position) => position.kind === "security")
    .map((position) => [
      position.id,
      position.quoteSecurityId ?? position.id,
      position.quoteTicker ?? position.ticker,
    ].join("\t"))
    .join("|");

  useEffect(() => {
    if (!amountsVisible) return;
    const quotes = visibleSecurityQuotesKey
      .split("|")
      .filter(Boolean)
      .map((value) => {
        const [key, securityId, ticker] = value.split("\t");
        return { key, securityId, ticker };
      });
    if (quotes.length === 0) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) setCompositionPricesLoading(true);
    });
    void (async () => {
      try {
        // The quote API accepts up to 30 listings per request.
        const groups = [false, true].map((refresh) => ({ refresh, quotes: quotes.filter((quote) =>
          (compositionRefreshRevision > 0 && !forcedCompositionQuotes.current.has(quote.key)) === refresh) }));
        const batches = groups.flatMap((group) => Array.from({ length: Math.ceil(group.quotes.length / 30) }, (_, index) =>
          ({ refresh: group.refresh, quotes: group.quotes.slice(index * 30, (index + 1) * 30) })));
        const results = await Promise.allSettled(batches.map(async (batch) => {
          const response = await fetch("/api/v1/prices/quotes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch),
            signal: controller.signal,
          });
          const payload = (await response.json()) as { data?: MarketPrice[]; error?: string };
          if (!response.ok || !payload.data) throw new Error(payload.error ?? "Security prices are unavailable.");
          if (!controller.signal.aborted && batch.refresh) {
            for (const price of payload.data) forcedCompositionQuotes.current.add(price.assetId);
          }
          return payload.data;
        }));
        if (controller.signal.aborted) return;
        const prices = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
        setCompositionPrices((current) => ({
          ...current,
          ...Object.fromEntries(prices.map((price) => [price.assetId, price])),
        }));
      } catch (priceError) {
        if (
          !controller.signal.aborted &&
          !(priceError instanceof DOMException && priceError.name === "AbortError")
        ) {
          // Missing equivalent-share quotes remain unavailable per row.
        }
      } finally {
        if (!controller.signal.aborted) setCompositionPricesLoading(false);
      }
    })();
    return () => controller.abort();
  }, [visibleSecurityQuotesKey, amountsVisible, compositionRefreshRevision]);

  const analysis = portfolio?.analysis;
  const maxPositionWeight = compositionRows.reduce(
    (maximum, position) => Math.max(maximum, Math.abs(position.weight)),
    0,
  );
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

  if (panelView === "overview") {
    return <PortfolioOverview owner={owner} portfolios={portfolioEtfs} onCreate={owner ? startCreateMode : undefined} onSelect={(id, detail) => void loadEditablePortfolioEtf(id, detail)} />;
  }

  if (panelView === "view" && !portfolio) {
    return (
      <div className="portfolio-workspace" id="portfolio">
        <div className="portfolio-navigation"><button type="button" className="secondary-button" onClick={showOverview}>← All portfolios</button></div>
        <section className="panel portfolio-overview-empty" aria-live="polite" aria-busy={definitionLoading}>
          <h1>{portfolioEtfs.find((etf) => etf.id === editingEtfId)?.name ?? "Portfolio"}</h1>
          {definitionLoading ? <p><span className="spinner" /> Loading portfolio…</p> : <>
            <p role="alert">{error ?? "The portfolio could not be loaded."}</p>
            <button className="secondary-button" type="button" onClick={() => void loadEditablePortfolioEtf(editingEtfId)}>Retry</button>
          </>}
        </section>
      </div>
    );
  }

  return (
    <div className="portfolio-workspace" id="portfolio">
      <div className="portfolio-navigation">
        <button className="secondary-button" type="button" disabled={saving || savingEtf || refreshing || definitionLoading} onClick={isEditor ? cancelEditing : showOverview}>
          <span aria-hidden="true">←</span> {isEditor ? "Cancel" : "All portfolios"}
        </button>
        {!isEditor && portfolio ? <button className="secondary-button" type="button" onClick={() => setJournalOpen(true)}>◷ Journal & what-if</button> : null}
        {isEditor ? (
          <span className="info-chip">{workflowMode === "edit" ? "Editing portfolio" : "New portfolio"}</span>
        ) : owner ? (
          <button className="primary-button" type="button" onClick={() => { setError(null); setSavedEtf(null); setPanelView("editor"); }}>
            <span aria-hidden="true">✎</span> Edit portfolio
          </button>
        ) : <span className="info-chip">Read-only · {visibility === "public" ? "Public" : "Weights only"}</span>}
      </div>
      {journalOpen && portfolio ? <PortfolioJournalExplorer key={`${owner}:${portfolio.id}`} owner={owner} portfolioId={portfolio.id} portfolioOptions={portfolioEtfs.flatMap((etf) => owner ? etf.portfolioId ? [{ id: etf.portfolioId, name: etf.name }] : [] : [{ id: etf.id, name: etf.name }])} onClose={() => setJournalOpen(false)} /> : null}
      {isEditor ? <section className="metrics-hero holdings-hero panel portfolio-detail-hero">
        <div>
          <span className="eyebrow">Look-through aggregation</span>
          <h1>{workflowMode === "edit" ? etfName : "Create a portfolio"}</h1>
          <p>
            {isEditor
              ? "Combine ETF positions, stocks and cash, then save your portfolio."
              : etfDescription || "Your positions, cash balances and underlying exposure."}
          </p>
        </div>
        <div className="panel-refresh-actions">
          <div className="portfolio-total">
            <span>{amountsVisible ? isEditor ? "Draft net asset value" : "Net asset value" : "Portfolio exposure"}</span>
            <strong>{amountsVisible ? !isEditor && portfolio?.priceError ? "Unavailable" : displayedDraftMarketValue : formatPercent(portfolio?.analysis?.grossExposureWeight ?? 0)}</strong>
            {amountsVisible ? <small className="portfolio-total-equivalent">{!isEditor && portfolio?.priceError ? "Unavailable" : displayCurrency === "EUR"
              ? `${formatPortfolioTotal(draftMarketValue, "USD", 1)} USD`
              : eurRateToUsd || embeddedEurRate ? `${formatPortfolioTotal(draftMarketValue, "EUR", (eurRateToUsd ?? embeddedEurRate)!)} EUR`
              : currencyLoading ? "EUR · Loading…" : "EUR · Unavailable"}</small> : <small>Gross securities exposure · amounts private</small>}
            <small>
              {items.length} position{items.length === 1 ? "" : "s"} ·{" "}
              {cashPositions.length} cash line{cashPositions.length === 1 ? "" : "s"}
            </small>
            {amountsVisible ? <div
              className="portfolio-currency-toggle"
              role="group"
              aria-label="Portfolio total display currency"
            >
              {(["USD", "EUR"] as const).map((currency) => (
                <button
                  key={currency}
                  type="button"
                  className={displayCurrency === currency ? "is-active" : ""}
                  aria-pressed={displayCurrency === currency}
                  disabled={currency === "EUR" && !eurRateToUsd && !embeddedEurRate}
                  onClick={() => void changeDisplayCurrency(currency)}
                >
                  {currencyLoading && currency === "EUR" ? "…" : currency}
                </button>
              ))}
            </div> : null}
            {amountsVisible && currencyError ? (
              <small className="portfolio-currency-error" role="status">
                {currencyError} <button type="button" className="secondary-button" onClick={portfolioFx.retry}>Retry</button>
              </small>
            ) : null}
          </div>
          {!isEditor ? <ManualRefreshButton
            loading={refreshing}
            disabled={saving || savingEtf || (items.length === 0 && cashPositions.length === 0)}
            onRefresh={() => void loadEditablePortfolioEtf(editingEtfId, undefined, true)}
          /> : null}
        </div>
      </section> : null}

      {!isEditor && portfolio ? <PortfolioValueHistory key={portfolio.id} portfolioId={portfolio.id} etfId={editingEtfId} owner={owner} relative={!amountsVisible}
        title={etfName} description={etfDescription} positionsCount={items.length} cashCount={cashPositions.length}
        currentValueUsd={amountsVisible && !portfolio.priceError ? draftMarketValue : undefined} eurRateToUsd={eurRateToUsd ?? embeddedEurRate ?? null}
        currency={displayCurrency} onCurrencyChange={changeDisplayCurrency} currencyLoading={currencyLoading} currencyError={currencyError} onCurrencyRetry={portfolioFx.retry}
        actions={<ManualRefreshButton loading={refreshing} disabled={saving || savingEtf || (items.length === 0 && cashPositions.length === 0)} onRefresh={() => void loadEditablePortfolioEtf(editingEtfId, undefined, true)} />}
      /> : null}
      {error ? <div className="alert alert--error">{error}</div> : null}
      {!isEditor && savedEtf ? <div className="saved-etf-success" role="status">{savedEtf.name} was saved.</div> : null}
      {portfolio?.priceError ? (
        <div className="alert alert--error">{portfolio.priceError}</div>
      ) : null}
      {portfolio?.analysisError ? (
        <div className="alert alert--error">{portfolio.analysisError}</div>
      ) : null}

      {isEditor && publicationEnabled && <section className="panel publication-settings">
              <VisibilitySelect value={visibility} onChange={setVisibility} disabled={savingEtf || saving} />
      </section>}
      {isEditor && workflowMode === "create" ? <PortfolioCloneBuilder
        catalog={catalog}
        hasPositions={items.length > 0 || cashPositions.length > 0}
        disabled={saving || savingEtf || refreshing}
        onBusyChange={setCloning}
        onApply={(result) => { applyPortfolioRecord(result.portfolio); setCompositionPrices({}); setCompositionVisibleCount(COMPOSITION_INITIAL_COUNT); setError(null); }}
      /> : null}
      {isEditor ? <section className="portfolio-builder-grid">
        <article className="panel portfolio-add-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Step 1</span>
              <h2>Add a position</h2>
            </div>
            <span className="info-chip">Max. {MAX_PORTFOLIO_ITEMS.toLocaleString("en-US")} positions</span>
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
              <small>ACWI + supported securities</small>
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
                <span>Search individual securities</span>
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
                    <div className="security-search-message">Searching securities…</div>
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
                            ? security.underlyingSharesPerReceipt
                              ? `${security.instrumentType} · ${security.underlyingSharesPerReceipt} × ${security.underlyingTicker} · USD`
                              : `${security.instrumentType} · Yahoo ${security.quoteSymbol} · underlying ${security.underlyingTicker}`
                            : security.sector}
                        </small>
                      </button>
                    ))
                  ) : (
                    <div className="security-search-message">
                      No matching supported security.
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
          <p className="muted-copy">
            Adding an existing instrument adjusts its current shares. Use a negative
            amount to reduce the position or go short.
          </p>
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
                  {activeQuote.source ?? "Yahoo Finance"} · {activeQuote.quoteSession ?? "regular"} · {activeQuote.sourceStatus}
                  {" · "}{new Date(activeQuote.asOf).toLocaleString("en-US")}
                  {activeQuote.delaySeconds ? ` · delayed ${activeQuote.delaySeconds / 60} min` : ""}
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
                    <strong className="security-ticker-with-premium"><span>{item.ticker}</span><AdrPremiumBadge security={item} /></strong>
                    <span>{item.name}</span>
                  </div>
                  <div className="portfolio-line__valuation">
                    <span className="shares-input">
                    <input
                      aria-label={`${item.ticker} shares`}
                      type="number"
                      step="1"
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
                  ? portfolio.id === "clone-preview" ? "Draft allocation generated" : "Portfolio preview calculated"
                  : "Ready to save"}
            </span>
            {workflowMode === "edit" ? <button
              className="primary-button"
              type="button"
              disabled={saving || savingEtf || refreshing || (items.length === 0 && cashPositions.length === 0)}
              onClick={() => void save()}
            >
              {saving ? <span className="spinner" /> : workflowMode === "edit" ? "Save changes" : "Save & analyse"}
            </button> : null}
          </div>
        </article>
      </section> : null}

      {isEditor ? (
        <section className="panel save-portfolio-etf-panel">
          <div className="save-portfolio-etf-copy">
            <span className="eyebrow">Portfolio details</span>
            <h2>{workflowMode === "edit" ? "Portfolio identity" : "Save your portfolio"}</h2>
            <p>
              Give your portfolio a name and ticker. Positions and cash are valued
              using the latest available prices.
            </p>
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
                <span>Portfolio name</span>
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
                  ? "Updates this portfolio in place."
                  : "Creates a new saved portfolio."}
              </span>
              <button
                className="primary-button"
                type="button"
                disabled={
                  savingEtf || saving || refreshing || cloning ||
                  (items.length === 0 && cashPositions.length === 0)
                }
                onClick={saveAsEtf}
              >
                {savingEtf ? (
                  <span className="spinner" />
                ) : workflowMode === "edit" ? (
                  "Save changes"
                ) : (
                  "Create portfolio"
                )}
              </button>
            </div>
          </div>
        </section>
      ) : null}
      {isEditor && workflowMode === "edit" ? (
        <div className="local-etf-delete-control portfolio-delete-control">
          {confirmDelete ? <span>This removes the portfolio and its saved positions.</span> : null}
          <button type="button" className={confirmDelete ? "is-confirming" : ""} disabled={definitionLoading || saving || savingEtf || refreshing} onClick={() => void deleteEditingPortfolioEtf()}>
            {confirmDelete ? "Confirm delete" : "Delete portfolio"}
          </button>
          {confirmDelete ? <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button> : null}
        </div>
      ) : null}
      <HoldingsSourceWarning issues={analysis?.sources.flatMap((source) => source.sourceIssues ?? [])} />
      {analysis ? (
        <>
          <section className="holdings-summary" aria-label="Portfolio overview metrics">
            <section className="panel holdings-summary-group" aria-labelledby="portfolio-structure-title">
              <h2 id="portfolio-structure-title">Breadth & concentration</h2>
              <div className="holdings-summary-metrics">
                <MetricCard label="Holdings universe" value={analysis.positionsCount} detail={`${analysis.etfSleevesCount} ETF sleeves · ${analysis.directPositionsCount} direct positions`} />
                <MetricCard label="Top 10 concentration" value={formatPercent(displayedTop10, 1)} detail="Absolute weight in the ten largest positions" />
              </div>
            </section>
            <section className="panel holdings-summary-group" aria-labelledby="portfolio-exposure-title">
              <h2 id="portfolio-exposure-title">Portfolio exposure</h2>
              <div className="holdings-summary-metrics">
                <MetricCard label="Gross securities exposure" value={formatPercent(analysis.grossExposureWeight, 1)} detail="Long and short exposures, in absolute value" />
                <MetricCard label="Net securities exposure" value={formatPercent(analysis.netExposureWeight, 1)} detail="Long positions minus short positions" />
              </div>
            </section>
            <section className="panel holdings-summary-group holdings-summary-group--cash" aria-labelledby="portfolio-cash-title">
              <div className="holdings-summary-heading">
                <h2 id="portfolio-cash-title">Cash & liquidity</h2>
                <button type="button" className="holdings-cash-toggle" role="switch" aria-checked={exposureMode === "net-total"} onClick={() => setExposureMode(exposureMode === "net-total" ? "gross-normalized" : "net-total")}>
                  Include cash <span className="holdings-cash-toggle-track" aria-hidden="true" />
                </button>
              </div>
              <MetricCard label={<span className="holdings-cash-metric-label"><span>Cash & equivalents</span>
                {exposureMode === "net-total" ? <select className="holdings-cash-grouping" aria-label="Cash grouping" value={cashDisplay} onChange={(event) => setCashDisplay(event.target.value as HoldingsCashDisplay)}>
                  <option value="combined">Combined</option><option value="positions">Separate</option>
                </select> : null}
              </span>} value={formatPercent(analysis.cashWeight, 2)} detail={<>
                {amountsVisible ? `${formatPortfolioTotal((analysis.totalMarketValueUsd ?? draftMarketValue) * analysis.cashWeight / 100, displayCurrency, displayRateToUsd)} · ` : ""}{exposureMode === "net-total" ? "included in view" : "excluded from view"}<br />
                {formatPercent(analysis.explicitCashWeight)} cash · {formatPercent(analysis.financingWeight)} ETF financing
              </>} />
            </section>
          </section>
          <p className="holdings-method-copy portfolio-composition-basis" role="status">
            {exposureMode === "net-total"
              ? "Weights use net asset value, including cash and financing. Long positions, shorts and borrowing retain their signs."
              : "Cash is excluded from allocations. Securities are normalized by gross absolute exposure to 100%; amounts remain actual portfolio exposure."}
          </p>

          <PortfolioAllocationPanels positions={compositionRows} includeCash={exposureMode === "net-total"} formatValue={amountsVisible ? (value) => formatPortfolioTotal(value, displayCurrency, displayRateToUsd) : undefined} />

          <div className={isEditor ? undefined : "portfolio-detail-columns"}>
          <section className={`panel portfolio-lookthrough-panel${amountsVisible ? "" : " portfolio-lookthrough-panel--weights"}`} aria-label="Underlying portfolio holdings">
            <div className="panel-heading">
              <div><span className="eyebrow">Look-through composition</span><h2>Underlying holdings</h2></div>
              <span className="info-chip">{exposureMode === "net-total" ? "NAV weights · with cash" : "Gross normalized · securities"}</span>
            </div>
            <div className="holdings-table-search">
              <label className="result-search"><span className="sr-only">Filter portfolio holdings</span><input type="search" value={resultFilter} placeholder="Filter holdings" onChange={(event) => { setResultFilter(event.target.value); setCompositionVisibleCount(COMPOSITION_INITIAL_COUNT); }} /></label>
              <span className="holdings-table-search-count">{filteredPositions.length} of {compositionRows.length} holdings</span>
            </div>
            <div className="portfolio-composition-scroll" tabIndex={0} aria-label="Scrollable portfolio composition">
              <div className="synthetic-ranking" id="portfolio-underlying-positions">
                <div className="synthetic-ranking__header">
                  <span>#</span><span>Security</span><span>Sources</span>
                  {amountsVisible ? <span title="Exposure divided by the latest security price">Equivalent shares</span> : null}
                  <span>{exposureMode === "gross-normalized" ? "Normalized weight" : "NAV weight"}</span>
                </div>
                {filteredPositions.length === 0 ? <p className="direct-only-note">No holdings match your search.</p> : null}
                {visibleCompositionPositions.map((position) => (
                  <div className={`synthetic-ranking__row ${position.weight < 0 ? "is-negative" : ""}`} key={position.id}>
                    <span className="synthetic-rank">{compositionRows.findIndex((candidate) => candidate.id === position.id) + 1}</span>
                    <div className="synthetic-security">
                      <strong className="security-ticker-with-premium"><span>{position.ticker}</span><AdrPremiumBadge security={position} /></strong>
                      <span title={position.name}>{position.name}</span>
                      <i aria-hidden="true"><b className={position.weight < 0 ? "is-negative" : ""} style={{ width: `${maxPositionWeight > 0 ? Math.abs(position.weight) / maxPositionWeight * 100 : 0}%` }} /></i>
                    </div>
                    <div className="contribution-list">
                      {position.sources.map((source) => <span key={source.id}>{source.label} {formatPercent(source.weight)}</span>)}
                    </div>
                    {amountsVisible ? <div className="synthetic-shares" title={`Exposure divided by the latest security price for ${position.quoteTicker ?? position.ticker}`}>
                      {position.kind === "security" && compositionPrices[position.id]?.priceUsd ? <>
                        <span>{formatQuantity(position.valueUsd / compositionPrices[position.id].priceUsd)}</span><small>shares</small>
                      </> : position.kind === "security" && compositionPricesLoading ? <span aria-label="Loading equivalent shares">…</span> : <span>—</span>}
                    </div> : null}
                    <strong className="synthetic-weight"><span>{formatPercent(position.weight)}</span>{amountsVisible ? <small>{formatPortfolioTotal(position.valueUsd, displayCurrency, displayRateToUsd)}</small> : null}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="portfolio-composition-actions">
              {visibleCompositionPositions.length < filteredPositions.length ? <button type="button" className="position-table-toggle" aria-controls="portfolio-underlying-positions" onClick={() => setCompositionVisibleCount((count) => count + COMPOSITION_LOAD_MORE_COUNT)}><span>Show more holdings</span><small>{visibleCompositionPositions.length} of {filteredPositions.length} displayed</small><b aria-hidden="true">↓</b></button> : null}
              {compositionVisibleCount > COMPOSITION_INITIAL_COUNT ? <button type="button" className="holdings-summary-details portfolio-composition-collapse" aria-controls="portfolio-underlying-positions" onClick={() => setCompositionVisibleCount(COMPOSITION_INITIAL_COUNT)}>Show fewer holdings ↑</button> : null}
            </div>
          </section>
          {!isEditor && portfolio ? <aside className="portfolio-events-sidebar" aria-label="Portfolio calendars"><PortfolioEvents portfolio={portfolio} />{owner ? <PortfolioDividendsPanel key={portfolio.id} portfolioId={portfolio.id} revision={portfolio.updatedAt} cashBalances={portfolio.cashPositions} onPayment={async () => { if (editingEtfId) await loadEditablePortfolioEtf(editingEtfId); else { const response = await fetch("/api/v1/portfolio", { cache: "no-store" }); const payload = await response.json(); if (response.ok && payload.data) applyPortfolioRecord(payload.data); } }} /> : null}</aside> : null}
          </div>

          <details className="panel portfolio-source-details">
            <summary>ETF sources <span className="info-chip">{analysis.sources.length} files</span></summary>
            {analysis.sources.length > 0 ? <div className="portfolio-source-list">
              {analysis.sources.map((source) => <div key={source.referenceId}><strong>{source.ticker}</strong><span>as of {source.asOf}</span><b>{source.sourceStatus}</b>
                {source.constituentCoverage ? <small>Normalization used {source.constituentCoverage.used} of {source.constituentCoverage.total} configured constituents{source.constituentCoverage.missingTickers.length > 0 ? `. Missing from the current ACWI snapshot: ${source.constituentCoverage.missingTickers.join(", ")}.` : "."}</small> : null}
              </div>)}
            </div> : <p className="direct-only-note">Direct-stock portfolio. No ETF file is required.</p>}
          </details>
        </>
      ) : (
        <section className="panel portfolio-analysis-empty">
          <span className="portfolio-analysis-empty__icon">Σ</span>
          <div>
            <span className="eyebrow">Synthetic ETF output</span>
            <h2>{isEditor ? "Save the portfolio to calculate its real composition" : "Portfolio analysis unavailable"}</h2>
            <p>
              {isEditor
                ? "ETF holdings will be expanded and merged with direct positions."
                : "Refresh the portfolio to retry its underlying analysis. Your owned positions are shown below."}
            </p>
          </div>
        </section>
      )}
      {!isEditor && !analysis && portfolio ? <aside className="portfolio-events-sidebar portfolio-events-sidebar--standalone" aria-label="Portfolio calendars"><PortfolioEvents portfolio={portfolio} />{owner ? <PortfolioDividendsPanel key={portfolio.id} portfolioId={portfolio.id} revision={portfolio.updatedAt} cashBalances={portfolio.cashPositions} onPayment={async () => { if (editingEtfId) await loadEditablePortfolioEtf(editingEtfId); else { const response = await fetch("/api/v1/portfolio", { cache: "no-store" }); const payload = await response.json(); if (response.ok && payload.data) applyPortfolioRecord(payload.data); } }} /> : null}</aside> : null}
      {!isEditor ? (
        <section className="panel portfolio-positions-panel" aria-label="Owned portfolio positions and cash">
          <div className="panel-heading">
            <div><span className="eyebrow">Owned positions</span><h2>Positions and cash</h2></div>
            <div className="portfolio-position-legend"><span className="is-etf">ETF</span><span className="is-stock">Stock</span><span className="is-short">Short</span><span className="info-chip">{items.length + cashPositions.length} lines</span></div>
          </div>
          <div className="portfolio-position-bubbles">
            {normalizedItems.map((item) => (
              <article className={`portfolio-position-bubble portfolio-position-bubble--${item.kind}${item.allocationWeight < 0 ? " is-short" : ""}`} key={item.id}>
                <div className="portfolio-position-bubble__heading"><strong title={item.name}>{item.ticker}</strong><span>{item.kind === "etf" ? "ETF" : "Stock"}{item.allocationWeight < 0 ? " · short" : ""}</span></div>
                <span className="portfolio-position-bubble__name" title={item.name}>{item.name}</span>
                <strong className="portfolio-position-bubble__value">{amountsVisible ? item.valueAvailable ? formatPortfolioTotal(item.currentValueUsd ?? 0, displayCurrency, displayRateToUsd) : "Unavailable" : formatPercent(item.allocationWeight)}</strong>
                {amountsVisible ? <div className="portfolio-position-bubble__details"><span>{formatQuantity(item.quantity ?? 0)} shares</span><b>{!portfolio?.priceError && item.valueAvailable ? formatPercent(item.allocationWeight) : "—"}</b></div> : null}
              </article>
            ))}
            {cashPositions.map((position) => (
              <article className="portfolio-position-bubble portfolio-position-bubble--cash" key={position.currency}>
                <div className="portfolio-position-bubble__heading"><strong>{position.currency}</strong><span>{(position.weight ?? 0) < 0 ? "Borrowing" : "Cash"}</span></div>
                <span className="portfolio-position-bubble__name">{(position.weight ?? 0) < 0 ? "Borrowed cash" : "Cash & cash equivalents"}</span>
                <strong className="portfolio-position-bubble__value">{amountsVisible ? position.valueUsd !== undefined ? formatPortfolioTotal(position.valueUsd, displayCurrency, displayRateToUsd) : "Unavailable" : formatPercent(position.weight ?? 0)}</strong>
                {amountsVisible ? <div className="portfolio-position-bubble__details"><span>{formatQuantity(position.amount)} {position.currency}</span><b>{!portfolio?.priceError && draftMarketValue > 0 && position.valueUsd !== undefined ? formatPercent(position.valueUsd / draftMarketValue * 100) : "—"}</b></div> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
