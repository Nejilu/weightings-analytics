"use client";

import { useMemo, useState } from "react";

import type { CatalogGroup, EtfFundType, EtfShareClass } from "@/domain/etf";

interface LocalEtfManagerProps {
  catalog: CatalogGroup[];
  fundType: Extract<EtfFundType, "custom" | "portfolio">;
  onCatalogChanged: () => Promise<void>;
  onDeleted?: (etfId: string) => void;
}

interface EditDraft {
  ticker: string;
  name: string;
  description: string;
}

export function LocalEtfManager({
  catalog,
  fundType,
  onCatalogChanged,
  onDeleted,
}: LocalEtfManagerProps) {
  const localEtfs = useMemo(
    () =>
      catalog
        .flatMap((group) => group.variants)
        .filter((etf) => etf.fundType === fundType),
    [catalog, fundType],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const isPortfolio = fundType === "portfolio";

  const startEditing = (etf: EtfShareClass) => {
    setEditingId(etf.id);
    setDraft({
      ticker: etf.ticker,
      name: etf.name,
      description: etf.description ?? "",
    });
    setConfirmDeleteId(null);
    setError(null);
    setMessage(null);
  };

  const saveEdit = async (etfId: string) => {
    if (!draft) return;
    setBusyId(etfId);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/v1/local-etfs/${encodeURIComponent(etfId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        },
      );
      const payload = (await response.json()) as {
        data?: EtfShareClass;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error ?? "The local ETF could not be updated.");
      }
      await onCatalogChanged();
      setEditingId(null);
      setDraft(null);
      setMessage(`${payload.data.ticker} was updated.`);
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "The local ETF could not be updated.",
      );
    } finally {
      setBusyId(null);
    }
  };

  const deleteEtf = async (etf: EtfShareClass) => {
    if (confirmDeleteId !== etf.id) {
      setConfirmDeleteId(etf.id);
      setEditingId(null);
      setDraft(null);
      setError(null);
      setMessage(null);
      return;
    }

    setBusyId(etf.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/local-etfs/${encodeURIComponent(etf.id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as {
        data?: { id: string };
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error ?? "The local ETF could not be deleted.");
      }
      onDeleted?.(etf.id);
      await onCatalogChanged();
      setConfirmDeleteId(null);
      setMessage(`${etf.ticker} was deleted.`);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The local ETF could not be deleted.",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel local-etf-manager">
      <div className="local-etf-manager-heading">
        <div>
          <span className="eyebrow">Local ETF library</span>
          <h2>
            {isPortfolio ? "Manage portfolio ETFs" : "Manage custom ETFs"}
          </h2>
          <p>
            Edit the ticker, name or description, or permanently delete a local
            ETF and its associated data.
          </p>
        </div>
        <span className="info-chip">
          {localEtfs.length} saved ETF{localEtfs.length === 1 ? "" : "s"}
        </span>
      </div>

      {error ? <div className="alert alert--error">{error}</div> : null}
      {message ? <div className="saved-etf-success">{message}</div> : null}

      {localEtfs.length > 0 ? (
        <div className="local-etf-list">
          {localEtfs.map((etf) => {
            const isEditing = editingId === etf.id && draft;
            const isConfirmingDelete = confirmDeleteId === etf.id;
            return (
              <article className="local-etf-row" key={etf.id}>
                {isEditing ? (
                  <div className="local-etf-edit-form">
                    <label className="field">
                      <span>Ticker</span>
                      <input
                        value={draft.ticker}
                        maxLength={10}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            ticker: event.target.value.toUpperCase(),
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>ETF name</span>
                      <input
                        value={draft.name}
                        maxLength={80}
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.target.value })
                        }
                      />
                    </label>
                    <label className="field local-etf-description-field">
                      <span>Description</span>
                      <textarea
                        value={draft.description}
                        maxLength={1000}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            description: event.target.value,
                          })
                        }
                      />
                    </label>
                    <div className="local-etf-edit-actions">
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busyId === etf.id}
                        onClick={() => void saveEdit(etf.id)}
                      >
                        {busyId === etf.id ? "Saving…" : "Save changes"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setDraft(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="local-etf-identity">
                      <span
                        className={`asset-badge asset-badge--${isPortfolio ? "etf" : "security"}`}
                      >
                        {isPortfolio ? "Portfolio" : "Frozen"}
                      </span>
                      <div>
                        <strong>{etf.ticker}</strong>
                        <span>{etf.name}</span>
                        <small>
                          {etf.description || "No description provided."}
                        </small>
                      </div>
                    </div>
                    <div className="local-etf-actions">
                      {isConfirmingDelete ? (
                        <span>
                          This removes the ETF and its associated data. Confirm?
                        </span>
                      ) : null}
                      <button type="button" onClick={() => startEditing(etf)}>
                        Edit details
                      </button>
                      <button
                        className={isConfirmingDelete ? "is-confirming" : ""}
                        type="button"
                        disabled={busyId === etf.id}
                        onClick={() => void deleteEtf(etf)}
                      >
                        {busyId === etf.id
                          ? "Deleting…"
                          : isConfirmingDelete
                            ? "Confirm delete"
                            : "Delete"}
                      </button>
                      {isConfirmingDelete ? (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="local-etf-empty">
          {isPortfolio
            ? "Portfolio ETFs saved from this tab will appear here."
            : "Custom ETFs saved from the Creator will appear here."}
        </div>
      )}
    </section>
  );
}
