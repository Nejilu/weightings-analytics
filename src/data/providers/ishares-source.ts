import type { EtfShareClass } from "@/domain/etf";

interface IsharesHoldingsFile {
  raw: string;
  sourceUrl: string;
}

const CSV_ACCEPT_HEADER = "text/csv,text/plain;q=0.9,*/*;q=0.8";
const LEGACY_UK_DOWNLOAD_ID = "1506575576011.ajax";
const CURRENT_CH_DOWNLOAD_ID = "1495092304805.ajax";
const BLACKROCK_PRODUCT_DATA_PATH =
  "product-data/product-data/api/v2/get-product-data";
const BLACKROCK_PRODUCT_DATA_CONFIG = {
  us: {
    host: "blk-one01",
    targetSite: "us-ishares",
    locale: "en_US",
  },
  uk: {
    host: "uk-retail01",
    targetSite: "uk-ishares",
    locale: "en_GB",
  },
} as const;
const MINIMUM_EXPECTED_HOLDINGS: Record<string, number> = {
  "acwi-us": 2_000,
  "bgsix-us": 50,
  "csemas-ucits": 500,
};

export function isPlausibleIsharesHoldingsCount(
  etfId: string,
  count: number,
): boolean {
  return count >= (MINIMUM_EXPECTED_HOLDINGS[etfId] ?? 5);
}

export function assertPlausibleIsharesHoldingsCount(
  etf: Pick<EtfShareClass, "id" | "ticker">,
  count: number,
): void {
  if (!isPlausibleIsharesHoldingsCount(etf.id, count)) {
    throw new Error(
      `The ${etf.ticker} holdings download appears incomplete (${count} rows).`,
    );
  }
}

function productDataCandidate(
  url: string,
  productUrl?: string,
): string | null {
  const productReference = productUrl ?? url;
  let parsed: URL;
  try {
    parsed = new URL(productReference);
  } catch {
    return null;
  }
  if (parsed.hostname !== "www.ishares.com") return null;

  const productMatch = parsed.pathname.match(
    /^\/(us\/products|uk\/individual\/en\/products)\/(\d+)(?:\/|$)/i,
  );
  if (!productMatch?.[2]) return null;
  const region = productMatch[1].toLowerCase().startsWith("us/")
    ? "us"
    : "uk";
  const config = BLACKROCK_PRODUCT_DATA_CONFIG[region];
  const productData = new URL(
    `https://www.blackrock.com/varnish-api/${config.host}-${BLACKROCK_PRODUCT_DATA_PATH}`,
  );
  productData.search = new URLSearchParams({
    portfolioId: productMatch[2],
    component: "holdings",
    appType: "PRODUCT_PAGE",
    appSubType: "ISHARES",
    targetSite: config.targetSite,
    locale: config.locale,
    userType: "individual",
  }).toString();
  return productData.toString();
}

export function holdingsSourceCandidates(
  sourceUrl: string,
  productUrl?: string,
): string[] {
  const candidates: string[] = [];

  try {
    const productData = productDataCandidate(sourceUrl, productUrl);
    if (productData) candidates.push(productData);
    candidates.push(sourceUrl);
    const fallback = new URL(sourceUrl);
    const isLegacyUkDownload =
      fallback.hostname === "www.ishares.com" &&
      fallback.pathname.includes("/uk/individual/en/") &&
      fallback.pathname.includes(`/${LEGACY_UK_DOWNLOAD_ID}`);

    if (isLegacyUkDownload) {
      fallback.pathname = fallback.pathname
        .replace("/uk/individual/en/", "/ch/individual/en/")
        .replace(LEGACY_UK_DOWNLOAD_ID, CURRENT_CH_DOWNLOAD_ID);
      candidates.push(fallback.toString());
    }
  } catch {
    // The primary URL will produce the actionable fetch error.
    candidates.push(sourceUrl);
  }

  return [...new Set(candidates)];
}

export function assertCsvPayload(contentType: string, raw: string): void {
  const beginning = raw.trimStart().slice(0, 32).toLowerCase();
  if (
    contentType.toLowerCase().includes("text/html") ||
    beginning.startsWith("<!doctype html") ||
    beginning.startsWith("<html")
  ) {
    throw new Error("iShares returned an HTML page instead of a holdings CSV.");
  }
}

