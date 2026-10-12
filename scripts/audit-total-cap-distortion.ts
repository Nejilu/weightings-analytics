import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getHoldingsSnapshot } from "../src/data/services/holdings-service";
import { getCapitalizationReference } from "../src/data/services/capitalization-reference-service";
import { analyzeHoldings } from "../src/domain/processors/analyze-holdings";
import { calculateTotalCapDistortion } from "../src/domain/processors/calculate-total-cap-distortion";
import { calculateHoldingsDistortion } from "../src/domain/processors/calculate-holdings-distortion";
import { closeDatabase } from "../src/db/client";
import type { DistortionMode } from "../src/domain/holdings-analysis";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const references = (argument("etfs") ?? "ivv-us,qtop-us,acwi-us").split(",").filter(Boolean);
const output = resolve(argument("out") ?? "reports/total-cap-distortion-audit.json");
if (!references.length || references.length > 10) throw new Error("Select 1–10 ETFs.");

async function currencyProbe() {
  const symbols = ["NASDAQ:AAPL", "NASDAQ:GOOG", "NASDAQ:GOOGL", "NYSE:BRK.B", "NYSE:TSM", "TWSE:2330", "TSE:7203", "HKEX:700", "EURONEXT:ASML", "NASDAQ:ASML", "KRX:005930", "NSE:RELIANCE"];
  const scan = async (conversion: Record<string, string | boolean>) => {
    const response = await fetch("https://scanner.tradingview.com/global/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: { tickers: symbols, query: { types: [] } }, columns: ["name", "currency", "market_cap_basic"], price_conversion: conversion }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Currency probe HTTP ${response.status}`);
    return (await response.json() as { data: { s: string; d: [string, string, number | null] }[] }).data;
  };
  const [usd, eur, local] = await Promise.all([scan({ to_currency: "usd" }), scan({ to_currency: "eur" }), scan({ to_symbol: true })]);
  return usd.map((row) => ({ symbol: row.s, quoteCurrency: row.d[1], capUsd: row.d[2],
    capEur: eur.find((value) => value.s === row.s)?.d[2], capQuoteCurrency: local.find((value) => value.s === row.s)?.d[2],
  }));
}

try {
  const startedAt = new Date().toISOString();
  const currencyChecks = await currencyProbe();
  const acwi = await getHoldingsSnapshot("acwi-us");
  const funds = [];
  for (const reference of references) {
    const target = await getHoldingsSnapshot(reference);
    const analysis = analyzeHoldings(target, acwi);
    const capitalizations = await getCapitalizationReference(reference, "market");
    const modes = (["top-holdings", "all-holdings", "market-coverage"] as DistortionMode[]).map((mode) => {
      const full = calculateTotalCapDistortion(analysis.positions, analysis.distortionReferencePositions, analysis.distortion, capitalizations, mode);
      const free = calculateHoldingsDistortion(analysis.positions, analysis.distortionReferencePositions, analysis.distortion, mode);
      return { mode, freeFloatScore: free.distortion.score, totalCapScore: full.distortion.score,
        selectedCoverage: full.distortion.coverageWeight, referenceCoverage: full.distortion.capitalizationCoverage?.referenceWeightCoverage,
        selectedHoldings: full.distortion.eligibleHoldings, benchmarkHoldings: full.distortion.referenceHoldings,
        excluded: full.distortion.capitalizationCoverage?.excludedHoldings,
        largestCounterfactualWeights: [...full.positions].sort((a, b) => (b.counterfactualWeight ?? 0) - (a.counterfactualWeight ?? 0)).slice(0, 5)
          .map((p) => ({ ticker: p.ticker, weight: p.counterfactualWeight })),
      };
    });
    const observations = capitalizations.observations;
    // Equal company caps across distinct IDs can reveal unmerged share classes.
    // This is a review cue, not a reason to merge companies automatically.
    const capGroups = new Map<string, string[]>();
    for (const row of observations.filter((row) => row.marketCapUsd !== null)) {
      const key = row.marketCapUsd!.toPrecision(10);
      if (row.companyId?.startsWith("company:")) continue;
      capGroups.set(key, [...(capGroups.get(key) ?? []), `${row.securityId} · ${row.ticker}`]);
    }
    const fund = { reference, ticker: analysis.etf.ticker, holdingsAsOf: analysis.asOf, sourceStatus: analysis.sourceStatus, modes,
      observations, issues: observations.filter((row) => row.status !== "available"),
      duplicateCapReview: [...capGroups.values()].filter((ids) => ids.length > 1),
    };
    funds.push(fund);
    console.log(JSON.stringify({ ticker: fund.ticker, modes, issueCount: fund.issues.length, duplicateCapReview: fund.duplicateCapReview }));
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), currencyChecks, funds }, null, 2));
  const markdown = [
    "# Test des capitalisations totales pour le Distortion Index", "", `Capture : ${startedAt}.`, "",
    "Le contrefactuel utilise une capitalisation par société, en USD. Les poids des titres équivalents sont additionnés, mais leurs capitalisations ne le sont jamais. Le regroupement supplémentaire exige un nom de société normalisé concordant, le même identifiant de logo TradingView et des capitalisations à moins de 1 % d'écart. Ce rapprochement reste une estimation et ne remplace pas un référentiel juridique d'émetteurs.", "",
    "| ETF | Vue | Free float | Capitalisation totale | Couverture positions | Couverture référence | Exclusions |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...funds.flatMap((fund) => fund.modes.map((mode) => `| ${fund.ticker} | ${mode.mode} | ${mode.freeFloatScore?.toFixed(2) ?? "—"} | ${mode.totalCapScore?.toFixed(2) ?? "—"} | ${mode.selectedCoverage.toFixed(4)} % | ${mode.referenceCoverage?.toFixed(4)} % | ${mode.excluded} |`)),
    "", "## Contrôles de devises", "",
    `Échantillon : ${currencyChecks.length} cotations, ${new Set(currencyChecks.map((row) => row.quoteCurrency)).size} devises de cotation. La requête demande explicitement USD, puis EUR et la devise du titre pour vérifier la conversion.`, "",
    "| Cotation | Devise du titre | Capitalisation USD, milliards | Capitalisation EUR, milliards |",
    "|---|---|---:|---:|",
    ...currencyChecks.map((row) => `| ${row.symbol} | ${row.quoteCurrency} | ${row.capUsd === null ? "—" : (row.capUsd / 1e9).toFixed(2)} | ${row.capEur == null ? "—" : (row.capEur / 1e9).toFixed(2)} |`),
    "", "## Qualité et limites", "",
    ...funds.map((fund) => `- ${fund.ticker} : holdings au ${fund.holdingsAsOf}, ${fund.issues.length} capitalisations manquantes ou non résolues ; ${fund.duplicateCapReview.length} groupes de capitalisations identiques restant à examiner. Le JSON conserve tous les symboles, valeurs, dates de capture et motifs d'exclusion.`),
    "- Les valeurs négatives, nulles, non finies ou supérieures à 100 000 milliards USD sont exclues. Les listings équivalents avec des caps divergentes de plus de 25 % sont exclus. Ces contrôles détectent des erreurs grossières ; ils ne certifient pas l'exactitude de chaque valorisation.",
    "- Les seuils de couverture sont calculés avec les poids publiés, car la capitalisation des valeurs manquantes est inconnue. Les scores partiels renormalisent les distributions disponibles. Le score est masqué sous 95 % de couverture sélectionnée, ou sous 99 % de poids ACWI couvert pour Market Coverage.",
    "- Les capitalisations et les poids officiels ne sont pas nécessairement datés du même jour : l'écart mesuré inclut aussi les mouvements de cours entre les captures. Ce test ne compare pas chaque valorisation à une seconde source indépendante.", "",
    "Sources : [méthodologie TradingView](https://www.tradingview.com/support/solutions/43000597015-market-capitalization/), [conversion des devises](https://www.tradingview.com/support/solutions/43000639101-currency-conversion-in-the-stock-screener/).",
  ].join("\n");
  await writeFile(output.replace(/\.json$/i, "") + ".md", markdown);
  console.log(`Audit saved: ${output}`);
} finally { closeDatabase(); }
