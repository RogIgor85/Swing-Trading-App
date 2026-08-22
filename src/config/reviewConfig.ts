// ─────────────────────────────────────────────────────────────────────────────
// Portfolio Review — decision model configuration.
// Company Quality (the business) and Position Fit (this specific holding) are
// deliberately separate scores with separate inputs and weights.
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewStatus = 'CORE' | 'STRONG HOLD' | 'HOLD' | 'WATCH' | 'TRIM' | 'REVIEW' | 'EXIT';

export const REVIEW_STATUS_STYLE: Record<ReviewStatus, { badge: string; border: string }> = {
  'CORE':        { badge: 'text-violet-400 border-violet-500/40 bg-violet-500/10',   border: 'border-l-violet-500' },
  'STRONG HOLD': { badge: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', border: 'border-l-emerald-500' },
  'HOLD':        { badge: 'text-blue-400 border-blue-500/40 bg-blue-500/10',          border: 'border-l-blue-500' },
  'WATCH':       { badge: 'text-amber-400 border-amber-500/40 bg-amber-500/10',       border: 'border-l-amber-500' },
  'TRIM':        { badge: 'text-orange-400 border-orange-500/40 bg-orange-500/10',    border: 'border-l-orange-500' },
  'REVIEW':      { badge: 'text-orange-300 border-orange-400/40 bg-orange-400/10',    border: 'border-l-orange-400' },
  'EXIT':        { badge: 'text-red-400 border-red-500/40 bg-red-500/10',             border: 'border-l-red-500' },
};

/** Company Quality (0–10) — the business only. Price action is NOT an input. */
export const COMPANY_QUALITY_WEIGHTS = {
  revenueGrowth: 18,
  epsGrowth:     18,
  grossMargin:   14,
  netMargin:     12,
  roe:           14,
  leverage:      12,   // debt/equity, inverted
  valuation:     12,   // P/E, mild influence only
};

/** ETF Quality / Portfolio Role (0–10) — replaces company fundamentals. */
export const ETF_ROLE_WEIGHTS = {
  diversification: 40,  // broad > growth-index > sector
  portfolioRole:   30,  // suitability as a core/satellite position
  concentration:   20,  // internal concentration & overlap with direct holdings
  liquidity:       10,
};

/** Position Fit (0–10) — this specific holding in this account. */
export const POSITION_FIT_WEIGHTS = {
  companyQuality:     25,
  relativeStrength:   15,
  trendMomentum:      15,
  positionSize:       15,
  combinedExposure:   15,
  sectorRotation:      5,
  targetValuation:    10,
};

/** Portfolio Health (0–10) — every component is shown to the user. */
export const PORTFOLIO_HEALTH_WEIGHTS = {
  positionQuality: 30,
  concentration:   25,
  diversification: 15,
  trendMomentum:   10,
  sectorAlignment: 10,
  drawdownRisk:    10,
};

export const HEALTH_COMPONENT_LABELS: Record<keyof typeof PORTFOLIO_HEALTH_WEIGHTS, string> = {
  positionQuality: 'Average Position Quality',
  concentration:   'Concentration',
  diversification: 'Diversification',
  trendMomentum:   'Momentum / Trend',
  sectorAlignment: 'Sector Rotation Alignment',
  drawdownRisk:    'Drawdown / Risk',
};

/** Combined exposure to one underlying company/fund, % of portfolio. */
export const EXPOSURE_THRESHOLDS = {
  elevated:   10,
  high:       15,
  overweight: 20,
  /** Exposure alone never forces a TRIM; it must pair with weak Position Fit. */
  trimRequiresFitBelow: 5.0,
};

/** Drawdown severity — none of these alone justifies EXIT. */
export const DRAWDOWN_THRESHOLDS = {
  watch:  -10,
  review: -25,
  severe: -40,
};

export const RELATIVE_STRENGTH_THRESHOLDS = {
  strong: 0.05,    // > +5% vs sector over 1M
  positive: 0.02,
  weak: -0.05,
};

/** Status score bands on Position Fit (0–10). */
export const FIT_BANDS = {
  strongHold: 7.5,
  hold:       6.0,
  watch:      4.5,
  trim:       3.0,
};

export const PORTFOLIO_YTD_HELP =
`Portfolio YTD (current holdings)
Year-to-date price return of the positions you hold today, weighted by their
current market value. For holdings bought during the year the return is measured
from the purchase date.

Compared against SPY and TSX over the same year-to-date period.

This is a price-return figure — it excludes deposits, withdrawals and the timing
of purchases, so it is not a time-weighted or money-weighted return.`;

export const PORTFOLIO_HEALTH_HELP =
`Portfolio Health (0–10)
A weighted blend of six measured components, each scored 0–10 and shown below
with its weight. Nothing here is estimated — every component is computed from
your holdings, their price history and current sector rotation data.`;

export const COMPANY_QUALITY_HELP =
`Company Quality (0–10)
Measures the underlying business only: revenue and EPS growth, margins, return
on equity, leverage and valuation.

The same company scores identically in every account that holds it. Price
performance does not affect this score — that belongs to Position Fit.`;

export const POSITION_FIT_HELP =
`Position Fit (0–10)
Measures this specific holding: its size, your combined exposure to the same
underlying company across all accounts, relative strength versus its sector,
trend, sector rotation and distance to your target.

Two accounts holding the same company share a Company Quality score but can
have different Position Fit scores.`;
