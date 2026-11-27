# Report pages

How an agent turns a backtest result into a page, what it costs in tokens, and where the format stops being enough. The worked example is [`examples/backtest-report.html`](../examples/backtest-report.html): a gold futures roll backtest on **synthetic data** (the page says so). Nothing in it is a market result.

## What the page holds

| Part | Components |
|---|---|
| Results (net P&L, rolls traded, win rate, max drawdown) | `OverviewCardBlock`, `OverviewCardItem`, `MetricIndicatorInline` |
| Premium, equity curve and trades, one tab each | `Tabs`, `TabItem`, `LineChart`, `AreaChart`, `Table` |
| Parameters: roll window, contract pair, cost per day | `Form`, `FormControl`, `Slider`, `Select`, `Input`, `Buttons` |
| Method and data notes | `MarkDownRenderer` |

Only components that ship today. There is no report-specific component.

## From a backtest result to a page

1. Run the backtest in your own code. The page does not compute anything.
2. Write one statement per result the reader may want to question: each KPI is its own `OverviewCardItem`, each chart and each table its own statement. Name them by meaning (`equityChart`, `tradesTable`, `kpiPnl`), because feedback comes back addressed by name.
3. Put the numbers in as arrays: `LineChart(labels, [Series("name", values)], ...)`, and `Table([Col("P&L", values, "number")])`. Round before you write; every digit is a token.
4. Put the parameters in a `Form` whose button sends `@ToAssistant("...")`, and give each field a name you can read in the payload.
5. Say on the page that the data is synthetic (or what it is). The example does it in a `Callout` and again in the methodology text.

## The patch-only flow

The reviewer moves the slider to 10 and presses **Run backtest**, then **Send**. The agent's `poll` returns this (real output):

```json
{
  "kind": "action",
  "message": "Re-run backtest with these parameters",
  "form": { "backtest_params": { "roll_days": [10] } }
}
```

Only a field the reviewer touched, or that the page pre-selected, is in `form`. Here that is `roll_days`; `pair` and `cost` were left alone and are absent, so treat a missing field as "unchanged".

The agent re-runs the backtest with `roll_days = 10`, then sends the statements that changed, and only those:

```sh
austere-axi patch examples/backtest-report.html <<'PATCH'
kpiPnl = OverviewCardItem("pnl", Text("text", "Net P&L (synthetic units)"), MetricIndicatorInline("+103", "10-day roll window"))
equityChart = AreaChart(["1","2", ... "180"], [Series("Equity", [0,0, ... 103])], "step", "Trading day", "P&L (synthetic units)", 280)
tradesTable = Table([Col("Entry day", [21,51,81,111,141], "number"), ... Col("P&L", [17,12,20,13,19], "number")])
PATCH
```

`...` marks long arrays shortened here; the agent sends them in full. The command printed `status: patched` and `check: ok (25 statements)`. The page changed in place and the review chrome showed "3 changed". The other KPI statements read the same for both windows, so the agent left them out; the form, the premium chart and the methodology were not sent either.

For a roll window of 10 instead of 7 the patch is about 610 tokens. The whole page is about 1,680.

## Token cost

Counts use the repo's estimate (characters ÷ 3.8), not a model tokenizer. Treat them as rough.

| What | Tokens |
|---|---|
| The example page, 180 points in each of two charts | ~1,680 |
| The patch above (3 statements, 180-point equity chart) | ~610 |
| One `LineChart` with 500 points and its labels | ~1,290 |
| The same 500 values without labels | ~520 |
| Premium and equity chart, 500 points each | ~2,500 |

Rules of thumb:

- A point costs about 2.5 tokens with its label. The labels are over half of that, so short labels (`"1"`, `"2"`) matter more than rounding.
- A chart is one statement. Moving one point re-sends the whole series. A parameter change that moves every point costs the same as one that moves one.
- Two 500-point charts are about 2,500 tokens to write and the same to patch when both move. Resample long series (weekly instead of daily) before they get there.

## Where the format stops

- **Run does not recompute.** The button sends the parameters to the agent. Nothing on the page re-runs a backtest by itself; if no agent is listening, the page stays as it was. Recomputing in the page is out of scope for this format.
- **Every parameter change costs an agent turn** and the tokens of the changed statements. There is no live slider that drags a chart.
- **A chart is one statement.** A reviewer can comment on the chart, not on a single point or a date range.
- **Series come as literal arrays.** The agent writes every number; there is no data file or query to point at.
- **A slider sends its value only when the form is sent.** There is no preview of the result while the reviewer drags.
- **The example models the roll window only.** `pair` and `cost` are in the form to show how fields arrive; the example's data does not react to them.

When a report needs more than this, give it fewer points, split it into several pages, or link out to a notebook.
