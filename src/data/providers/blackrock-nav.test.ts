import assert from "node:assert/strict";
import test from "node:test";
import { parseBlackrockNav } from "./blackrock-nav";

const now = Date.parse("2026-10-31T12:00:00Z");
const page = `<title>Test Fund | BGSIX | Institutional</title>
<li data-col="fundHeader.fundNav.navAmountChange"><span class="header-nav-data">$9.99</span></li>
<li class="navAmount" data-col="fundHeader.fundNav.navAmount">
  <span class="header-nav-label navAmount">NAV as of Oct 30, 2026</span>
  <span class="header-nav-data">$123.45</span><span>52 WK: 90.00 - 140.00</span>
</li>`;

test("uses the dated NAV of the requested share class, never the change or 52-week range", () => {
  assert.deepEqual(parseBlackrockNav(page, "BGSIX", now), {
    symbol: "BGSIX", price: 123.45, currency: "USD", asOf: "2026-10-30",
    source: "BlackRock", session: "nav",
  });
  assert.equal(parseBlackrockNav(page.replace("$123.45", "$1,234.56"), "BGSIX", now).price, 1234.56);
});

test("rejects a different share class, missing NAV, invalid prices and invalid or future dates", () => {
  for (const html of [page.replace("BGSIX", "BGSAX"), "Access denied",
    page.replace("fundHeader.fundNav.navAmount\"", "fundHeader.fundNav.other\""),
    page.replace("$123.45", "$0.00"), page.replace("$123.45", "$-1.00"),
    page.replace("Oct 30, 2026", "Feb 30, 2026"), page.replace("Oct 30, 2026", "Nov 1, 2026")]) {
    assert.throws(() => parseBlackrockNav(html, "BGSIX", now));
  }
});
