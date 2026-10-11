import { getPortfolioEvents, PortfolioEventsRequestError } from "@/data/services/portfolio-events-service";
import { withSiteAccess } from "@/server/site-route";

async function handleGET(request: Request) {
  const ids = new URL(request.url).searchParams.getAll("securityId").map((id) => id.trim());
  try {
    return Response.json({ data: await getPortfolioEvents(ids) });
  } catch (error) {
    const invalid = error instanceof PortfolioEventsRequestError;
    return Response.json({ error: invalid ? error.message : "The earnings calendar is temporarily unavailable." },
      { status: invalid ? 400 : 503 });
  }
}

export const GET = withSiteAccess(handleGET, "read");
