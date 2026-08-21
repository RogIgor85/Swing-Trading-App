// ─────────────────────────────────────────────────────────────────────────────
// Sector Rotation — centralized configuration
// All scoring weights, thresholds and cache durations live here so the
// algorithm can be tuned without touching UI or engine code.
// ─────────────────────────────────────────────────────────────────────────────

export interface SectorDef {
  etf: string;
  name: string;
  short: string;          // compact label for charts
  cyclical: boolean;      // true = risk-on sector, false = defensive
  constituents: string[]; // top holdings (static; used for breadth + drill-down)
}

export const BENCHMARK_ETF = 'SPY';

// Top ~15 constituents per sector ETF — internally maintained mapping,
// refreshed manually (live constituent lists are not available on the
// current data tier). Centralized here; never hard-coded in components.
// Breadth computed from these is labeled "top-holdings breadth".
export const SECTOR_ETFS: SectorDef[] = [
  { etf: 'XLK',  name: 'Technology',             short: 'Tech',        cyclical: true,  constituents: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'AMD', 'ADBE', 'CSCO', 'ACN', 'IBM', 'NOW', 'TXN', 'QCOM', 'INTU'] },
  { etf: 'XLF',  name: 'Financials',             short: 'Financials',  cyclical: true,  constituents: ['BRK-B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'AXP', 'C', 'SCHW', 'BLK', 'SPGI', 'PGR', 'CB'] },
  { etf: 'XLV',  name: 'Healthcare',             short: 'Healthcare',  cyclical: false, constituents: ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'ISRG', 'AMGN', 'PFE', 'DHR', 'BSX', 'VRTX', 'SYK', 'GILD'] },
  { etf: 'XLI',  name: 'Industrials',            short: 'Industrials', cyclical: true,  constituents: ['GE', 'CAT', 'RTX', 'UBER', 'HON', 'UNP', 'BA', 'DE', 'LMT', 'ETN', 'ADP', 'MMM', 'UPS', 'PH', 'TT'] },
  { etf: 'XLY',  name: 'Consumer Discretionary', short: 'Cons Disc',   cyclical: true,  constituents: ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG', 'LOW', 'TJX', 'SBUX', 'NKE', 'CMG', 'ORLY', 'MAR', 'GM', 'ABNB', 'HLT'] },
  { etf: 'XLP',  name: 'Consumer Staples',       short: 'Staples',     cyclical: false, constituents: ['COST', 'PG', 'WMT', 'KO', 'PEP', 'PM', 'MDLZ', 'CL', 'TGT', 'KMB', 'MO', 'STZ', 'KDP', 'GIS', 'SYY'] },
  { etf: 'XLE',  name: 'Energy',                 short: 'Energy',      cyclical: true,  constituents: ['XOM', 'CVX', 'COP', 'WMB', 'EOG', 'SLB', 'PSX', 'MPC', 'KMI', 'OKE', 'VLO', 'HES', 'OXY', 'FANG', 'BKR'] },
  { etf: 'XLU',  name: 'Utilities',              short: 'Utilities',   cyclical: false, constituents: ['NEE', 'SO', 'DUK', 'CEG', 'SRE', 'AEP', 'VST', 'D', 'PCG', 'EXC', 'ED', 'XEL', 'EIX', 'WEC', 'PEG'] },
  { etf: 'XLB',  name: 'Materials',              short: 'Materials',   cyclical: true,  constituents: ['LIN', 'SHW', 'APD', 'ECL', 'FCX', 'NEM', 'CTVA', 'DD', 'VMC', 'MLM', 'NUE', 'PPG', 'IFF', 'STLD', 'DOW'] },
  { etf: 'XLRE', name: 'Real Estate',            short: 'Real Estate', cyclical: false, constituents: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'DLR', 'PSA', 'O', 'CCI', 'CBRE', 'EXR', 'AVB', 'VICI', 'IRM', 'VTR'] },
  { etf: 'XLC',  name: 'Communication Services', short: 'Comms',       cyclical: true,  constituents: ['META', 'GOOGL', 'GOOG', 'NFLX', 'DIS', 'TMUS', 'CMCSA', 'VZ', 'T', 'EA', 'CHTR', 'WBD', 'OMC', 'TTWO', 'LYV'] },
];

