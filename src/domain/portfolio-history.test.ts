import assert from "node:assert/strict";
import test from "node:test";
import { portfolioHistoryClock, portfolioSnapshotDue, portfolioHourlySlot, portfolioHourlyCutoff } from "./portfolio-history";
import { usEquitySession } from "./us-equity-calendar";
import { buildInvestedSnapshot, investedPositionKey, type InvestedPosition } from "./portfolio-invested-return";

const position = (quantity = 10, priceUsd = 100, referenceId = "A", exposureMultiplier = 1): InvestedPosition => ({ kind: "security", referenceId, ticker: referenceId, quantity, priceUsd, exposureMultiplier });
const prices = (...positions: InvestedPosition[]) => new Map(positions.map((p) => [investedPositionKey(p), p.priceUsd]));
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("hourly captures run at :05 from 04:05 through 20:05 New York with bounded retries", () => {
  for (let hour = 4; hour <= 20; hour++) {
    const scheduled = new Date(`2026-10-30T${String(hour).padStart(2, "0")}:05:00-04:00`);
    assert.equal(portfolioHourlySlot(scheduled), scheduled.toISOString());
    assert.equal(portfolioHourlySlot(new Date(scheduled.getTime() + 14 * 60_000 + 59_999)), scheduled.toISOString());
    assert.equal(portfolioHourlySlot(new Date(scheduled.getTime() - 1)), null);
    assert.equal(portfolioHourlySlot(new Date(scheduled.getTime() + 15 * 60_000)), null);
  }
  assert.equal(portfolioHourlySlot(new Date("2026-10-30T03:05:00-04:00")), null);
  assert.equal(portfolioHourlySlot(new Date("2026-10-30T21:05:00-04:00")), null);
  assert.equal(portfolioHourlySlot(new Date("2026-10-31T12:05:00-04:00")), null);
  assert.equal(portfolioHourlySlot(new Date("2026-11-01T12:05:00-05:00")), null);
});

test("hourly scheduling follows New York DST independently of the European change", () => {
  for (const [date, offset] of [["2026-03-06", "-05:00"], ["2026-03-09", "-04:00"], ["2026-10-30", "-04:00"], ["2026-11-02", "-05:00"]]) {
    const now = new Date(`${date}T04:05:00${offset}`);
    assert.equal(portfolioHourlySlot(now), now.toISOString());
  }
  assert.equal(portfolioHourlyCutoff(new Date("2026-11-02T09:05:00Z")), "2026-10-26T09:05:00.000Z");
});

