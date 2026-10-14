import { getLocalEtfDetail } from "@/data/services/local-etf-service";
import { withSiteAccess } from "@/server/site-route";

export const GET = withSiteAccess(async (request: Request, context: { params: Promise<{ etfId: string }> }) => {
  const { etfId } = await context.params;
  return Response.json({ data: await getLocalEtfDetail(etfId, { forceRefresh: new URL(request.url).searchParams.get("refresh") === "true" }) });
}, "portfolio-detail");
