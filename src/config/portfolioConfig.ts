// ─────────────────────────────────────────────────────────────────────────────
// Portfolio — centralized configuration.
// Position-type registry, sector labels, and all thresholds/weights.
// ─────────────────────────────────────────────────────────────────────────────

export type PositionType = 'Individual Stock' | 'Broad-Market ETF' | 'Sector ETF' | 'Specialty ETF' | 'Other';

/** Allocation bucket label used when an ETF has no single sector. */
export const DIVERSIFIED_LABEL = 'Diversified ETF';
export const SPECIALTY_LABEL   = 'Specialty ETF';
export const UNCLASSIFIED_LABEL = 'Unclassified';

export interface EtfDef {
  type: PositionType;
  label: string;      // allocation bucket
  sectorEtf?: string; // only for single-sector ETFs
  note?: string;
}

/**
 * Known ETFs. Broad-market funds are deliberately NOT assigned a sector —
 * we do not pretend to know their underlying weights without holdings data.
 */
export const ETF_REGISTRY: Record<string, EtfDef> = {
  // All-in-one / broad equity (CA)
  'XEQT.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'All-equity global' },
  'VEQT.TO': { type: 'Broad-Market ETF', label: DIVERSIFIED_LABEL, note: 'All-equity global' },
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
  // Nasdaq-100 — tech-heavy but multi-sector, so specialty rather than sector
  'QQC.TO': { type: 'Specialty ETF', label: SPECIALTY_LABEL, note: 'Nasdaq-100 (CAD hedged)' },
  'QQC-F.TO': { type: 'Specialty ETF', label: SPECIALTY_LABEL, note: 'Nasdaq-100 (CAD)' },
  'ZNQ.TO': { type: 'Specialty ETF', label: SPECIALTY_LABEL, note: 'Nasdaq-100' },
  'HXQ.TO': { type: 'Specialty ETF', label: SPECIALTY_LABEL, note: 'Nasdaq-100' },
  'QQQ':    { type: 'Specialty ETF', label: SPECIALTY_LABEL, note: 'Nasdaq-100' },
  'QQQM':   { type: 'Specialty ETF', label: SPECIALTY_LABEL, note: 'Nasdaq-100' },
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
