import assert from "node:assert/strict";
import test from "node:test";
import { dashboardSeries, portfolioPeriodStart, type PortfolioPeriod, type PortfolioDashboardEntry } from "./portfolio-dashboard";

const entry: PortfolioDashboardEntry = {
  id: "a", ticker: "A", name: "A", visibility: "weights", positionsCount: 1, cashCount: 0,
  snapshots: [
    { date: "2026-10-01", indexUsd: 100, indexEur: 100 },
    { date: "2026-10-03", indexUsd: 120, indexEur: 110 },
    { date: "2026-10-05", indexUsd: 132, indexEur: 99 },
  ],
};

test("relative series rebase at the first saved observation on or after the chosen date", () => {
  const usd = dashboardSeries([entry], "relative", "USD", "2026-10-02")[0];
  assert.equal(usd.baselineDate, "2026-10-03");
  assert.deepEqual(usd.points.map((point) => point.date), ["2026-10-03", "2026-10-05"]);
  assert.equal(usd.points[0].value, 0);
  assert.ok(Math.abs(usd.points[1].value - 10) < 0.000001);
  const eur = dashboardSeries([entry], "relative", "EUR", "2026-10-03")[0];
  assert.ok(Math.abs(eur.points[1].value + 10) < 0.000001);
  assert.deepEqual(dashboardSeries([entry], "relative", "USD", "2026-11-01"), []);
});

test("absolute series need published amounts; relative-only records cannot be plotted as currency", () => {
  assert.deepEqual(dashboardSeries([entry], "absolute", "USD", ""), []);
  const full = { ...entry, snapshots: entry.snapshots.map((point) => ({ ...point, valueUsd: point.indexUsd * 1000, valueEur: point.indexEur * 800 })) };
  assert.deepEqual(dashboardSeries([full], "absolute", "EUR", "2026-10-02")[0].points.map((point) => point.value), [88000, 79200]);
  assert.equal(entry.snapshots[0].indexUsd, 100);
});

test("different histories retain their actual baseline dates without inventing missing observations", () => {
  const later = { ...entry, id: "b", snapshots: entry.snapshots.slice(1) };
  const result = dashboardSeries([entry, later], "relative", "USD", "2026-10-01");
  assert.deepEqual(result.map((series) => series.baselineDate), ["2026-10-01", "2026-10-03"]);
  assert.deepEqual(result.map((series) => series.points[0].value), [0, 0]);
});

test("presets set the date even with short histories; custom dates can be overridden again", () => {
  const earliest = "2026-10-09", latest = "2026-10-12";
  assert.equal(portfolioPeriodStart({ preset: "All" }, earliest, latest), earliest);
  assert.equal(portfolioPeriodStart({ preset: "1M" }, earliest, latest), "2026-09-12");
  assert.equal(portfolioPeriodStart({ preset: "3M" }, earliest, latest), "2026-07-12");
  assert.equal(portfolioPeriodStart({ preset: "1Y" }, earliest, latest), "2025-10-12");
  const selections: PortfolioPeriod[] = [{ preset: "1M" }, { date: "2026-10-10" }, { preset: "1M" }, { preset: "All" }];
  assert.deepEqual(selections.map((period) => portfolioPeriodStart(period, earliest, latest)), ["2026-09-12", "2026-10-10", "2026-09-12", earliest]);
  assert.equal(portfolioPeriodStart({ preset: "1M" }, earliest, "2026-10-13"), "2026-09-13");
});

test("calendar presets clamp month ends and leap days", () => {
  assert.equal(portfolioPeriodStart({ preset: "1M" }, "2025-01-01", "2026-03-31"), "2026-02-28");
  assert.equal(portfolioPeriodStart({ preset: "1M" }, "2023-01-01", "2024-03-31"), "2024-02-29");
  assert.equal(portfolioPeriodStart({ preset: "1Y" }, "2023-01-01", "2024-02-29"), "2023-02-28");
});

