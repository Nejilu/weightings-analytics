import { getPortfolioDividends, recordDividendPayment, updateDividendPayment } from "@/data/services/portfolio-dividends-service";
import { DividendRequestError } from "@/domain/dividends";
import { withSiteAccess } from "@/server/site-route";

function id(request: Request) {
  const value = new URL(request.url).searchParams.get("portfolioId");
  if (!value || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new DividendRequestError("A valid portfolio ID is required.");
  return value;
}
function failure(error: unknown) {
  return Response.json({ error: error instanceof DividendRequestError ? error.message : "Dividend data is temporarily unavailable." }, { status: error instanceof DividendRequestError || error instanceof SyntaxError ? 400 : 503 });
}
export const GET = withSiteAccess(async (request: Request) => {
  try { return Response.json({ data: await getPortfolioDividends(id(request)) }); } catch (error) { return failure(error); }
}, "owner");
export const POST = withSiteAccess(async (request: Request) => {
  try { return Response.json({ data: recordDividendPayment(id(request), await request.json()) }); } catch (error) { return failure(error); }
}, "owner");
export const PATCH = withSiteAccess(async (request: Request) => {
  try { return Response.json({ data: updateDividendPayment(id(request), await request.json()) }); } catch (error) { return failure(error); }
}, "owner");
