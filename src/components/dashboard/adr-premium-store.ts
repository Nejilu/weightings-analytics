import { ADR_PAIRS, type AdrPairId, type AdrPremiumView } from "@/domain/adr-premium";

export type AdrPremiumSnapshot = {
  status: "idle" | "loading" | "ready" | "unavailable";
  data: Partial<Record<AdrPairId, AdrPremiumView>>;
};

const EMPTY: AdrPremiumSnapshot = { status: "idle", data: {} };

/** One browser request serves every badge, including concurrent mounts and views. */
export function createAdrPremiumStore(fetcher: typeof fetch = fetch, clock = Date.now) {
  let snapshot = EMPTY;
  let expiresAt = 0;
  let inFlight: Promise<void> | null = null;
  let inFlightForced = false;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const refreshVisible = () => { if (typeof document !== "undefined" && !document.hidden) void load(); };
  const update = (value: AdrPremiumSnapshot) => {
    snapshot = value;
    listeners.forEach((listener) => listener());
  };
  const load = (forceRefresh = false): Promise<void> => {
    if (inFlight) {
      // A forced refresh must also bypass an ordinary request already in progress.
      return forceRefresh && !inFlightForced ? inFlight.then(() => load(true)) : inFlight;
    }
    if (!forceRefresh && expiresAt > clock()) return Promise.resolve();
    update({ ...snapshot, status: "loading" });
    inFlightForced = forceRefresh;
    inFlight = (async () => {
      try {
        const response = await fetcher(`/api/v1/metrics/adr-premiums${forceRefresh ? "?refresh=true" : ""}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Premiums unavailable");
        const payload = await response.json() as { data?: Partial<Record<AdrPairId, AdrPremiumView>> };
        if (!payload.data || ADR_PAIRS.some((pair) => !payload.data?.[pair.id])) throw new Error("Incomplete premium response");
        update({ status: "ready", data: payload.data });
        const captured = Math.min(...Object.values(payload.data).map((view) => Date.parse(view.capturedAt)));
        const retryNeeded = Object.values(payload.data).some((view) => view.sourceStatus === "stale" || view.sourceStatus === "unavailable");
        expiresAt = retryNeeded ? clock() + 60_000 : Math.max(clock() + 60_000, captured + 15 * 60_000);
      } catch {
        const data = Object.fromEntries(Object.entries(snapshot.data).map(([id, view]) => [id,
          view.observation ? { ...view, sourceStatus: "stale" } : view,
        ]));
        update({ status: "unavailable", data });
        expiresAt = clock() + 60_000;
      }
    })().finally(() => { inFlight = null; inFlightForced = false; });
    return inFlight;
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    load,
    refreshIfLoaded: () => listeners.size || snapshot.status !== "idle" ? load(true) : Promise.resolve(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1 && typeof document !== "undefined") {
        timer = setInterval(refreshVisible, 60_000);
        document.addEventListener("visibilitychange", refreshVisible);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refreshVisible);
        }
      };
    },
  };
}

export const adrPremiumStore = createAdrPremiumStore();
