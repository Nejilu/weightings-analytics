import {
  getHoldingsSnapshot,
  HoldingsUnavailableError,
} from "@/data/services/holdings-service";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { findEtfByReference } from "@/db/repositories/catalog-repository";

export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  try {
    ensureLocalDatabase();
  } catch {
    return Response.json(
      { error: "Holdings data is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  let etf: ReturnType<typeof findEtfByReference>;
  try {
    etf = findEtfByReference(ticker);
  } catch {
    return Response.json(
      { error: "Holdings data is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!etf) {
    return Response.json(
      { error: "Unsupported ETF." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "true";
    const snapshot = await getHoldingsSnapshot(ticker, { forceRefresh });
    return Response.json(
      { data: snapshot },
      {
        headers: {
          "Cache-Control":
            forceRefresh || snapshot.sourceStatus === "stale"
              ? "no-store"
              : "public, max-age=300, s-maxage=86400, stale-while-revalidate=3600",
        },
      },
    );
  } catch (error) {
    if (error instanceof HoldingsUnavailableError) {
      return Response.json(
        {
          error: `${error.message} No substitute figures are shown.`,
          unavailable: [error.reference],
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { error: "Holdings request failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