test("invested comparison uses its own USD/EUR indices and never bridges unavailable history", () => {
  const active = { ...entry, snapshots: entry.snapshots.map((p, i) => ({ ...p, investedIndexUsd: [100, 110, 121][i], investedIndexEur: [100, 120, 132][i], investedSegment: "2026-10-01" })) };
  const result = dashboardSeries([active], "relative", "USD", "2026-10-02", "invested")[0];
  assert.equal(result.baselineDate, "2026-10-03");
  assert.ok(Math.abs(result.points[1].value - 10) < 1e-9);
  assert.deepEqual(dashboardSeries([active], "absolute", "USD", "", "invested"), []);
  assert.deepEqual(dashboardSeries([entry], "relative", "USD", "", "invested"), []);
  const restarted = { ...active, snapshots: [...active.snapshots, { date: "2026-10-06", indexUsd: 150, indexEur: 150 }] };
  assert.equal(dashboardSeries([restarted], "relative", "USD", "", "invested")[0].points.at(-1)!.date, "2026-10-05");
  restarted.snapshots.push({ date: "2026-10-07", indexUsd: 160, indexEur: 160, investedIndexUsd: 100, investedIndexEur: 100, investedSegment: "2026-10-07" });
  assert.deepEqual(dashboardSeries([restarted], "relative", "EUR", "", "invested")[0].points, [{ date: "2026-10-07", value: 0 }]);
});

test("weekly comparison uses hourly slots, retains distinct same-day points and expires against now", () => {
  const now = new Date("2026-10-30T17:05:00Z");
  const hours = ["2026-10-23T16:05:00.000Z", "2026-10-23T17:05:00.000Z", "2026-10-30T16:05:00.000Z", "2026-10-30T17:05:00.000Z"];
  const hourly = { ...entry, hourlySnapshots: hours.map((slotAt, i) => ({
    date: slotAt.slice(0, 10), slotAt, capturedAt: slotAt.replace(":05:", ":06:"),
    indexUsd: 100 + i * 10, indexEur: 100 + i * 5, valueUsd: 1000 + i * 100,
    investedIndexUsd: 100 + i * 20, investedIndexEur: 100 + i * 10, investedSegment: "first-slot",
  })) };
  const relative = dashboardSeries([hourly], "relative", "USD", "", "total", "hourly", now)[0];
  assert.equal(relative.baselineDate, hours[1]);
  assert.deepEqual(relative.points.map((point) => point.slotAt), hours.slice(1));
  assert.ok(Math.abs(relative.points[2].value - (130 / 110 - 1) * 100) < 1e-9);
  const invested = dashboardSeries([hourly], "relative", "EUR", "", "invested", "hourly", now)[0];
  assert.ok(Math.abs(invested.points[2].value - (130 / 110 - 1) * 100) < 1e-9);
  assert.deepEqual(dashboardSeries([hourly], "absolute", "USD", "", "total", "hourly", now)[0].points.map((point) => point.value), [1100, 1200, 1300]);
  assert.deepEqual(dashboardSeries([entry], "relative", "USD", "", "total", "hourly", now), []);
  assert.equal(dashboardSeries([hourly], "relative", "USD", "")[0].points.length, entry.snapshots.length);
  assert.deepEqual(dashboardSeries([hourly], "relative", "USD", "", "total", "hourly", new Date("2026-11-07T17:05:00Z")), []);
  assert.equal(portfolioPeriodStart({ preset: "1W" }, "2020-01-01", "2020-01-02", now), "2026-10-23");
  const midnightUtc = new Date("2026-10-30T00:00:00Z");
  const late = { ...entry, hourlySnapshots: [{ date: "2026-10-22", slotAt: "2026-10-23T00:05:00.000Z", indexUsd: 100, indexEur: 100 }] };
  assert.equal(portfolioPeriodStart({ preset: "1W" }, "", "", midnightUtc), "2026-10-22");
  assert.equal(dashboardSeries([late], "relative", "USD", "2026-10-23", "total", "hourly", midnightUtc)[0].points.length, 1, "weekly cutoff uses timestamps even across UTC midnight");
});
