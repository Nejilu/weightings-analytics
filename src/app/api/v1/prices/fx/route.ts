import { getFxRate } from "@/data/services/market-price-service";
import { SUPPORTED_CASH_CURRENCIES } from "@/domain/portfolio";

export async function GET(request: Request) {
  const currency = new URL(request.url).searchParams
    .get("currency")
    ?.trim()
    .toUpperCase();

  if (
    !currency ||
    !SUPPORTED_CASH_CURRENCIES.some((candidate) => candidate === currency)
  ) {
    return Response.json(
      { error: "A supported currency is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const rate = await getFxRate(currency);
    return Response.json(
      { data: rate },
      {
        headers: {
          "Cache-Control": rate.sourceStatus === "stale"
            ? "no-store"
            : "private, max-age=60",
        },
      },
    );
  } catch {
    return Response.json(
      { error: `The ${currency} exchange rate is unavailable.` },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
