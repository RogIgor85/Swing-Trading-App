// ─────────────────────────────────────────────────────────────────────────────
// Portfolio — centralized configuration.
// Position-type registry, sector labels, and all thresholds/weights.
// ─────────────────────────────────────────────────────────────────────────────

export type PositionType =
  | 'Individual Stock'
  | 'Broad-Market ETF'      // genuinely diversified across sectors & regions
  | 'Growth/Index ETF'      // concentrated index (e.g. Nasdaq-100) — partial credit only
  | 'Sector ETF'
  | 'Specialty ETF'
  | 'Other';

/** Allocation bucket label used when an ETF has no single sector. */
export const DIVERSIFIED_LABEL = 'Diversified ETF';
export const GROWTH_ETF_LABEL  = 'Growth / Nasdaq ETF';
export const SPECIALTY_LABEL   = 'Specialty ETF';
export const UNCLASSIFIED_LABEL = 'Unclassified';

export type EtfRole = 'CORE' | 'SATELLITE' | 'SECTOR' | 'TACTICAL';

export interface EtfDef {
  type: PositionType;
  label: string;      // allocation bucket
  sectorEtf?: string; // only for single-sector ETFs
  note?: string;
  role?: EtfRole;
  /** Management expense ratio, %. Manually maintained snapshot — verify before relying on it. */
  expenseRatio?: number;
  issuer?: string;
  /** Rough scale of the fund; drives the liquidity / stability factor. */
  aumTier?: 'mega' | 'large' | 'mid' | 'small';
  indexName?: string;
  /** Approximate number of underlying holdings — diversification WITHIN mandate. */
  holdingsCount?: number;
  /**
   * Approximate top index weights, [ticker, weight %]. Used to measure real
   * overlap with directly held names — a PORTFOLIO FIT input, never a product
   * quality input.
   */
  topHoldings?: Array<[string, number]>;
}

/** Nasdaq-100 style top weights (approximate, manually maintained). */
const NDX_TOP: Array<[string, number]> = [
  ['NVDA', 9.0], ['AAPL', 8.0], ['MSFT', 7.8], ['AVGO', 5.5], ['AMZN', 5.2],
  ['META', 3.8], ['NFLX', 3.0], ['TSLA', 2.9], ['COST', 2.5], ['GOOGL', 2.5],
  ['GOOG', 2.4], ['AMD', 1.9], ['ADBE', 1.3], ['CSCO', 1.3], ['QCOM', 1.2],
  ['INTU', 1.2], ['TXN', 1.1], ['AMGN', 1.1], ['ISRG', 1.1], ['BKNG', 1.0],
];

/** Broad global/US equity funds hold thousands of names; top weights are small. */
const BROAD_TOP: Array<[string, number]> = [
  ['NVDA', 4.2], ['AAPL', 3.9], ['MSFT', 3.8], ['AMZN', 2.4], ['META', 1.8],
  ['AVGO', 1.7], ['GOOGL', 1.2], ['GOOG', 1.0], ['TSLA', 1.2], ['BRK-B', 1.1],
];

/**
 * Known ETFs. Broad-market funds are deliberately NOT assigned a sector —
 * we do not pretend to know their underlying weights without holdings data.
 */
