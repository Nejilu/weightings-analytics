import {
  deleteLocalEtf,
  LocalEtfNotFoundError,
  LocalEtfRequestError,
  updateLocalEtf,
} from "@/data/services/local-etf-service";

function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof LocalEtfRequestError) {
    return Response.json(
      { error: error.message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof LocalEtfNotFoundError) {
    return Response.json(
      { error: error.message },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { error: fallback },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ etfId: string }> },
) {
  try {
    const { etfId } = await context.params;
    const payload = (await request.json()) as {
      ticker?: string;
      name?: string;
      description?: string;
    };
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.ticker !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.description !== "string"
    ) {
      return Response.json(
        { error: "Ticker, ETF name and description are required." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        data: updateLocalEtf(etfId, {
          ticker: payload.ticker,
          name: payload.name,
          description: payload.description,
        }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "The local ETF could not be updated.");
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ etfId: string }> },
) {
  try {
    const { etfId } = await context.params;
    deleteLocalEtf(etfId);
    return Response.json(
      { data: { id: etfId } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "The local ETF could not be deleted.");
  }
}
