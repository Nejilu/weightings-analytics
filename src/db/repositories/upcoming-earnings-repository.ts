import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { UpcomingEarningsObservation } from "@/domain/upcoming-earnings";
import { getDb } from "../client";
import { metricDefinitions, metricObservations } from "../schema";

const DEFINITION_ID = "security:upcoming_earnings:v1";

export function loadUpcomingEarnings(securityIds: string[]): Map<string, UpcomingEarningsObservation> {
  const result = new Map<string, UpcomingEarningsObservation>();
  if (!securityIds.length) return result;
  const rows = getDb().select().from(metricObservations).where(and(
    eq(metricObservations.metricDefinitionId, DEFINITION_ID),
    eq(metricObservations.entityType, "security"),
    inArray(metricObservations.entityId, securityIds),
  )).orderBy(desc(metricObservations.capturedAt)).all();
  for (const row of rows) {
    if (result.has(row.entityId)) continue;
    const data = row.valueJson as Partial<UpcomingEarningsObservation> | null;
    if (!data || typeof data.providerSymbol !== "string"
      || !(data.reportDate === null || (typeof data.reportDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.reportDate)))
      || !(data.exchangeTimezone === null || typeof data.exchangeTimezone === "string")) continue;
    try { new Intl.DateTimeFormat("en-US", { timeZone: data.exchangeTimezone ?? "UTC" }); } catch { continue; }
    result.set(row.entityId, {
      providerSymbol: data.providerSymbol, reportDate: data.reportDate,
      exchangeTimezone: data.exchangeTimezone, capturedAt: row.capturedAt,
    });
  }
  return result;
}

export function saveUpcomingEarningsBatch(
  inputs: Array<{ securityId: string; observation: Omit<UpcomingEarningsObservation, "capturedAt"> }>,
  capturedAt: string,
): void {
  if (!inputs.length) return;
  for (const { observation } of inputs) {
    if (typeof observation.providerSymbol !== "string" || !observation.providerSymbol.trim() ||
        !(observation.reportDate === null || (typeof observation.reportDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(observation.reportDate))) ||
        !(observation.exchangeTimezone === null || typeof observation.exchangeTimezone === "string")) {
      throw new Error("Invalid earnings observation; the previous cache is preserved.");
    }
    new Intl.DateTimeFormat("en-US", { timeZone: observation.exchangeTimezone ?? "UTC" });
  }
  getDb().transaction((transaction) => {
    transaction.insert(metricDefinitions).values({
      id: DEFINITION_ID, key: "upcoming_earnings", name: "Next earnings report date",
      description: "Scheduled earnings date from TradingView Screener in the listing's timezone; may be estimated.",
      entityType: "security", valueType: "json", frequency: "daily", version: 1,
      formulaJson: { provider: "tradingview", column: "earnings_release_next_date", timezoneColumn: "timezone" },
    }).onConflictDoNothing().run();
    for (const input of inputs) {
      transaction.insert(metricObservations).values({
        id: randomUUID(), metricDefinitionId: DEFINITION_ID, entityType: "security", entityId: input.securityId,
        asOf: capturedAt.slice(0, 10), valueText: input.observation.providerSymbol,
        valueJson: input.observation, source: "tradingview-screener", capturedAt,
      }).onConflictDoUpdate({
        target: [metricObservations.metricDefinitionId, metricObservations.entityType, metricObservations.entityId],
        set: { asOf: sql`excluded.as_of`, valueText: sql`excluded.value_text`, valueJson: sql`excluded.value_json`, capturedAt: sql`excluded.captured_at` },
        setWhere: lte(metricObservations.capturedAt, sql`excluded.captured_at`),
      }).run();
    }
  });
}
