import { withSiteAccess } from "@/server/site-route";
import { getCatalog } from "@/data/services/catalog-service";

function handleGET() {
  try {
    return Response.json(
      { data: getCatalog() },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "The ETF catalog is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = withSiteAccess(handleGET, "catalog");
