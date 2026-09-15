import { withSiteAccess } from "@/server/site-route";
import { isEtfVisibility } from "@/domain/visibility";
import {
  createEtfFromSource,
  EtfCreatorRequestError,
  EtfCreatorUnavailableError,
} from "@/data/services/etf-creator-service";
import type { EtfCreatorCriteria } from "@/domain/etf-creator";

async function handlePOST(request: Request) {
  try {
    const rawPayload = await request.json();
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      return Response.json(
        { error: "Ticker, base ETF, ETF name, criteria and holdings are required." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const payload = rawPayload as {
      visibility?: import("@/domain/visibility").EtfVisibility;
      ticker?: string;
      name?: string;
      description?: string;
      selectedSecurityIds?: string[];
      sourceEtfId?: string;
      criteria?: EtfCreatorCriteria;
    };
    if (
      (payload.visibility !== undefined && !isEtfVisibility(payload.visibility)) ||
      typeof payload.ticker !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.sourceEtfId !== "string" ||
      !Array.isArray(payload.selectedSecurityIds) ||
      payload.selectedSecurityIds.some((id) => typeof id !== "string") ||
      !payload.criteria ||
      typeof payload.criteria !== "object" ||
      Array.isArray(payload.criteria) ||
      (payload.description !== undefined && typeof payload.description !== "string")
    ) {
      return Response.json(
        { error: "Ticker, base ETF, ETF name, criteria and holdings are required." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const etf = await createEtfFromSource({
      visibility: payload.visibility,
      ticker: payload.ticker,
      name: payload.name,
      description: payload.description,
      sourceEtfId: payload.sourceEtfId,
      selectedSecurityIds: payload.selectedSecurityIds,
      criteria: payload.criteria,
    });
    return Response.json(
      { data: etf },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: "Request body must be valid JSON." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof EtfCreatorRequestError) {
      return Response.json(
        { error: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof EtfCreatorUnavailableError) {
      return Response.json(
        { error: error.message || "The selected ETF source data is unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      {
        error: "The custom ETF could not be saved.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const POST = withSiteAccess(handlePOST, "owner");
