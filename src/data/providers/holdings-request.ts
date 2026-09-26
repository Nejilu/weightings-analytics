export class HoldingsSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HoldingsSourceError";
  }
}

export function sourceFailure(error: unknown): { code: string; message: string } {
  if (error instanceof HoldingsSourceError) return { code: error.code, message: error.message };
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return { code: "TIMEOUT", message: "The holdings provider request timed out." };
  }
  const cause = error instanceof Error ? error.cause : undefined;
  if (error instanceof Error && error.name === "HoldingsUnavailableError" && cause) return sourceFailure(cause);
  const code = cause && typeof cause === "object" && "code" in cause
    && typeof cause.code === "string" && /^[A-Z0-9_/-]{1,80}$/.test(cause.code)
    ? cause.code : undefined;
  if (code || (error instanceof TypeError && error.message === "fetch failed")) {
    return { code: code ?? "NETWORK_ERROR", message: "The holdings provider could not be reached." };
  }
  return { code: "INVALID_PROVIDER_DATA", message: "The holdings provider returned an invalid or incomplete response." };
}

export async function requestHoldingsSource(url: string): Promise<Response> {
  const upstream = new URL(url);
  const relay = process.env.ISHARES_RELAY_URL?.trim();
  const useRelay = Boolean(relay && ["www.ishares.com", "www.blackrock.com"].includes(upstream.hostname));
  let target = upstream;
  if (useRelay) {
    target = new URL(relay!);
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new HoldingsSourceError("RELAY_CONFIG", "The holdings relay requires an HTTPS URL without credentials.");
    }
    target.searchParams.set("url", url);
  }
  const response = await fetch(target.toString(), {
    headers: {
      Accept: url.includes("/varnish-api/") ? "application/json,*/*;q=0.8" : "text/csv,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent": "WeightingsAnalytics/0.1 holdings-research",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(useRelay ? 20_000 : 12_000),
  });
  if (!response.ok) {
    const relayCode = useRelay ? response.headers.get("x-holdings-error-code") : null;
    const code = relayCode && /^[A-Z0-9_]{1,60}$/.test(relayCode)
      ? relayCode : `HTTP_${response.status}`;
    await response.body?.cancel();
    throw new HoldingsSourceError(code,
      `${useRelay ? "Holdings relay/provider" : "Holdings provider"} returned HTTP ${response.status}${response.status === 403 ? " (access denied)" : ""}.`);
  }
  return response;
}
