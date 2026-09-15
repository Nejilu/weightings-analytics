import type { EtfVisibility } from "@/domain/visibility";
import { useState } from "react";

export function VisibilitySelect({
  value,
  onChange,
  disabled,
  etfId,
  onSaved,
}: {
  value: EtfVisibility;
  onChange: (value: EtfVisibility) => void;
  disabled?: boolean;
  etfId?: string;
  onSaved?: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/v1/local-etfs/${encodeURIComponent(etfId!)}/visibility`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visibility: value }),
        },
      );
      if (!response.ok) throw new Error("Visibility could not be saved.");
      await onSaved?.();
      setMessage("Visibility saved.");
    } catch {
      setMessage("Visibility could not be saved. Please retry.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="visibility-control">
      <label>
        <span>Website visibility</span>
        <select
          value={value}
          disabled={disabled || saving}
          onChange={(event) => {
            setMessage("");
            onChange(event.target.value as EtfVisibility);
          }}
        >
          <option value="private">Private — owner only</option>
          <option value="weights">
            Weights only — public composition, private amounts
          </option>
          <option value="public">Public — composition and exact amounts</option>
        </select>
      </label>
      <small>
        {value === "private"
          ? "Only you can see this ETF and its data."
          : value === "weights"
            ? "Visitors see holdings and weights. Share quantities and cash amounts stay private."
            : "Visitors can read exact share quantities, cash amounts and portfolio value. Only you can edit."}
      </small>
      {value !== "private" && (
        <small>
          An ETF that depends on a private ETF remains hidden from visitors.
        </small>
      )}
      {etfId && (
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Apply visibility"}
        </button>
      )}
      {message && <small role="status">{message}</small>}
    </div>
  );
}
