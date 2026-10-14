"use client";

import { useEffect, useState } from "react";
import type { FxRate } from "@/domain/portfolio";

export function usePortfolioFx(enabled = true) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; rate: number | null; error: string | null }>({ attempt: -1, rate: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/prices/fx?currency=EUR", { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { data?: FxRate; error?: string };
        const rate = payload.data?.rateToUsd;
        if (!response.ok || !rate || !Number.isFinite(rate) || rate <= 0) throw new Error(payload.error ?? "The EUR exchange rate is unavailable.");
        if (!controller.signal.aborted) setResult({ attempt, rate, error: null });
      } catch (cause) {
        if (!controller.signal.aborted) setResult((previous) => ({ attempt, rate: previous.rate, error: cause instanceof Error ? cause.message : "The EUR exchange rate is unavailable." }));
      }
    })();
    return () => controller.abort();
  }, [enabled, attempt]);
  return { rate: result.rate, loading: enabled && result.attempt !== attempt, error: result.attempt === attempt ? result.error : null, retry: () => setAttempt((value) => value + 1) };
}
