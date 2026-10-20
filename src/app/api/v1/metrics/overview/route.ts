import { withSiteAccess } from "@/server/site-route";
import {
  getMetricsOverview,
  MetricsOverviewRequestError,
  MetricsOverviewUnavailableError,
} from "@/data/services/metrics-overview-service";
import { metricsOverviewHttpResponse } from "./etag";

async function handleGET(request: Request) {
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get("refresh") === "true";
  const references = url.searchParams
    .get("etfs")
    ?.split(",")
    .map((reference) => reference.trim())
    .filter(Boolean) ?? [];
  if (url.searchParams.get("stream") === "true") {
    const encoder = new TextEncoder();
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: unknown) => {
          if (open) controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
        };
        void getMetricsOverview(references, { forceRefresh,
          onFundamentals: (data) => send({ phase: "fundamentals", data }),
        }).then((data) => send({ phase: "complete", data })).catch((error: unknown) => {
          send({ error: error instanceof Error ? error.message : "Metrics are unavailable." });
        }).finally(() => {
          if (open) { open = false; controller.close(); }
        });
      },
      cancel() { open = false; },
    });
    return new Response(body, { headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    } });
  }
  try {
    const result = await getMetricsOverview(references, { forceRefresh });
    if (forceRefresh) {
      return Response.json(
        { data: result },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return metricsOverviewHttpResponse(
      result,
      request.headers.get("if-none-match"),
    );
  } catch (error) {
    const unavailable = error instanceof MetricsOverviewUnavailableError;
    const invalidRequest = error instanceof MetricsOverviewRequestError;
    const status = invalidRequest ? 400 : unavailable ? 503 : 500;
    return Response.json(
      {
        error: status === 500
          ? "Metrics overview failed."
          : error instanceof Error
            ? error.message
            : "Metrics are unavailable.",
      },
      {
        status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

export const GET = withSiteAccess(handleGET, "metrics");