test("US equity calendar handles observed holidays, Good Friday and shortened extended sessions", () => {
  const closed = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-03-26", "2027-06-18", "2027-07-05", "2027-12-24", "2028-04-14", "2025-01-09"];
  for (const date of closed) assert.equal(usEquitySession(date), null, date);
  for (const date of ["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]) {
    assert.deepEqual(usEquitySession(date), { openHour: 4, closeHour: 17 }, date);
    assert.ok(portfolioHourlySlot(new Date(`${date}T17:05:00${date.includes("-07-") ? "-04:00" : "-05:00"}`)));
  }
  assert.equal(portfolioHourlySlot(new Date("2026-11-27T18:05:00-05:00")), null);
  for (const date of ["2026-07-02", "2027-07-02", "2027-12-23", "2027-12-31"]) assert.deepEqual(usEquitySession(date), { openHour: 4, closeHour: 20 }, date);
});

test("invested returns ignore portfolio scale and cash/borrowing; ETF exposure removes known leverage", () => {
  for (const quantity of [1, 10, 200]) {
    const first = buildInvestedSnapshot("2026-10-01", [position(quantity)], 1.2, undefined, prices())!;
    const next = buildInvestedSnapshot("2026-10-02", [position(quantity, 110)], 1.2, { invested: first, eurToUsd: 1.2 }, prices(position(quantity, 110)))!;
    near(next.indexUsd, 110);
    near(next.indexEur, 110);
  }
  const leveraged = position(10, 100, "ETF", 2);
  const first = buildInvestedSnapshot("2026-10-01", [leveraged], 1, undefined, prices())!;
  const next = buildInvestedSnapshot("2026-10-02", [{ ...leveraged, priceUsd: 120 }], 1, { invested: first, eurToUsd: 1 }, prices({ ...leveraged, priceUsd: 120 }))!;
  near(next.indexUsd, 110);
});

test("quantity edits do not create gains; the previous book determines each period", () => {
  const first = buildInvestedSnapshot("2026-10-01", [position()], 1.25, undefined, prices())!;
  const second = buildInvestedSnapshot("2026-10-02", [position(100)], 1.25, { invested: first, eurToUsd: 1.25 }, prices(position(100)))!;
  near(second.indexUsd, 100);
  const third = buildInvestedSnapshot("2026-10-03", [position(1, 110, "B")], 1.25, { invested: second, eurToUsd: 1.25 }, prices(position(100, 110), position(1, 110, "B")))!;
  near(third.indexUsd, 110);
  const fourth = buildInvestedSnapshot("2026-10-04", [position(1, 121, "B")], 1.25, { invested: third, eurToUsd: 1.25 }, prices(position(1, 121, "B")))!;
  near(fourth.indexUsd, 121);
});

test("short and market-neutral books use signed P&L and positive gross exposure", () => {
  const book = [position(10), position(-10, 100, "B")];
  const first = buildInvestedSnapshot("2026-10-01", book, 1, undefined, prices())!;
  assert.equal(first.grossExposureUsd, 2000);
  const nextBook = [position(10, 110), position(-10, 90, "B")];
  const next = buildInvestedSnapshot("2026-10-02", nextBook, 1, { invested: first, eurToUsd: 1 }, prices(...nextBook))!;
  near(next.indexUsd, 110);
});

test("EUR return uses each observation's immutable FX rate", () => {
  const first = buildInvestedSnapshot("2026-10-01", [position()], 1.25, undefined, prices())!;
  const next = buildInvestedSnapshot("2026-10-02", [position(10, 110)], 1.1, { invested: first, eurToUsd: 1.25 }, prices(position(10, 110)))!;
  near(next.indexUsd, 110);
  near(next.indexEur, 125);
  near(first.indexEur, 100);
});

test("legacy data has no reconstructed return; missing marks and cash-only books break continuity", () => {
  const first = buildInvestedSnapshot("2026-10-01", [position()], 1, { eurToUsd: 1 }, prices())!;
  assert.equal(first.segment, "2026-10-01");
  assert.equal(first.indexUsd, 100);
  assert.equal(buildInvestedSnapshot("2026-10-02", [position(10, 110)], 1, { invested: first, eurToUsd: 1 }, prices()), null);
  assert.equal(buildInvestedSnapshot("2026-10-02", [], 1, { invested: first, eurToUsd: 1 }, prices()), null);
  const liquidated = buildInvestedSnapshot("2026-10-02", [], 1, { invested: first, eurToUsd: 1 }, prices(position(10, 110)))!;
  near(liquidated.indexUsd, 110);
  assert.equal(liquidated.grossExposureUsd, 0);
  assert.equal(buildInvestedSnapshot("2026-10-03", [], 1, { invested: liquidated, eurToUsd: 1 }, prices()), null);
  const restarted = buildInvestedSnapshot("2026-10-03", [position()], 1, { invested: null, eurToUsd: 1 }, prices())!;
  assert.equal(restarted.segment, "2026-10-03");
  assert.equal(restarted.indexUsd, 100);
});

test("daily schedule follows New York daylight saving and calendar dates", () => {
  assert.deepEqual(portfolioHistoryClock(new Date("2026-07-10T20:10:00Z")), { date: "2026-07-10", minutes: 970 });
  assert.deepEqual(portfolioHistoryClock(new Date("2026-12-10T21:10:00Z")), { date: "2026-12-10", minutes: 970 });
  assert.equal(portfolioHistoryClock(new Date("2026-07-11T02:00:00Z")).date, "2026-07-10");
});

test("initial capture, missed-close recovery, daily deduplication and 24h fallback", () => {
  const latest = { date: "2026-07-09", capturedAt: "2026-07-09T20:10:00Z" };
  assert.equal(portfolioSnapshotDue(new Date("2026-07-10T10:00:00Z")), "initial");
  assert.equal(portfolioSnapshotDue(new Date("2026-07-10T20:09:59Z"), latest), null);
  assert.equal(portfolioSnapshotDue(new Date("2026-07-10T20:10:00Z"), latest), "scheduled");
  assert.equal(portfolioSnapshotDue(new Date("2026-07-10T23:00:00Z"), latest), "scheduled");
  assert.equal(portfolioSnapshotDue(new Date("2026-07-11T10:00:00Z"), latest), "catchup");
  assert.equal(portfolioSnapshotDue(new Date("2026-07-10T23:00:00Z"), { date: "2026-07-10", capturedAt: "2026-07-10T10:00:00Z" }), null);
  assert.equal(portfolioSnapshotDue(new Date("2026-07-10T23:00:00Z"), { date: "2026-07-12", capturedAt: "2026-07-12T10:00:00Z" }), null);
});

test("scheduled close survives spring DST's 23-hour day; fallback survives fall DST's 25-hour day", () => {
  assert.equal(portfolioSnapshotDue(new Date("2026-03-08T20:10:00Z"), { date: "2026-03-07", capturedAt: "2026-03-07T21:10:00Z" }), "scheduled");
  assert.equal(portfolioSnapshotDue(new Date("2026-11-01T20:11:00Z"), { date: "2026-10-31", capturedAt: "2026-10-31T20:10:00Z" }), "catchup");
});