function assertCsvContainsRows(raw: string): number {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const columns = line.split(",").map((column) =>
      column.trim().replace(/^"|"$/g, "").toLowerCase(),
    );
    return (
      columns.includes("name") &&
      columns.some((column) => column === "weight" || column === "weight (%)")
    );
  });
  if (headerIndex < 0) {
    throw new Error("Unable to locate the iShares holdings CSV headers.");
  }

  const dataRows = lines
    .slice(headerIndex + 1)
    .filter((line) => line.trim().length > 0);
  if (dataRows.length < 5) {
    throw new Error(
      `iShares returned an incomplete holdings CSV (${dataRows.length} rows).`,
    );
  }
  return dataRows.length;
}

function blackrockLatestDate(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      componentsByNameMap?: {
        holdings?: {
          containersByNameMap?: {
            all?: {
              dataPointsByNameMap?: {
                dateList?: { value?: unknown };
              };
            };
          };
        };
      };
    };
    const date = parsed.componentsByNameMap?.holdings?.containersByNameMap?.all
      ?.dataPointsByNameMap?.dateList?.value;
    const publishedDates = Array.isArray(date)
      ? date
        .map((value) => String(value))
        .filter((value) => /^\d{8}$/.test(value))
        .sort()
      : [];
    return publishedDates.at(-1) ?? null;
  } catch {
    return null;
  }
}

function assertBlackrockRows(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as {
      componentsByNameMap?: {
        holdings?: {
          containersByNameMap?: {
            all?: {
              dataPointsByNameMap?: {
                ticker?: { value?: unknown };
                holdingPercent?: { value?: unknown };
              };
            };
          };
        };
      };
    };
    const dataPoints =
      parsed.componentsByNameMap?.holdings?.containersByNameMap?.all
        ?.dataPointsByNameMap;
    const tickers = dataPoints?.ticker?.value;
    const weights = dataPoints?.holdingPercent?.value;
    if (
      !Array.isArray(tickers) ||
      !Array.isArray(weights) ||
      tickers.length < 5 ||
      weights.length < 5
    ) {
      throw new Error("BlackRock returned no usable holdings rows.");
    }
    return Math.min(tickers.length, weights.length);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no usable")) {
      throw error;
    }
    throw new Error("BlackRock returned an invalid holdings response.");
  }
}

async function fetchBlackrockDatedPayload(
  etf: Pick<EtfShareClass, "id" | "ticker">,
  sourceUrl: string,
  metadataRaw: string,
  request: (url: string) => Promise<Response>,
): Promise<{ raw: string; sourceUrl: string }> {
  const latestDate = blackrockLatestDate(metadataRaw);
  if (!latestDate) {
    throw new Error("BlackRock did not publish a latest holdings date.");
  }

  const datedUrl = new URL(sourceUrl);
  datedUrl.searchParams.set("asOfDate", latestDate);
  const response = await request(datedUrl.toString());
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const raw = await response.text();
  assertCsvPayload(response.headers.get("content-type") ?? "", raw);
  assertPlausibleIsharesHoldingsCount(etf, assertBlackrockRows(raw));
  return { raw, sourceUrl: datedUrl.toString() };
}

export async function fetchIsharesHoldingsFile(
  etf: EtfShareClass,
): Promise<IsharesHoldingsFile> {
  const failures: string[] = [];

  for (const sourceUrl of holdingsSourceCandidates(etf.holdingsUrl, etf.productUrl)) {
    try {
      const request = (url: string) =>
        fetch(url, {
          headers: {
            Accept: url.includes(BLACKROCK_PRODUCT_DATA_PATH)
              ? "application/json,*/*;q=0.8"
              : CSV_ACCEPT_HEADER,
            "User-Agent": "IndexLens/0.1 holdings-research",
          },
          // SQLite is the single 24-hour holdings cache. Reusing Next's
          // revalidation cache here can return a stale response once and then
          // persist it with a fresh SQLite timestamp, delaying new holdings by
          // another full TTL.
          cache: "no-store",
          signal: AbortSignal.timeout(12_000),
        });

      const response = await request(sourceUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const raw = await response.text();
      assertCsvPayload(response.headers.get("content-type") ?? "", raw);
      if (sourceUrl.includes("/varnish-api/") && sourceUrl.includes(BLACKROCK_PRODUCT_DATA_PATH)) {
        return await fetchBlackrockDatedPayload(etf, sourceUrl, raw, request);
      }
      assertPlausibleIsharesHoldingsCount(etf, assertCsvContainsRows(raw));
      return { raw, sourceUrl };
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "Unknown source error",
      );
    }
  }

  throw new Error(
    `iShares holdings source unavailable: ${failures.join("; ")}`,
  );
}
