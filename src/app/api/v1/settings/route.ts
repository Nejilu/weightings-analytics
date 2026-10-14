import { ensureLocalDatabase } from "@/db/bootstrap";
import { dividendSettingsCatalog, loadDividendSettings, persistDividendSettings } from "@/db/repositories/dividend-repository";
import { countryDividendRule } from "@/data/dividend-withholding";
import { DividendRequestError } from "@/domain/dividends";
import { withSiteAccess } from "@/server/site-route";

export const GET = withSiteAccess(async () => {
  ensureLocalDatabase();
  const catalog = dividendSettingsCatalog();
  return Response.json({ data: { dividends: loadDividendSettings(), countryRules: catalog.countries.map(countryDividendRule), securities: catalog.securities, checkedAt: "2026-10-13" } });
}, "owner");

export const PUT = withSiteAccess(async (request: Request) => {
  try {
    ensureLocalDatabase();
    const payload = await request.json();
    return Response.json({ data: { dividends: persistDividendSettings(payload?.dividends) } });
  } catch (error) {
    return Response.json({ error: error instanceof DividendRequestError ? error.message : "Invalid settings." }, { status: 400 });
  }
}, "owner");
