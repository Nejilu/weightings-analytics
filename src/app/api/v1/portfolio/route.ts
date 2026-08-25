import {
  getPortfolio,
  PortfolioRequestError,
  PortfolioUnavailableError,
  savePortfolio,
} from "@/data/services/portfolio-service";
import type {
  PortfolioAssetKind,
  PortfolioInputMode,
} from "@/domain/portfolio";

interface PortfolioRequestItem {
  id: string;
  kind: PortfolioAssetKind;
  referenceId: string;
  inputMode: PortfolioInputMode;
  inputAmount: number;
}

interface PortfolioRequestCashPosition {
  currency: string;
  amount: number;
}

function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof PortfolioRequestError) {
    return Response.json(
      { error: error.message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof PortfolioUnavailableError) {
    return Response.json(
      { error: error.message || fallback },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { error: fallback },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "true";
    const portfolio = await getPortfolio({ forceRefresh });
    return Response.json(
      { data: portfolio },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "The portfolio could not be loaded.");
  }
}

export async function PUT(request: Request) {
  try {
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "true";
    const payload = (await request.json()) as {
      items?: PortfolioRequestItem[];
      cashPositions?: PortfolioRequestCashPosition[];
    };
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
      return Response.json(
        { error: "The portfolio items array is required." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (
      payload.cashPositions !== undefined &&
      !Array.isArray(payload.cashPositions)
    ) {
      return Response.json(
        { error: "The cash positions value must be an array." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const portfolio = await savePortfolio(
      payload.items,
      payload.cashPositions ?? [],
      { forceRefresh },
    );
    return Response.json(
      { data: portfolio },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "The portfolio could not be saved.");
  }
}
