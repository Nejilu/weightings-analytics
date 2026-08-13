import {
  getHoldingsSnapshot,
  HoldingsUnavailableError,
} from "@/data/services/holdings-service";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { findEtfByReference } from "@/db/repositories/catalog-repository";
import { analyzeHoldings } from "@/domain/processors/analyze-holdings";

const ACWI_REFERENCE = "acwi-us";

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  try {
    ensureLocalDatabase();
    if (!findEtfByReference(ticker)) {
      return Response.json(
        { error: "Unsupported ETF." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    const target = await getHoldingsSnapshot(ticker);
    const acwi =
      target.etf.id === ACWI_REFERENCE
        ? target
        : await getHoldingsSnapshot(ACWI_REFERENCE);
    const data = analyzeHoldings(target, acwi);

    return Response.json(
      { data },
      {
        headers: {
          "Cache-Control":
            target.sourceStatus === "stale" || acwi.sourceStatus === "stale"
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
      { error: "Holdings analysis failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
