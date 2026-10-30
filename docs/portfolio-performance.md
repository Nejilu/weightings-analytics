# Portfolio chart return bases

`Total portfolio` preserves the existing saved net asset value series. It includes
cash, borrowing and changes to capital or holdings. The relative overview rebases
these saved values; it is not adjusted for external cash flows.

`Invested · 1× gross` is a chained price-return index, separate from NAV.
Each new snapshot stores the security quantities, USD prices and known ETF
exposure multipliers, together with gross exposure and independent USD/EUR indices.
For an interval from capture A to capture B:

```
gross_A_USD = sum(abs(quantity_A * price_A_USD) * abs(exposure_multiplier_A))
pnl_USD = sum(quantity_A * (price_B_USD - price_A_USD))
return_USD = pnl_USD / gross_A_USD
index_B_USD = index_A_USD * (1 + return_USD)

pnl_EUR = sum(quantity_A * (price_B_USD / fx_B - price_A_USD / fx_A))
return_EUR = pnl_EUR / (gross_A_USD / fx_A)
```

Here `fx` is the EUR-to-USD rate saved at each capture. Neither historical EUR
prices nor indices use today's FX rate. Signed quantities preserve short P&L;
the absolute gross denominator supports books whose net securities value is zero.
Known ETF leverage uses the catalog multiplier saved with the position, not
retrospectively updated metadata. This does not reconstruct exposure or cash
inside an ETF whose multiplier is unknown. Security returns use quoted prices,
without a separate corporate-action adjustment.

The prior captured book earns the interval return. New quantities and weights
apply at the next capture boundary. Sold instruments are quoted separately so
replacing a position does not create an artificial gain. A final liquidation can
record its last interval, but an empty book cannot earn subsequent returns.
Cash deposits, withdrawals, portfolio borrowing and changes in quantities do
not enter this index. Cash dividends, cash interest, financing charges, fees
and actual intraday execution P&L are excluded. It is not benchmark-relative
alpha or a regression estimate of beta.

Migration 0020 adds nullable `invested_json` alongside existing immutable NAV
observations. Old observations remain null. A missing quote, invalid index or
cash-only interval cannot be bridged with invented returns: subsequent available
data starts a new segment at 100. Charts show the most recent recorded continuous
segment and rebase it to 0% at its first point in the selected period. A missing
latest capture leaves the preceding segment visible until a new segment starts.
Dates skipped while the server is off have no manufactured daily observations;
the next interval marks the prior captured book at the next available prices.

An unavailable invested observation does not stop an otherwise valid NAV capture.
The normal recording switch controls both series. At least two new observations
are needed for a measured invested return. Public API projections share only
the dimensionless invested indices and segment date. They never expose the
recorded quantities, prices or gross dollar exposure; fully private portfolios
remain invisible.

## Hourly week view

Both the portfolio detail chart and the comparison dashboard have a `1W` preset.
It selects hourly observations from the rolling last 7 × 24 hours, measured from
the current time. `1M`, `3M`, `1Y`, `All` and custom comparison dates continue to
use the permanent daily observations. The default remains `All`.

On a normal US equity trading day the server captures at 04:05, 05:05, …, 20:05
in `America/New_York`. The timezone follows US daylight saving independently of
the European clock change. The recurring NYSE/Nasdaq equity calendar excludes
weekends and observed holidays (including Good Friday); early-close days end
with the 17:05 capture after the shortened extended session. Calendar rules are
based on <https://www.nyse.com/trade/hours-calendars>; exceptional exchange
closures belong in `src/domain/us-equity-calendar.ts`.

The existing Node scheduler checks once per minute, without needing an open
browser. It must remain running to record observations. Captures can retry every
five minutes from HH:05 until before HH:20. After that window the slot stays
missing. A restart does not reconstruct missed hours. Each observation stores
both the scheduled `slotAt` and the actual `capturedAt`, plus quote and FX times.
Positions without a new trade use the latest quote returned by a successful
provider refresh; a failed refresh cannot silently substitute stale cache data.

Migration 0023 creates separate hourly observations and claim/error state. An
atomic database lease and a unique `(portfolio_id, slot_at)` key prevent workers
from duplicating a slot; hourly failures do not consume the daily capture lease.
The shared recording switch pauses both schedules. A scheduler pass deletes
hourly slots older than seven days, even outside market hours and while paused;
reads also exclude expired slots. Daily observations are never pruned by this
cleanup. Deleting a portfolio cascades to its hourly observations and settings.

Hourly NAV saves USD/EUR totals and the capture's exchange rate. Hourly invested
returns chain only from the previous retained hourly observation, independently
of the daily index. Segment IDs include the full hourly slot so a missing mark
and a restart within the same day cannot merge unrelated return segments.
Publication projections expose only the allowed totals or dimensionless indices,
never the saved positions or gross exposure. Comparison charts align portfolios
by scheduled hourly slot while the detail chart and table show actual capture
times. Until the first hourly captures exist, `1W` displays an empty state rather
than substituting daily data.
