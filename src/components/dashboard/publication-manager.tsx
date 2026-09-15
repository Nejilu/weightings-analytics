import { useState } from "react";
import type { CatalogGroup, EtfShareClass } from "@/domain/etf";
import { VisibilitySelect } from "./visibility-select";

function PublicationEditor({
  etf,
  onChanged,
}: {
  etf: EtfShareClass;
  onChanged: () => Promise<void>;
}) {
  const [visibility, setVisibility] = useState(etf.visibility ?? "private");
  return (
    <>
      <VisibilitySelect
        value={visibility}
        onChange={setVisibility}
        etfId={etf.id}
        onSaved={onChanged}
      />
      {etf.visibility !== "private" && !etf.publiclyAvailable && (
        <p role="status">
          Hidden from the website because a source ETF is private, missing or
          cyclic.
        </p>
      )}
    </>
  );
}

export function PublicationManager({
  catalog,
  onChanged,
}: {
  catalog: CatalogGroup[];
  onChanged: () => Promise<void>;
}) {
  const etfs = catalog
    .flatMap((group) => group.variants)
    .filter((etf) => etf.fundType === "portfolio" || etf.fundType === "custom");
  const [selectedId, setSelectedId] = useState("");
  const selected = etfs.find((etf) => etf.id === selectedId) ?? etfs[0];
  if (!selected) return null;
  return (
    <details className="panel publication-settings">
      <summary>Website publication</summary>
      <p>
        Change who can see a saved ETF without loading or editing its positions.
      </p>
      <label>
        Saved ETF
        <select
          value={selected.id}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {etfs.map((etf) => (
            <option key={etf.id} value={etf.id}>
              {etf.ticker} · {etf.name} · {etf.visibility}
            </option>
          ))}
        </select>
      </label>
      <PublicationEditor
        key={`${selected.id}-${selected.visibility}`}
        etf={selected}
        onChanged={onChanged}
      />
    </details>
  );
}
