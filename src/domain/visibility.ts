export type EtfVisibility = "private" | "weights" | "public";

export function isEtfVisibility(value: unknown): value is EtfVisibility {
  return value === "private" || value === "weights" || value === "public";
}
