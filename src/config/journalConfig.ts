// ─────────────────────────────────────────────────────────────────────────────
// Trade Journal — configuration. Tags, buckets and thresholds live here.
// ─────────────────────────────────────────────────────────────────────────────

export const STRATEGY_TAGS = [
  'Momentum', 'Breakout', 'Pullback', 'Earnings', 'Sector Rotation',
  'Value', 'Swing', 'Long-Term', 'Speculative', 'Lotto', 'Other',
] as const;

export const EXIT_REASONS = [
  'Target Hit', 'Stop Hit', 'Thesis Changed', 'Earnings Risk', 'Sector Weakening',
  'Trailing Stop', 'Profit Taking', 'Reallocation', 'Manual / Other',
] as const;

export const MISTAKE_CATEGORIES = [
  'Entered Too Early', 'Chased Price', 'Oversized', 'Ignored Stop',
  'Sold Too Early', 'Held Too Long', 'Earnings Gamble', 'No Thesis', 'Other',
] as const;

export const FOLLOWED_PLAN_OPTIONS = ['Yes', 'Partially', 'No'] as const;

export type StrategyTag = typeof STRATEGY_TAGS[number];
export type ExitReason = typeof EXIT_REASONS[number];
export type MistakeCategory = typeof MISTAKE_CATEGORIES[number];
export type FollowedPlan = typeof FOLLOWED_PLAN_OPTIONS[number];

/** Holding-period buckets, in calendar days. */
export const HOLDING_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: 'Same Day',    min: 0,  max: 0 },
  { label: '1–5 Days',    min: 1,  max: 5 },
  { label: '6–15 Days',   min: 6,  max: 15 },
  { label: '16–30 Days',  min: 16, max: 30 },
  { label: '31–60 Days',  min: 31, max: 60 },
  { label: '60+ Days',    min: 61, max: Infinity },
];

/**
 * Expected holding window per strategy tag, used only to FLAG a mismatch —
 * strategy tags are user-set and are never rewritten from actual hold time.
 */
export const STRATEGY_DURATIONS: Record<string, { minDays: number; maxDays: number }> = {
  'Swing 1-15 days':  { minDays: 0,   maxDays: 15 },
  'Short < 6 months': { minDays: 0,   maxDays: 182 },
  'Long 1+ Year':     { minDays: 365, maxDays: Infinity },
  'Core (Forever)':   { minDays: 365, maxDays: Infinity },
  'Momentum':         { minDays: 0,   maxDays: 60 },
  'Breakout':         { minDays: 0,   maxDays: 60 },
  'Pullback':         { minDays: 0,   maxDays: 60 },
  'Lotto':            { minDays: 0,   maxDays: 30 },
};

/** Rotation context buckets, from the sector snapshot stored at entry. */
export const ROTATION_CONTEXTS = [
  'Positive Pressure at Entry',
  'Negative Pressure at Entry',
  'Leading Sector',
  'Improving Sector',
  'Weakening Sector',
  'Lagging Sector',
] as const;

export type DateRangeKey = 'YTD' | '1Y' | 'ALL' | 'CUSTOM';

export const PROFIT_FACTOR_HELP =
`Profit Factor
Gross winning P&L ÷ absolute gross losing P&L. Measures how many dollars you
make for every dollar you lose across ALL closed trades.

Above 1.0 is profitable; 2.0+ is strong. Different from Payoff Ratio, which
compares the AVERAGE win to the AVERAGE loss and ignores how often each occurs.`;

export const PAYOFF_RATIO_HELP =
`Payoff Ratio
Average winning trade ÷ absolute average losing trade. Measures the size of a
typical win versus a typical loss, regardless of how often you win.

A high payoff ratio with a low win rate can still be profitable, and vice versa —
Expectancy combines both.`;

export const EXPECTANCY_HELP =
`Expectancy per Trade
(Win rate × average win) − (Loss rate × absolute average loss).

The average dollar result you can expect from placing one more trade of this
kind. Breakeven trades are included in the rate denominators.`;

export const DRAWDOWN_HELP =
`Maximum Drawdown
Largest peak-to-trough decline in your CUMULATIVE REALIZED P&L, ordered by exit
date. It measures realized trading results only — it is not a mark-to-market
drawdown of account equity, and open positions are excluded.

A percentage figure would require a stored starting capital base, which the
journal does not track, so only the dollar figure is shown.`;

export const CURRENCY_HELP =
`Currency aggregation
USD trades are converted to CAD at the CURRENT exchange rate, not the rate on
each trade's exit date — the journal does not store historical FX.

Reported totals are therefore approximate for USD trades. CAD trades are exact.`;
