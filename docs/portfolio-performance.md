# Portfolio chart return bases

`Total portfolio` preserves the existing saved net asset value series. It includes
cash, borrowing and changes to capital or holdings. The relative overview rebases
these saved values; it is not adjusted for external cash flows.

`Invested · 1× gross` is a daily chained price-return index, separate from NAV.
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
