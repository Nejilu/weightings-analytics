import { getPortfolioDashboard } from "@/data/services/portfolio-dashboard-service";
import { withSiteAccess } from "@/server/site-route";

export const GET = withSiteAccess(() => Response.json({ data: getPortfolioDashboard() }), "portfolio-overview");
