import {
  deleteLocalEtf,
  getLocalEtfDetail,
  LocalEtfNotFoundError,
  LocalEtfRequestError,
  updateCustomLocalEtf,
  updatePortfolioLocalEtf,
} from "@/data/services/local-etf-service";
import type { EtfCreatorCriteria } from "@/domain/etf-creator";
import type {
  PortfolioAssetKind,
  PortfolioInputMode,
} from "@/domain/portfolio";

function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof LocalEtfRequestError) {
    return Response.json(
      { error: error.message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof LocalEtfNotFoundError) {
    return Response.json(
      { error: error.message },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { error: fallback },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ etfId: string }> },
) {
  try {
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "true";
    const { etfId } = await context.params;
    const payload = (await request.json()) as {
      kind?: "custom" | "portfolio";
      ticker?: string;
      name?: string;
      description?: string;
      sourceEtfId?: string;
      selectedSecurityIds?: string[];
      criteria?: EtfCreatorCriteria;
      items?: Array<{
        id: string;
        kind: PortfolioAssetKind;
        referenceId: string;
        inputMode: PortfolioInputMode;
        inputAmount: number;
      }>;
      cashPositions?: Array<{ currency: string; amount: number }>;
    };
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.ticker !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.description !== "string" ||
      (payload.kind !== "custom" && payload.kind !== "portfolio")
    ) {
      return Response.json(
        { error: "Ticker, ETF name and description are required." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (payload.kind === "custom") {
      if (
        typeof payload.sourceEtfId !== "string" ||
        !Array.isArray(payload.selectedSecurityIds) ||
        payload.selectedSecurityIds.some((value) => typeof value !== "string") ||
        !payload.criteria ||
        typeof payload.criteria !== "object" ||
        Array.isArray(payload.criteria)
      ) {
        return Response.json(
          { error: "The complete custom ETF definition is required." },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        {
          data: await updateCustomLocalEtf(etfId, {
            kind: "custom",
            ticker: payload.ticker,
            name: payload.name,
            description: payload.description,
            sourceEtfId: payload.sourceEtfId,
            selectedSecurityIds: payload.selectedSecurityIds,
            criteria: payload.criteria,
          }),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (!Array.isArray(payload.items) || !Array.isArray(payload.cashPositions)) {
      return Response.json(
        { error: "The complete portfolio ETF definition is required." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      {
        data: await updatePortfolioLocalEtf(etfId, {
          kind: "portfolio",
          ticker: payload.ticker,
          name: payload.name,
          description: payload.description,
          items: payload.items,
          cashPositions: payload.cashPositions,
        }, { forceRefresh }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "The local ETF could not be updated.");
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ etfId: string }> },
) {
  try {
    const { etfId } = await context.params;
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "true";
    return Response.json(
      { data: await getLocalEtfDetail(etfId, { forceRefresh }) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "The local ETF could not be loaded.");
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ etfId: string }> },
) {
  try {
    const { etfId } = await context.params;
    deleteLocalEtf(etfId);
    return Response.json(
      { data: { id: etfId } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "The local ETF could not be deleted.");
  }
}
