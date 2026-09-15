import { eq } from "drizzle-orm";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { etfs } from "@/db/schema";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { isEtfVisibility } from "@/domain/visibility";
import { withSiteAccess } from "@/server/site-route";
import { AccessError } from "@/server/site-access";

export const PATCH = withSiteAccess(
  async (request: Request, context: { params: Promise<{ etfId: string }> }) => {
    const { etfId } = await context.params;
    const payload = await request.json();
    if (!isEtfVisibility(payload?.visibility))
      throw new AccessError(400, "Invalid ETF visibility.");
    ensureLocalDatabase();
    const etf = findEtfById(etfId);
    if (!etf || (etf.fundType !== "portfolio" && etf.fundType !== "custom"))
      throw new AccessError(404, "ETF unavailable.");
    getDb()
      .update(etfs)
      .set({
        visibility: payload.visibility,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(etfs.id, etf.id))
      .run();
    return Response.json({ data: findEtfById(etf.id) });
  },
  "owner",
);
