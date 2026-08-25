import { getMarketPrice } from "@/data/services/market-price-service";
import {
  MarketPriceRequestError,
  MarketPriceUnavailableError,
  type PortfolioAssetKind,
} from "@/domain/portfolio";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") as PortfolioAssetKind | null;
  const referenceId = url.searchParams.get("referenceId")?.trim();
  const forceRefresh = url.searchParams.get("refresh") === "true";
  if (
    (kind !== "etf" && kind !== "security") ||
    !referenceId ||
    referenceId.length > 100
  ) {
    return Response.json(
      { error: "A valid asset kind and reference id are required." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const price = await getMarketPrice(kind, referenceId, { forceRefresh });
    return Response.json(
      { data: price },
      {
        headers: {
          "Cache-Control": forceRefresh || price.sourceStatus === "stale"
            ? "no-store"
            : "private, max-age=60",
        },
      },
    );
  } catch (error) {
    if (error instanceof MarketPriceRequestError) {
      return Response.json(
        { error: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof MarketPriceUnavailableError) {
      return Response.json(
        { error: error.message || "The market price is unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { error: "The market price could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
