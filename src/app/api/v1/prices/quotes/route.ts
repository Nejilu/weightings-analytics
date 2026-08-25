import { getAvailableSecurityListingPrices } from "@/data/services/market-price-service";

const MAX_SECURITY_IDS = 30;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      quotes?: Array<{ key?: string; securityId?: string; ticker?: string }>;
      refresh?: boolean;
    };
    const quotes = Array.isArray(payload.quotes)
      ? [...new Map(payload.quotes.map((quote) => [quote.key?.trim(), {
          key: quote.key?.trim() ?? "",
          securityId: quote.securityId?.trim() ?? "",
          ticker: quote.ticker?.trim() ?? "",
        }])).values()]
      : [];
    if (
      quotes.length === 0 ||
      quotes.length > MAX_SECURITY_IDS ||
      quotes.some(
        (quote) =>
          !quote.key ||
          !quote.securityId ||
          !quote.ticker ||
          quote.key.length > 100 ||
          quote.securityId.length > 100 ||
          quote.ticker.length > 30,
      )
    ) {
      return Response.json(
        { error: `Select between 1 and ${MAX_SECURITY_IDS} securities.` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const prices = await getAvailableSecurityListingPrices(
      quotes,
      { forceRefresh: payload.refresh === true },
    );
    return Response.json(
      { data: [...prices.values()] },
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: "Request body must be valid JSON." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { error: "Security prices could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
