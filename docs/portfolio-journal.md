# Portfolio journal and counterfactual explorer

In a saved portfolio, **Journal & what-if**
opens the owner-only explorer. Selecting a log entry or moving the discrete
timeline selects the composition **after** that modification.
Example data, when requested, is inserted as an ordinary portfolio and journal;
there is no separate demo interface or alternate client-side valuation path.
When several saved portfolios are available, the explorer header also allows
switching between their journals. Switching clears the previous selection and
quote cache; it does not change the portfolio open behind the explorer.

Select a past state and use **Delete selected state** (trash icon) to remove it
permanently after confirmation. The latest state represents the current portfolio
and cannot be deleted. The owner-only `DELETE /api/v1/portfolio/journal` accepts
`portfolioId` and `entryId` as query parameters. It removes the actual database
row and rebases the next surviving entry in one transaction, preserving every
other saved composition, timestamp and recorded value. Deleting the first entry
makes the next one the initial tracking checkpoint. A round-trip test edit can
leave a surviving entry labelled **Composition unchanged**. Current positions,
cash, dividend records and NAV history are unaffected. Quotes are cleared and the
timeline selects the next surviving state. A valuation overlapping a journal
deletion is rejected so a removed state cannot be returned as a valid selection.

Migration 0021 adds `portfolio_journal_entries`. One initial checkpoint establishes
the start of reliable history; later entries retain only changed positions,
cash balances and the portfolio name, with before/after values. Unchanged lines,
market weight changes and regenerated editor row IDs are not duplicated. Journal
entries are committed in the same SQLite transaction as portfolio creation or
editing, legacy quantity resolution and dividend cash credits/adjustments.
Deleting a portfolio cascades to its journal. Existing portfolios receive a
checkpoint on first edit or opening the journal. Earlier operations are not
invented or inferred from NAV snapshots.

Reconstruction validates that replaying the complete journal matches the current
economic composition, then reverses all changes after the selected entry. An
external edit that bypasses the journal causes an explicit reconstruction error.
Asset identity maintenance that rewrites IDs outside these mutation paths can
therefore invalidate reconstruction; it is not silently interpreted as a trade.
Historical positions keep their ticker/name, asset references and share quantities.
Unresolved legacy quantities remain unknown rather than being inferred from
today's prices.

`GET /api/v1/portfolio/journal` returns the change journal. The owner-only
`GET /api/v1/portfolio/counterfactual` reconstructs a selected entry and requests
available quotes for the union of its positions and the current book. Both
valuations use those same quotes. Cash amounts are held fixed in their original
currencies; current FX converts non-USD cash. Shorts retain negative quantities.
Unavailable security quotes, share quantities or FX make the total unavailable,
while available individual values can still be explored. Stale quotes and the
oldest quote date are disclosed. Quote requests are debounced while dragging the
timeline, aborted on selection changes and cached for that modal session.

The explorer displays the historical value recorded with an entry when available,
the hypothetical latest value and the actual book valued with the same quotes.
It does not fetch a complete historical daily-price series or draw an invented
counterfactual performance curve. The change in value is a fixed-holdings price
simulation, with later transactions, deposits and withdrawals ignored. It does
not simulate dividends, interest, fees or corporate actions. Differences from
the current portfolio can include external cash flows and are not alpha.

Exploring does not save another portfolio, overwrite holdings, restore an old
state or record each simulated variant. Ordinary market quote caching and the
single initial journal checkpoint are the only read-path persistence. Journal
data contains exact historical quantities and cash, so it is not exposed in
visitor views, even when the current portfolio is public.

Run `npm run test:portfolio-journal` for reconstruction, partial pricing, atomic
edit persistence, rollback, access boundaries and ephemeral valuation tests.
