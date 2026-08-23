// ─────────────────────────────────────────────────────────────────────────────
// Scorecard — scoring configuration.
//
// Four independent dimensions are scored first, then combined into the three
// horizon scores with different weights. Keeping them separate is the point:
// a great business can have a poor current setup without becoming "a 6/10 stock".
// ─────────────────────────────────────────────────────────────────────────────

/** Company Quality (0–10) — the business only. No price or setup inputs. */
export const COMPANY_QUALITY_WEIGHTS = {
  profitability:      20,  // net & operating margin
  cashFlow:           18,  // free cash flow generation
  capitalEfficiency:  18,  // ROE / ROIC
  financialDurability: 16, // leverage, current ratio
  growthQuality:      16,  // revenue & EPS growth durability
  moat:               12,  // gross margin as a durable-advantage proxy
};

/** Valuation (0–10) — price relative to the business. */
export const VALUATION_WEIGHTS = {
  forwardPE:   28,
  trailingPE:  18,
  peg:         22,
  fcfYield:    18,
  priceToBook: 14,
};

/** Technical Setup (0–10) — the current chart. Changes frequently. */
export const TECHNICAL_WEIGHTS = {
  vs200MA:      30,
  vs50MA:       26,
  position52W:  20,
  volume:       12,
  momentum:     12,
};

/** Market Alignment (0–10) — external conditions. Reuses Sector Rotation. */
export const MARKET_ALIGNMENT_WEIGHTS = {
  sectorRotation:   35,
  relativeStrength: 30,
  momentum:         20,
  sentiment:        15,
};

// ── Horizon blends ───────────────────────────────────────────────────────────

export const SWING_WEIGHTS = {
  technicalSetup:  45,
  marketAlignment: 30,
  companyQuality:  15,
  valuation:       10,
};

export const MEDIUM_TERM_WEIGHTS = {
  companyQuality:  30,
  technicalSetup:  25,
  valuation:       25,
  marketAlignment: 20,
};

export const LONG_TERM_WEIGHTS = {
  companyQuality:  60,   // includes growth durability and moat
  valuation:       25,
  technicalSetup:  10,
  marketAlignment:  5,
};

// ── Labels ───────────────────────────────────────────────────────────────────

export const SCORE_THRESHOLDS: Array<[number, string]> = [
  [9.0, 'EXCEPTIONAL'],
  [8.0, 'STRONG'],
  [7.0, 'ATTRACTIVE'],
  [6.0, 'CONDITIONAL'],
  [5.0, 'NEUTRAL'],
  [4.0, 'WEAK'],
  [0,   'POOR'],
];

export const QUALITY_THRESHOLDS: Array<[number, string]> = [
  [9.0, 'EXCEPTIONAL'],
  [8.0, 'HIGH QUALITY'],
  [6.5, 'SOLID'],
  [5.0, 'AVERAGE'],
  [3.5, 'WEAK'],
  [0,   'POOR'],
];

export const DATA_COVERAGE_THRESHOLDS = {
  low: 60,        // below this → LOW DATA CONFIDENCE
  moderate: 80,   // below this → MODERATE
};

export const HORIZON_LABELS = {
  swing:  { title: 'Swing Setup Score',          window: '3–21 days' },
  medium: { title: 'Medium-Term Opportunity',    window: '6–12 months' },
  long:   { title: 'Long-Term Investment Score', window: '2+ years' },
};

export const DIMENSION_HELP = {
  companyQuality:
`Company Quality (0–10)
How strong the underlying business is, independent of today's price or chart.

Profitability, cash flow, capital efficiency, financial durability, growth
quality and moat. Price action, RSI, moving averages and sector rotation are
deliberately excluded — those belong to Technical Setup and Market Alignment.

This score moves slowly. A falling share price does not make the business worse.`,

  valuation:
`Valuation (0–10)
How attractive today's price is relative to the business.

Forward and trailing P/E, PEG, free-cash-flow yield and price/book. A great
company can score 9 on quality and 5 on valuation — that is not a contradiction,
it means a good business at a full price.`,

  technicalSetup:
`Technical Setup (0–10)
How attractive the current chart and entry are: price versus its 200-day,
50-day, position in the 52-week range, volume and momentum.

This is the fastest-moving score and says nothing about business quality.`,

  marketAlignment:
`Market Alignment (0–10)
Whether current external conditions support the trade: sector rotation
pressure, the stock's relative strength versus its sector, momentum and
sentiment where available.

Rotation data comes from the Sector Rotation module — it is never recalculated
here, and it never touches Company Quality.`,

  coverage:
`Data Coverage
The share of a score's weighting that had real data behind it.

Unavailable metrics are excluded and the remaining weights are renormalised —
they are never substituted with a neutral 5.0. Low coverage lowers confidence
in the score, not the score itself.`,
};