export const ETF_REGISTRY: Record<string, EtfDef> = {
  // All-in-one / broad equity (CA)
  'XEQT.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'All-equity global', role: 'CORE',
    expenseRatio: 0.20, issuer: 'BlackRock / iShares', aumTier: 'large', indexName: 'Global all-equity (4-fund)', holdingsCount: 9000, topHoldings: BROAD_TOP },
  'VEQT.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'All-equity global', role: 'CORE',
    expenseRatio: 0.24, issuer: 'Vanguard', aumTier: 'large', indexName: 'Global all-equity (4-fund)', holdingsCount: 13000, topHoldings: BROAD_TOP },
  'XGRO.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: '80/20 growth' },
  'VGRO.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: '80/20 growth' },
  'XBAL.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: '60/40 balanced' },
  'VBAL.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: '60/40 balanced' },
  // Broad index (CA-listed)
  'VFV.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P 500' },
  'XUS.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P 500' },
  'ZSP.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P 500' },
  'XIC.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P/TSX Capped' },
  'ZCN.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P/TSX Capped' },
  'VCN.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'FTSE Canada' },
  'XAW.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'All-world ex-Canada' },
  'VXC.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'All-world ex-Canada' },
  // Broad index (US-listed)
  'SPY':  { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P 500' },
  'VOO':  { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P 500' },
  'IVV':  { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'S&P 500' },
  'VTI':  { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'Total US market' },
  'ITOT': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'Total US market' },
  'VT':   { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'Total world' },
  // Fixed income
  'ZAG.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'Aggregate bonds' },
  'XBB.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'Aggregate bonds' },
  'BND':    { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'Aggregate bonds' },
  'AGG':    { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'Aggregate bonds' },
  // Nasdaq-100 / growth — NOT broadly diversified. Heavily concentrated in
  // large-cap tech, so these overlap directly with individual tech holdings
  // and receive materially less diversification credit than a broad fund.
  'QQC.TO':   { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'Nasdaq-100 (CAD hedged)', role: 'SATELLITE',
    expenseRatio: 0.35, issuer: 'Invesco', aumTier: 'mid', indexName: 'NASDAQ-100', holdingsCount: 100, topHoldings: NDX_TOP },
  'QQC-F.TO': { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'Nasdaq-100 (CAD, unhedged)', role: 'SATELLITE',
    expenseRatio: 0.35, issuer: 'Invesco', aumTier: 'mid', indexName: 'NASDAQ-100', holdingsCount: 100, topHoldings: NDX_TOP },
  'ZNQ.TO':   { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'Nasdaq-100', role: 'SATELLITE',
    expenseRatio: 0.39, issuer: 'BMO', aumTier: 'mid', indexName: 'NASDAQ-100', holdingsCount: 100, topHoldings: NDX_TOP },
  'HXQ.TO':   { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'Nasdaq-100 (total return)', role: 'SATELLITE',
    expenseRatio: 0.28, issuer: 'Global X', aumTier: 'mid', indexName: 'NASDAQ-100', holdingsCount: 100, topHoldings: NDX_TOP },
  'XQQ.TO':   { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'Nasdaq-100 (CAD hedged)', role: 'SATELLITE',
    expenseRatio: 0.39, issuer: 'BlackRock / iShares', aumTier: 'large', indexName: 'NASDAQ-100', holdingsCount: 100, topHoldings: NDX_TOP },
  'QQQ':      { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'Nasdaq-100', role: 'SATELLITE',
    expenseRatio: 0.20, issuer: 'Invesco', aumTier: 'mega', indexName: 'NASDAQ-100', holdingsCount: 100, topHoldings: NDX_TOP },
  'QQQM':     { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'Nasdaq-100', role: 'SATELLITE',
    expenseRatio: 0.15, issuer: 'Invesco', aumTier: 'large', indexName: 'NASDAQ-100', holdingsCount: 100, topHoldings: NDX_TOP },
  'VGT':      { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'US technology sector', role: 'SATELLITE',
    expenseRatio: 0.09, issuer: 'Vanguard', aumTier: 'mega', indexName: 'MSCI US IMI Info Tech', holdingsCount: 320 },
  'SCHG':     { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'US large-cap growth', role: 'SATELLITE',
    expenseRatio: 0.04, issuer: 'Schwab', aumTier: 'large', indexName: 'Dow Jones US Large-Cap Growth', holdingsCount: 230 },
  'VUG':      { type: 'Growth/Index ETF', label: GROWTH_ETF_LABEL, note: 'US large-cap growth', role: 'SATELLITE',
    expenseRatio: 0.04, issuer: 'Vanguard', aumTier: 'mega', indexName: 'CRSP US Large Growth', holdingsCount: 180 },
  // Single-sector SPDRs — these DO map to a sector
  'XLK':  { type: 'Sector ETF', label: 'Technology',             sectorEtf: 'XLK' },
  'XLF':  { type: 'Sector ETF', label: 'Financials',             sectorEtf: 'XLF' },
  'XLV':  { type: 'Sector ETF', label: 'Healthcare',             sectorEtf: 'XLV' },
  'XLI':  { type: 'Sector ETF', label: 'Industrials',            sectorEtf: 'XLI' },
  'XLY':  { type: 'Sector ETF', label: 'Consumer Discretionary', sectorEtf: 'XLY' },
  'XLP':  { type: 'Sector ETF', label: 'Consumer Staples',       sectorEtf: 'XLP' },
  'XLE':  { type: 'Sector ETF', label: 'Energy',                 sectorEtf: 'XLE' },
  'XLU':  { type: 'Sector ETF', label: 'Utilities',              sectorEtf: 'XLU' },
  'XLB':  { type: 'Sector ETF', label: 'Materials',              sectorEtf: 'XLB' },
  'XLRE': { type: 'Sector ETF', label: 'Real Estate',            sectorEtf: 'XLRE' },
  'XLC':  { type: 'Sector ETF', label: 'Communication Services', sectorEtf: 'XLC' },
};