// ── Rotation Pressure (-100…+100): "which direction is rotation moving?" ─────
// Components are z-scored cross-sectionally across the 11 sectors, clamped,
// then weight-summed. Historical series uses only the price/volume-derived
// components (breadth history is unavailable); breadth terms apply to the
// current value only.
export const ROTATION_PRESSURE_WEIGHTS = {
  rsChange1M:     25, // change in relative strength vs SPY (21d)
  rsChange5D:     10, // change in relative strength vs SPY (5d)
  accelShort:     15, // last 5d return minus previous 5d return
  accelMedium:    10, // last 20d return minus previous 20d return
  shortMomentum:  10, // 5d return
  mediumMomentum:  5, // 21d return
  volumeConfirm:  10, // volume ratio vs 20d average, centered at 1
  trend:           5, // above 50DMA / 200DMA / 50>200 composite
  breadthChange:   7, // breadth score now vs proxy — current value only
  breadthLevel:    3, // breadth score centered at 50 — current value only
};

// ── Rotation Score (0–100): "how strong is this sector overall?" ─────────────
export const ROTATION_SCORE_WEIGHTS = {
  mom5D:       10,
  mom1M:       20,
  mom3M:       20,
  rsVsSpy:     20, // 1M relative strength level
  breadth:     15,
  volume:       5,
  acceleration: 10,
};

// Classification thresholds on Rotation Score
export const ROTATION_THRESHOLDS = {
  leading:   80,
  improving: 65,
  neutral:   45,
  weakening: 30,
  // below weakening = Lagging
};

// Momentum classification thresholds (blended 5d/20d acceleration, decimals)
export const MOMENTUM_THRESHOLDS = {
  accelerating: 0.008,  // > +0.8%
  decelerating: -0.008, // < −0.8%
};

// Pressure-trend arrows (change in pressure over 5 trading days)
export const PRESSURE_TREND_THRESHOLDS = {
  up: 8,
  down: -8,
};

// Signal trigger levels on Rotation Pressure
export const SIGNAL_THRESHOLDS = {
  strongIn:  55,
  rotationIn: 22,
  rotationOut: -22,
  strongOut: -55,
};

export const BREADTH_SETTINGS = {
  // Full breadth from constituent price history (spark endpoint)
  weights: { above20: 0.25, above50: 0.25, above200: 0.20, pos5D: 0.15, pos20D: 0.15 },
  // Fallback when only current batch quotes are available (no history)
  quoteFallbackWeights: { above50: 0.4, above200: 0.35, positiveToday: 0.25 },
  minConstituents: 4,   // need at least this many names reporting to score
  changeLookbackDays: 5,
};

// Participation Score (0–100) for individual stocks inside a sector.
// Missing components are dropped and remaining weights renormalized.
export const PARTICIPATION_WEIGHTS = {
  rsVsSector1M: 30,
  ret1M:        20,
  ret5D:        15,
  volumeRatio:  15,
  above50:      10,
  above200:     10,
};

// Opportunity trigger thresholds
export const OPPORTUNITY_THRESHOLDS = {
  maxCards: 8,
  acceleratingLeaderScore: 75,
  strongLeaderScore: 80,
  improvingBreadthChange: 12,
  pullbackScore: 72,
  pullback5D: -0.015,
  rotationOutPressure: -40,
};

export const VOLUME_LEVELS = {
  weak: 0.8,
  elevated: 1.2,
  strong: 1.5,
};

// Cache durations (ms)
export const SECTOR_CACHE = {
  history:      30 * 60 * 1000,       // ETF daily history: 30 min
  quotes:        3 * 60 * 1000,       // SPY header quote: 3 min
  constituents: 30 * 60 * 1000,       // batched constituent quotes: 30 min
  constituentHistory: 30 * 60 * 1000, // batched constituent close history: 30 min
  fundamentals: 12 * 60 * 60 * 1000,  // per-ticker fundamentals: 12 h
};

// Matrix trail: one observation per N trading days, this many observations
export const MATRIX_TRAIL = { stepDays: 5, points: 4 };

export type Timeframe = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y';
export const TIMEFRAME_DAYS: Record<Timeframe, number> = {
  '1D': 1, '5D': 5, '1M': 21, '3M': 63, '6M': 126, '1Y': 251,
};
export type MatrixTimeframe = '1M' | '3M' | '6M';
