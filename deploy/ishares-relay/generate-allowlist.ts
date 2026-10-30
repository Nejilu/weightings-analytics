import { writeFileSync } from "node:fs";
import { ETF_CATALOG } from "../../src/data/catalog";
import { holdingsSourceCandidates } from "../../src/data/providers/ishares-source";
import { ETF_QUOTE_SOURCES } from "../../src/data/etf-quote-sources";

const urls = [...new Set(ETF_CATALOG.flatMap((group) => group.variants)
  .filter((etf) => !etf.holdingsSourceEtfId && !etf.derivedHoldings)
  .flatMap((etf) => [
    ...holdingsSourceCandidates(etf.holdingsUrl, etf.productUrl),
    ...(ETF_QUOTE_SOURCES[etf.id]?.source === "BlackRock" ? [etf.productUrl] : []),
  ])
  .filter((value) => ["www.ishares.com", "www.blackrock.com"].includes(new URL(value).hostname))
  .map((value) => new URL(value).toString()))].sort();
writeFileSync(new URL("./allowed-urls.json", import.meta.url), JSON.stringify(urls, null, 2) + "\n");
console.log(`Generated ${urls.length} provider URLs.`);
