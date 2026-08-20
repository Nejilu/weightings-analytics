import {
  getHoldingsSnapshot,
  HoldingsUnavailableError,
} from "@/data/services/holdings-service";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { findEtfByReference } from "@/db/repositories/catalog-repository";
import { compareHoldings } from "@/domain/processors/compare-holdings";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const leftReference = url.searchParams.get("left")?.trim() ?? "";
    const rightReference = url.searchParams.get("right")?.trim() ?? "";
    const includeCash = url.searchParams.get("includeCash") === "true";

    let validSelection = false;
    try {
      ensureLocalDatabase();
      validSelection = Boolean(
        findEtfByReference(leftReference) &&
        findEtfByReference(rightReference),
      );
    } catch {
      return Response.json(
        { error: "Comparison data is temporarily unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!validSelection) {
      return Response.json(
        {
          error:
            "Invalid selection. Use two tickers available in the catalog.",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const snapshots = await Promise.allSettled([
      getHoldingsSnapshot(leftReference),
      getHoldingsSnapshot(rightReference),
    ]);

    const rejected = snapshots.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const unavailable = rejected.flatMap((result) =>
      result.reason instanceof HoldingsUnavailableError
        ? [result.reason.reference]
        : [],
    );

    if (rejected.length > 0) {
      if (unavailable.length !== rejected.length) {
        return Response.json(
          { error: "Comparison failed." },
          { status: 500, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        {
          error: `Data unavailable for ${unavailable.join(" and ")}. No substitute figures are shown.`,
          unavailable,
        },
        {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const [left, right] = snapshots.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("Inconsistent loading state.");
      }
      return result.value;
    });

    return Response.json(
      { data: compareHoldings(left, right, { includeCash }) },
      {
        headers: {
          "Cache-Control":
            left.sourceStatus === "stale" ||
            right.sourceStatus === "stale"
              ? "no-store"
              : "public, max-age=300, s-maxage=86400, stale-while-revalidate=3600",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "Comparison failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
