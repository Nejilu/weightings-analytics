import { AccessError, getSiteAccess, requireOwner } from "./site-access";
import {
  publicationCatalog,
  publicAnalysis,
  requirePublicEtf,
  siteCatalog,
} from "./public-data";
import {
  catalogRevision,
  invalidateSiteResults,
  takeBudget,
} from "./site-runtime";

export type RoutePolicy =
  | "owner"
  | "catalog"
  | "holdings"
  | "compare"
  | "metrics"
  | "quote"
  | "read"
  | "published-portfolio";

function referencesFor(request: Request, policy: RoutePolicy): string[] {
  const url = new URL(request.url);
  if (policy === "holdings" || policy === "published-portfolio") {
    return [decodeURIComponent(url.pathname.split("/")[4] ?? "")];
  }
  if (policy === "compare")
    return [
      url.searchParams.get("left") ?? "",
      url.searchParams.get("right") ?? "",
    ];
  if (policy === "metrics")
    return (url.searchParams.get("etfs") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (policy === "quote" && url.searchParams.get("kind") === "etf")
    return [url.searchParams.get("referenceId") ?? ""];
  return [];
}

export function withSiteAccess<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
  policy: RoutePolicy,
) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    try {
      const access = await getSiteAccess(request.headers);
      if (policy === "owner") requireOwner(access, request);
      const initialRevision = catalogRevision();
      const references = referencesFor(request, policy);
      if (!access.owner) {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        // Global budget also applies, so an untrusted client header cannot bypass the cap.
        if (
          !takeBudget("global-read", 600, 60_000) ||
          !takeBudget(`read:${ip}`, 120, 60_000)
        ) {
          throw new AccessError(429, "Too many requests. Try again shortly.");
        }
        if (references.length) {
          const catalog = publicationCatalog();
          for (const reference of references) {
            const etf = requirePublicEtf(catalog, reference);
            if (policy === "quote" && etf.fundType === "portfolio")
              throw new AccessError(404, "Quote unavailable.");
            if (
              policy === "published-portfolio" &&
              (etf.fundType !== "portfolio" || etf.visibility !== "public")
            ) {
              throw new AccessError(404, "Portfolio details unavailable.");
            }
          }
        }
        const url = new URL(request.url);
        let body: Record<string, unknown> | undefined;
        if (request.method === "POST") {
          const reader = request.body?.getReader();
          let text = "";
          let size = 0;
          const decoder = new TextDecoder();
          if (reader) {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 64_000) {
                void reader.cancel();
                throw new AccessError(413, "Request too large.");
              }
              text += decoder.decode(chunk.value, { stream: true });
            }
          }
          text += decoder.decode();
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new AccessError(400, "Invalid request body.");
          body = parsed as Record<string, unknown>;
          request = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(body),
          });
        }
        if (
          url.searchParams.get("refresh") === "true" ||
          body?.refresh === true
        ) {
          // A force refresh is admitted once per route/selection per minute.
          // Following visitors receive the shared normal cache instead of starting another refresh.
          const key = `refresh:${policy}:${references.slice().sort().join("|")}`;
          const admitted =
            takeBudget(key, 1, 60_000) &&
            takeBudget("global-refresh", 12, 60_000);
          if (!admitted) {
            url.searchParams.delete("refresh");
            if (body) body.refresh = false;
            request = new Request(url, {
              method: request.method,
              headers: request.headers,
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
          }
        }
      }
      // Conditional responses must be generated from the projected representation.
      const headers = new Headers(request.headers);
      headers.delete("if-none-match");
      headers.delete("if-modified-since");
      request = new Request(request, { headers });
      const response = await handler(request, ...args);
      if (
        policy === "owner" &&
        !["GET", "HEAD"].includes(request.method) &&
        response.ok
      )
        invalidateSiteResults();
      const outputHeaders = new Headers(response.headers);
      outputHeaders.set("Cache-Control", "private, no-store");
      outputHeaders.set("Vary", "Host, Cookie, Cf-Access-Jwt-Assertion");
      outputHeaders.delete("etag");
      if (access.owner) {
        if (policy === "catalog" && response.ok)
          return Response.json(
            { data: siteCatalog(true), revision: catalogRevision() },
            { headers: outputHeaders },
          );
        return new Response(response.body, {
          status: response.status,
          headers: outputHeaders,
        });
      }
      const payload: unknown = await response.json();
      if (initialRevision !== catalogRevision())
        throw new AccessError(409, "The catalog changed. Please retry.");
      const catalog = publicationCatalog();
      for (const reference of references) {
        const etf = requirePublicEtf(catalog, reference);
        if (policy === "published-portfolio" && etf.visibility !== "public")
          throw new AccessError(404, "Portfolio details unavailable.");
      }
      if (!response.ok) {
        return Response.json(
          {
            error:
              response.status >= 500
                ? "Data temporarily unavailable. Please retry."
                : "Invalid or unavailable selection.",
          },
          { status: response.status, headers: outputHeaders },
        );
      }
      return Response.json(
        policy === "catalog"
          ? { data: siteCatalog(false, catalog), revision: catalogRevision() }
          : policy === "published-portfolio"
            ? payload
            : publicAnalysis(payload, catalog),
        { status: response.status, headers: outputHeaders },
      );
    } catch (error) {
      const status =
        error instanceof AccessError
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : 503;
      return Response.json(
        {
          error:
            error instanceof AccessError
              ? error.message
              : "Request unavailable.",
        },
        {
          status,
          headers: {
            "Cache-Control": "no-store",
            ...(status === 429 ? { "Retry-After": "60" } : {}),
          },
        },
      );
    }
  };
}
