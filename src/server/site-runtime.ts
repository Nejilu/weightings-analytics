import { randomUUID } from "node:crypto";

// Shared across Next route bundles in the supported single Node process.
const runtime = globalThis as typeof globalThis & {
  __siteRuntime?: {
    epoch: string;
    revision: number;
    limits: Map<string, { count: number; until: number }>;
  };
};
export const siteRuntime = (runtime.__siteRuntime ??= {
  epoch: randomUUID(),
  revision: 0,
  limits: new Map(),
});
export function catalogRevision() {
  return `${siteRuntime.epoch}:${siteRuntime.revision}`;
}
export function invalidateSiteResults() {
  siteRuntime.revision += 1;
}

export function takeBudget(
  key: string,
  limit: number,
  interval: number,
  now = Date.now(),
): boolean {
  const old = siteRuntime.limits.get(key);
  if (old && old.until > now) {
    if (old.count >= limit) return false;
    old.count += 1;
    return true;
  }
  if (siteRuntime.limits.size >= 5000) {
    for (const [id, entry] of siteRuntime.limits)
      if (entry.until <= now) siteRuntime.limits.delete(id);
    if (siteRuntime.limits.size >= 5000) return false;
  }
  siteRuntime.limits.set(key, { count: 1, until: now + interval });
  return true;
}
