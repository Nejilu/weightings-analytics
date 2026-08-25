import { ensureLocalDatabase } from "@/db/bootstrap";
import { getSqlite } from "@/db/client";

export function GET() {
  try {
    ensureLocalDatabase();
    getSqlite().prepare("SELECT 1").get();
  } catch {
    return Response.json(
      {
        status: "unhealthy",
        service: "weightings-analytics",
        database: { status: "unavailable" },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      status: "healthy",
      service: "weightings-analytics",
      version: "0.1.0",
      database: {
        status: "ready",
      },
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