/** Sector ETF → display name (mirrors sectorConfig, kept for allocation labels). */
export const SECTOR_NAME_BY_ETF: Record<string, string> = {
  XLK: 'Technology',
  XLF: 'Financials',
  XLV: 'Healthcare',
  XLI: 'Industrials',
  XLY: 'Consumer Discretionary',
  XLP: 'Consumer Staples',
  XLE: 'Energy',
  XLU: 'Utilities',
  XLB: 'Materials',
  XLRE: 'Real Estate',
  XLC: 'Communication Services',
};

export const CONCENTRATION_THRESHOLDS = {
  // Individual-stock weights (%)
  stockHigh: 20,
  stockVeryHigh: 30,
  top3StocksHigh: 45,
  top3StocksVeryHigh: 60,
  sectorHigh: 35,
  sectorVeryHigh: 50,
  // Broad ETFs are diversified by construction — much looser
  broadEtfHigh: 60,
  minHoldingsForLow: 8,
  // Growth/Nasdaq funds are concentrated in large-cap tech and overlap with
  // direct holdings, so they earn only partial diversification credit.
  growthEtfConcentrated: 25,
};

export const TARGET_THRESHOLDS = {
  nearTargetPct: 5,      // within 5% of sell target → NEAR TARGET
  staleTargetPct: 100,   // price >100% past target → target considered outdated
};

export const CORRELATION_SETTINGS = {
  defaultDays: 90,
  options: [30, 90, 180, 252] as const,
  minObservations: 20,
  maxTickers: 20,
};

/** Sector-relative performance thresholds for holding status (decimals). */
export const HOLDING_STATUS_THRESHOLDS = {
  leaderRs: 0.02,      // > +2% vs sector over 1M
  weakeningRs: -0.02,  // < −2% vs sector over 1M
};

export type HoldingStatus = 'LEADER' | 'HOLDING' | 'WEAKENING' | 'REVIEW';

export const HOLDING_STATUS_STYLE: Record<HoldingStatus, string> = {
  LEADER:    'text-emerald-400',
  HOLDING:   'text-zinc-400',
  WEAKENING: 'text-amber-400',
  REVIEW:    'text-orange-400',
};

export const ROTATION_EXPOSURE_HELP =
`Portfolio Rotation Exposure
A portfolio-weighted estimate of current sector rotation pressure across directly classifiable holdings.

Positive values indicate more exposure to sectors showing positive rotation characteristics.
Negative values indicate more exposure to weakening sectors.

Diversified and specialty ETFs are excluded — their underlying sector weights are not known.
This is not literal fund flow.`;
