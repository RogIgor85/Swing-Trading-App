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

/**
 * ETF Quality (0–10) — how well the PRODUCT delivers its own stated mandate.
 * Deliberately contains no portfolio-specific input: overlap, position size and
 * style concentration relative to your holdings belong to Position Fit.
 * A Nasdaq-100 fund is not a poor product for being concentrated in mega-cap
 * growth — that is the exposure it exists to provide.
 */
export const ETF_QUALITY_WEIGHTS = {
  mandateQuality:          25,  // index/strategy soundness and rules-based consistency
  liquidityStability:      20,  // fund scale and tradability
  cost:                    15,  // expense ratio versus peers of the same type
  tracking:                15,  // implementation quality
  diversificationInMandate: 15, // breadth WITHIN the mandate, not against XEQT
  issuerStructure:         10,
};

/** ETF Position Fit (0–10) — does owning it make sense in THIS portfolio? */
export const ETF_POSITION_FIT_WEIGHTS = {
  portfolioRole:       20,
  overlap:             25,
  positionSize:        15,
  styleConcentration:  15,
  correlation:         10,
  trend:               10,
  marketAlignment:      5,
};

/** Expense-ratio expectations differ sharply by fund type (%). */
export const EXPENSE_BENCHMARKS = {
  'Broad-Market ETF': { excellent: 0.10, good: 0.25, fair: 0.45 },
  'Growth/Index ETF': { excellent: 0.15, good: 0.35, fair: 0.55 },
  'Sector ETF':       { excellent: 0.12, good: 0.30, fair: 0.60 },
  'Specialty ETF':    { excellent: 0.25, good: 0.55, fair: 0.90 },
  'Other':            { excellent: 0.20, good: 0.45, fair: 0.75 },
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

/**
 * Portfolio Health (0–10) — STRUCTURAL quality. Answers "how well built is
 * this portfolio", not "are my sectors in favour this month". Tactical inputs
 * total only 10% so the score moves slowly; the rest lives in Market Alignment.
 */
export const PORTFOLIO_HEALTH_WEIGHTS = {
  assetQuality:    35,   // value-weighted Company / ETF quality
  positionFit:     20,   // value-weighted Position Fit
  diversification: 20,
  concentration:   15,
  trendStrength:    5,   // tactical
  sectorAlignment:  5,   // tactical
};

export const HEALTH_COMPONENT_LABELS: Record<keyof typeof PORTFOLIO_HEALTH_WEIGHTS, string> = {
  assetQuality:    'Weighted Asset Quality',
  positionFit:     'Position Fit',
  diversification: 'Diversification',
  concentration:   'Concentration',
  trendStrength:   'Trend / Relative Strength',
  sectorAlignment: 'Sector Alignment',
};

/** Market Alignment (0–10) — tactical, expected to move quickly. */
export const MARKET_ALIGNMENT_WEIGHTS = {
  sectorRotation:   40,
  relativeStrength: 25,
  trendMomentum:    25,
  marketRegime:     10,
};

export const HEALTH_BANDS: Array<[number, string]> = [
  [8.5, 'EXCELLENT'],
  [7.0, 'HEALTHY'],
  [5.5, 'MIXED'],
  [4.0, 'WEAK'],
  [0,   'POOR'],
];

export const ALIGNMENT_BANDS: Array<[number, string]> = [
  [8.0, 'STRONG TAILWIND'],
  [6.5, 'POSITIVE'],
  [4.5, 'MIXED'],
  [3.0, 'NEGATIVE'],
  [0,   'STRONG HEADWIND'],
];

/**
 * Concentration tolerance by asset type. A broad diversified fund is not a
 * concentrated bet — 32% of a portfolio in an all-equity global ETF is a
 * sensible core allocation, not a risk to flag.
 */
export const CONCENTRATION_BY_TYPE = {
  broadEtf:  { elevated: 50, high: 65, excessive: 80 },
  growthEtf: { elevated: 15, high: 25, excessive: 40 },
  sectorEtf: { elevated: 12, high: 20, excessive: 30 },
  stock:     { elevated: 10, high: 15, excessive: 20 },
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
`Current Holdings YTD Price Return
Shows the year-to-date price return of the securities currently held, weighted
by their current market value. For a holding bought during the year the return
is measured from its purchase date.

It does NOT account for positions that were sold, reduced, or added to during
the year, nor for deposits and withdrawals. It is therefore not your true
portfolio return — a time-weighted or money-weighted (XIRR) figure would require
full transaction history.

Compared against SPY and TSX over the same year-to-date period, and deliberately
excluded from the Portfolio Health score.`;

export const PORTFOLIO_HEALTH_HELP =
`Portfolio Health (0–10)
How well constructed and fundamentally healthy the portfolio is — a structural
measure, not a market-timing one.

Weighted Asset Quality 35% · Position Fit 20% · Diversification 20% ·
Concentration 15% · Trend 5% · Sector Alignment 5%

Current sector rotation and momentum carry only 10% combined, so a temporary
rotation against your sectors does not make a well-built portfolio unhealthy.
Benchmark performance is deliberately excluded.`;

export const MARKET_ALIGNMENT_HELP =
`Market Alignment (0–10)
How well your holdings sit with current market conditions — a tactical measure
that can change quickly.

Sector Rotation 40% · Relative Strength 25% · Trend / Momentum 25% ·
Market Regime 10%

A weak reading does not mean the portfolio is unhealthy; it means the current
rotation is not favouring what you own.`;

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
