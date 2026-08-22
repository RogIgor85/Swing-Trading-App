// ─────────────────────────────────────────────────────────────────────────────
// Portfolio engine — pure calculations. No fetching, no UI.
//
// Currency rule: a security's price is always in its LISTING currency.
// `holding.currency` records that listing currency, so CAD-listed securities
// are never FX-converted and USD-listed securities are converted exactly once.
//
// Missing data rule: absent prices, previous closes, sectors or history yield
// null — never 0 — and are excluded from aggregates rather than dragging them.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ETF_REGISTRY, SECTOR_NAME_BY_ETF, CONCENTRATION_THRESHOLDS, TARGET_THRESHOLDS,
  HOLDING_STATUS_THRESHOLDS, UNCLASSIFIED_LABEL,
} from '../../config/portfolioConfig';
import type { PositionType, HoldingStatus } from '../../config/portfolioConfig';
import type { Holding, Currency } from '../../types';
import type { SectorMetrics } from '../sector/sectorEngine';

export interface PriceInfo {
  price: number;
  prevClose: number | null;
  /** true when the price is a hand-entered override rather than a live quote */
  manual?: boolean;
}

export interface EnrichedHolding {
  h: Holding;
  ticker: string;
  positionType: PositionType;
  isEtf: boolean;

  sectorEtf: string | null;      // null for diversified/specialty/unclassified
  sectorLabel: string;           // allocation bucket
  sectorIsManual: boolean;
  staleStoredSector: string | null;  // legacy holding.sector superseded by detection

  currentPrice: number | null;
  priceSource: 'manual' | 'live' | 'cost';
  prevClose: number | null;

  dailyPct: number | null;
  dailyPnlNative: number | null;
  dailyPnlCAD: number | null;
  dailyFromManualPrice: boolean;

  marketValueNative: number;
  costBasisNative: number;
  pnlNative: number;
  pnlPct: number | null;

  marketValueCAD: number;
  costBasisCAD: number;
  pnlCAD: number;
  allocationPct: number;

  ret1M: number | null;          // decimals
  ret3M: number | null;
  rsVsSector1M: number | null;

  targetRemainingPct: number | null;
  nearTarget: boolean;
  targetReached: boolean;
  targetStale: boolean;

  status: HoldingStatus;
  statusReasons: string[];
}

// ── classification ───────────────────────────────────────────────────────────

export function positionTypeOf(ticker: string): PositionType {
  const def = ETF_REGISTRY[ticker.toUpperCase()];
  return def ? def.type : 'Individual Stock';
}

export function isEtf(ticker: string): boolean {
  return positionTypeOf(ticker) !== 'Individual Stock';
}

/**
 * Resolve a holding's allocation bucket.
 * - Known ETFs use the registry (broad funds get "Diversified ETF", never a sector).
 * - Individual stocks use the detected sector ETF.
 * - A stored holding.sector that disagrees with detection is treated as a
 *   manual override and wins, but is flagged.
 */
export function classifyHolding(
  h: Holding,
  detectedSectorEtf: string | null,
  /** Deliberate pin from sectorOverrides — only this beats provider detection. */
  explicitOverride?: string | null,
): { sectorEtf: string | null; sectorLabel: string; sectorIsManual: boolean; staleStoredSector: string | null } {
  const t = h.ticker.toUpperCase();
  const etf = ETF_REGISTRY[t];
  if (etf) {
    return { sectorEtf: etf.sectorEtf ?? null, sectorLabel: etf.label, sectorIsManual: false, staleStoredSector: null };
  }

  const detectedLabel = detectedSectorEtf ? SECTOR_NAME_BY_ETF[detectedSectorEtf] ?? null : null;
  const stored = (h.sector ?? '').trim();
  const storedIsMeaningful = stored.length > 0 && stored.toLowerCase() !== 'other';

  // A deliberate pin always wins
  if (explicitOverride) {
    const etfForOverride = Object.entries(SECTOR_NAME_BY_ETF).find(([, n]) => n === explicitOverride)?.[0] ?? null;
    return { sectorEtf: etfForOverride, sectorLabel: explicitOverride, sectorIsManual: true, staleStoredSector: null };
  }

  // Provider classification is authoritative. A disagreeing stored value is
  // treated as legacy data, surfaced for transparency but not used.
  if (detectedLabel) {
    return {
      sectorEtf: detectedSectorEtf,
      sectorLabel: detectedLabel,
      sectorIsManual: false,
      staleStoredSector: storedIsMeaningful && stored !== detectedLabel ? stored : null,
    };
  }

  // No provider data — fall back to whatever the user stored
  if (storedIsMeaningful) {
    return { sectorEtf: null, sectorLabel: stored, sectorIsManual: false, staleStoredSector: null };
  }
  return { sectorEtf: null, sectorLabel: UNCLASSIFIED_LABEL, sectorIsManual: false, staleStoredSector: null };
}

// ── price history helpers ────────────────────────────────────────────────────

export function returnOver(closes: number[] | undefined, n: number): number | null {
  if (!closes || closes.length < n + 1) return null;
  const end = closes[closes.length - 1];
  const start = closes[closes.length - 1 - n];
  if (!start || start === 0) return null;
  return end / start - 1;
}

// ── per-holding enrichment ───────────────────────────────────────────────────

export function enrichHolding(args: {
  h: Holding;
  price: PriceInfo | null;
  fxUsdCad: number;
  detectedSectorEtf: string | null;
  sector: SectorMetrics | null;
  closes?: number[];
  sectorOverride?: string | null;
}): Omit<EnrichedHolding, 'allocationPct'> {
  const { h, price, fxUsdCad, detectedSectorEtf, sector, closes, sectorOverride } = args;

  const cls = classifyHolding(h, detectedSectorEtf, sectorOverride);
  const type = positionTypeOf(h.ticker);

  // FX factor: applied exactly once, and only to USD-listed securities
  const fx = h.currency === 'USD' ? fxUsdCad : 1;

  const currentPrice = price?.price ?? null;
  const priceSource: 'manual' | 'live' | 'cost' =
    price?.manual ? 'manual' : currentPrice != null ? 'live' : 'cost';

  const effectivePrice = currentPrice ?? h.avg_cost;
  const prevClose = price?.prevClose ?? null;

  // Daily change strictly vs the previous trading-day close
  let dailyPct: number | null = null;
  let dailyPnlNative: number | null = null;
  let dailyPnlCAD: number | null = null;
  if (currentPrice != null && prevClose != null && prevClose > 0) {
    dailyPct = ((currentPrice - prevClose) / prevClose) * 100;
    dailyPnlNative = (currentPrice - prevClose) * h.shares;
    dailyPnlCAD = dailyPnlNative * fx;
  }

  const marketValueNative = h.shares * effectivePrice;
  const costBasisNative = h.shares * h.avg_cost;
  const pnlNative = marketValueNative - costBasisNative;
  const pnlPct = costBasisNative > 0 ? (pnlNative / costBasisNative) * 100 : null;

  const ret1M = returnOver(closes, 21);
  const ret3M = returnOver(closes, 63);
  const rsVsSector1M =
    ret1M != null && sector?.ret['1M'] != null ? ret1M - sector.ret['1M']! : null;

  // Sell target
  let targetRemainingPct: number | null = null;
  let nearTarget = false;
  let targetReached = false;
  let targetStale = false;
  const tp = h.target_price;
  if (tp && tp > 0 && currentPrice != null && currentPrice > 0) {
    targetRemainingPct = ((tp - currentPrice) / currentPrice) * 100;
    targetReached = currentPrice >= tp;
    targetStale = targetReached && ((currentPrice - tp) / tp) * 100 > TARGET_THRESHOLDS.staleTargetPct;
    nearTarget = !targetReached && targetRemainingPct <= TARGET_THRESHOLDS.nearTargetPct;
  }

  // Informational status — never a sell instruction
  const statusReasons: string[] = [];
  const H = HOLDING_STATUS_THRESHOLDS;
  let status: HoldingStatus = 'HOLDING';
  const negatives: string[] = [];

  if (rsVsSector1M != null) {
    if (rsVsSector1M >= H.leaderRs) statusReasons.push(`Outperforming ${cls.sectorLabel} by ${(rsVsSector1M * 100).toFixed(1)}% over 1M`);
    else if (rsVsSector1M <= H.weakeningRs) negatives.push(`Underperforming ${cls.sectorLabel} by ${(Math.abs(rsVsSector1M) * 100).toFixed(1)}% over 1M`);
  }
  if (sector && sector.pressure <= -22) negatives.push(`Sector rotation pressure ${sector.pressure}`);
  if (targetReached && !targetStale) negatives.push(`Price reached sell target $${tp}`);
  if (pnlPct != null && pnlPct <= -20) negatives.push(`Down ${Math.abs(pnlPct).toFixed(1)}% from cost`);

  if (negatives.length >= 2) {
    status = 'REVIEW';
  } else if (negatives.length === 1) {
    status = 'WEAKENING';
  } else if (rsVsSector1M != null && rsVsSector1M >= H.leaderRs && (sector?.pressure ?? 0) >= 0) {
    status = 'LEADER';
  }
  statusReasons.push(...negatives);

  return {
    h, ticker: h.ticker, positionType: type, isEtf: type !== 'Individual Stock',
    sectorEtf: cls.sectorEtf, sectorLabel: cls.sectorLabel, sectorIsManual: cls.sectorIsManual,
    staleStoredSector: cls.staleStoredSector,
    currentPrice, priceSource, prevClose,
    dailyPct, dailyPnlNative, dailyPnlCAD, dailyFromManualPrice: priceSource === 'manual' && dailyPct != null,
    marketValueNative, costBasisNative, pnlNative, pnlPct,
    marketValueCAD: marketValueNative * fx,
    costBasisCAD: costBasisNative * fx,
    pnlCAD: pnlNative * fx,
    ret1M, ret3M, rsVsSector1M,
    targetRemainingPct, nearTarget, targetReached, targetStale,
    status, statusReasons,
  };
}

export function withAllocation(rows: Array<Omit<EnrichedHolding, 'allocationPct'>>): EnrichedHolding[] {
  const total = rows.reduce((s, r) => s + r.marketValueCAD, 0);
  return rows.map(r => ({ ...r, allocationPct: total > 0 ? (r.marketValueCAD / total) * 100 : 0 }));
}

// ── portfolio totals ─────────────────────────────────────────────────────────

export interface PortfolioTotals {
  marketValueCAD: number;
  costBasisCAD: number;
  pnlCAD: number;
  pnlPct: number | null;
  dailyPnlCAD: number | null;
  dailyPct: number | null;
  /** holdings contributing to the daily figure (have a valid previous close) */
  dailyCoverage: { counted: number; total: number };
}

export function computeTotals(rows: EnrichedHolding[]): PortfolioTotals {
  const marketValueCAD = rows.reduce((s, r) => s + r.marketValueCAD, 0);
  const costBasisCAD = rows.reduce((s, r) => s + r.costBasisCAD, 0);
  const pnlCAD = marketValueCAD - costBasisCAD;

  // Daily % compares today's value to the prior close value across the SAME
  // holdings, so partial coverage can't distort the percentage.
  const withPrev = rows.filter(r => r.dailyPnlCAD != null && r.prevClose != null && r.currentPrice != null);
  const dailyPnlCAD = withPrev.length > 0
    ? withPrev.reduce((s, r) => s + (r.dailyPnlCAD ?? 0), 0)
    : null;
  const prevValueCAD = withPrev.reduce((s, r) => {
    const fx = r.h.currency === 'USD' ? (r.marketValueCAD / (r.marketValueNative || 1)) : 1;
    return s + r.h.shares * (r.prevClose ?? 0) * fx;
  }, 0);
  const dailyPct = dailyPnlCAD != null && prevValueCAD > 0 ? (dailyPnlCAD / prevValueCAD) * 100 : null;

  return {
    marketValueCAD, costBasisCAD, pnlCAD,
    pnlPct: costBasisCAD > 0 ? (pnlCAD / costBasisCAD) * 100 : null,
    dailyPnlCAD, dailyPct,
    dailyCoverage: { counted: withPrev.length, total: rows.length },
  };
}

// ── sector allocation ────────────────────────────────────────────────────────

export interface AllocationRow {
  label: string;
  sectorEtf: string | null;
  valueCAD: number;
  weightPct: number;
  isDiversified: boolean;
}

export function computeAllocation(rows: EnrichedHolding[]): AllocationRow[] {
  const total = rows.reduce((s, r) => s + r.marketValueCAD, 0);
  const map = new Map<string, { value: number; etf: string | null; diversified: boolean }>();
  for (const r of rows) {
    const cur = map.get(r.sectorLabel) ?? { value: 0, etf: r.sectorEtf, diversified: r.isEtf && !r.sectorEtf };
    cur.value += r.marketValueCAD;
    if (!cur.etf && r.sectorEtf) cur.etf = r.sectorEtf;
    map.set(r.sectorLabel, cur);
  }
  return [...map.entries()]
    .map(([label, v]) => ({
      label,
      sectorEtf: v.etf,
      valueCAD: v.value,
      weightPct: total > 0 ? (v.value / total) * 100 : 0,
      isDiversified: v.diversified,
    }))
    .sort((a, b) => b.valueCAD - a.valueCAD);
}

// ── concentration ────────────────────────────────────────────────────────────

export type ConcentrationLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'VERY HIGH';

export interface ConcentrationAnalysis {
  level: ConcentrationLevel;
  reasons: string[];
  largestPosition: { ticker: string; pct: number } | null;
  largestStock: { ticker: string; pct: number } | null;
  largestEtf: { ticker: string; pct: number } | null;
  largestBroadEtf: { ticker: string; pct: number } | null;
  largestGrowthEtf: { ticker: string; pct: number } | null;
  top3StocksPct: number | null;
  top5Pct: number | null;
  largestSector: { label: string; pct: number } | null;
  broadEtfPct: number;
  growthEtfPct: number;
  holdingsCount: number;
}

export function computeConcentration(rows: EnrichedHolding[], allocation: AllocationRow[]): ConcentrationAnalysis {
  const C = CONCENTRATION_THRESHOLDS;
  const byWeight = [...rows].sort((a, b) => b.allocationPct - a.allocationPct);
  const stocks = byWeight.filter(r => !r.isEtf);
  const etfs = byWeight.filter(r => r.isEtf);

  const pick = (r?: EnrichedHolding) => r ? { ticker: r.ticker, pct: r.allocationPct } : null;
  const top3StocksPct = stocks.length > 0 ? stocks.slice(0, 3).reduce((s, r) => s + r.allocationPct, 0) : null;
  const top5Pct = byWeight.length > 0 ? byWeight.slice(0, 5).reduce((s, r) => s + r.allocationPct, 0) : null;

  // Broad funds and concentrated growth-index funds are counted separately —
  // a Nasdaq-100 fund is not the diversifier a global all-equity fund is.
  const broadEtfs  = byWeight.filter(r => r.positionType === 'Broad-Market ETF');
  const growthEtfs = byWeight.filter(r => r.positionType === 'Growth/Index ETF');
  const broadEtfPct  = broadEtfs.reduce((s, r) => s + r.allocationPct, 0);
  const growthEtfPct = growthEtfs.reduce((s, r) => s + r.allocationPct, 0);

  // Sector concentration ignores diversified buckets — those aren't a sector bet
  const sectorRows = allocation.filter(a => !a.isDiversified && a.label !== UNCLASSIFIED_LABEL);
  const largestSector = sectorRows.length > 0
    ? { label: sectorRows[0].label, pct: sectorRows[0].weightPct }
    : null;

  const reasons: string[] = [];
  let score = 0;

  const ls = pick(stocks[0]);
  if (ls) {
    reasons.push(`Largest individual stock: ${ls.ticker} ${ls.pct.toFixed(1)}%`);
    if (ls.pct >= C.stockVeryHigh) score += 3;
    else if (ls.pct >= C.stockHigh) score += 2;
  }
  if (top3StocksPct != null && stocks.length >= 2) {
    reasons.push(`Top 3 individual stocks: ${top3StocksPct.toFixed(1)}%`);
    if (top3StocksPct >= C.top3StocksVeryHigh) score += 3;
    else if (top3StocksPct >= C.top3StocksHigh) score += 2;
  }
  if (largestSector) {
    reasons.push(`${largestSector.label} exposure: ${largestSector.pct.toFixed(1)}%`);
    if (largestSector.pct >= C.sectorVeryHigh) score += 2;
    else if (largestSector.pct >= C.sectorHigh) score += 1;
  }
  if (broadEtfPct > 0) {
    reasons.push(`Broad-market ETFs: ${broadEtfPct.toFixed(1)}% (full diversification credit)`);
    // Genuinely diversified funds REDUCE concentration risk
    if (broadEtfPct >= 50) score -= 2;
    else if (broadEtfPct >= 25) score -= 1;
  }
  if (growthEtfPct > 0) {
    reasons.push(`Growth / Nasdaq ETFs: ${growthEtfPct.toFixed(1)}% (partial credit — overlaps large-cap tech)`);
    // Only half the credit of a broad fund, and a large position is itself a
    // concentrated bet on large-cap growth
    if (growthEtfPct >= 50) score -= 1;
    else if (growthEtfPct >= 25) score -= 0.5;
    if (growthEtfPct >= C.growthEtfConcentrated) score += 1;
  }
  if (rows.length > 0 && rows.length < C.minHoldingsForLow) {
    reasons.push(`Only ${rows.length} holding${rows.length === 1 ? '' : 's'}`);
    score += 1;
  }

  const level: ConcentrationLevel =
    score >= 5 ? 'VERY HIGH' : score >= 3 ? 'HIGH' : score >= 1 ? 'MODERATE' : 'LOW';

  return {
    level, reasons,
    largestPosition: pick(byWeight[0]),
    largestStock: ls,
    largestEtf: pick(etfs[0]),
    largestBroadEtf: pick(broadEtfs[0]),
    largestGrowthEtf: pick(growthEtfs[0]),
    top3StocksPct, top5Pct, largestSector, broadEtfPct, growthEtfPct,
    holdingsCount: rows.length,
  };
}

// ── rotation exposure ────────────────────────────────────────────────────────

export interface RotationExposure {
  value: number | null;
  classifiedPct: number;   // share of portfolio that could be scored
  label: string;
}

/**
 * Weighted average sector pressure across holdings that map to a real sector.
 * Diversified/specialty ETFs are excluded — their sector weights are unknown.
 */
export function computeRotationExposure(
  rows: EnrichedHolding[],
  sectors: Map<string, SectorMetrics>,
): RotationExposure {
  const total = rows.reduce((s, r) => s + r.marketValueCAD, 0);
  let weighted = 0, weight = 0;
  for (const r of rows) {
    if (!r.sectorEtf) continue;
    const m = sectors.get(r.sectorEtf);
    if (!m) continue;
    weighted += m.pressure * r.marketValueCAD;
    weight += r.marketValueCAD;
  }
  if (weight === 0) return { value: null, classifiedPct: 0, label: 'Unavailable' };
  const value = Math.round(weighted / weight);
  const label =
    value >= 22 ? 'Positive' : value > 5 ? 'Slightly Positive'
    : value >= -5 ? 'Neutral' : value > -22 ? 'Slightly Negative' : 'Negative';
  return { value, classifiedPct: total > 0 ? (weight / total) * 100 : 0, label };
}

// ── reconciliation diagnostics ───────────────────────────────────────────────

export interface Diagnostic { label: string; expected: number; actual: number; diff: number }

/** Consistency checks. Returns only material mismatches (> $1 or > 0.5pp). */
export function validateTotals(
  rows: EnrichedHolding[],
  totals: PortfolioTotals,
  allocation: AllocationRow[],
  accountTotals: Record<string, number>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (label: string, expected: number, actual: number, tol: number) => {
    const diff = actual - expected;
    if (Math.abs(diff) > tol) out.push({ label, expected, actual, diff });
  };

  push('Sum of holding market values vs Portfolio Value',
    totals.marketValueCAD, rows.reduce((s, r) => s + r.marketValueCAD, 0), 1);
  push('Sum of holding cost bases vs Cost Basis',
    totals.costBasisCAD, rows.reduce((s, r) => s + r.costBasisCAD, 0), 1);
  push('Account totals vs Portfolio Value',
    totals.marketValueCAD, Object.values(accountTotals).reduce((s, v) => s + v, 0), 1);
  push('Sector allocation total',
    totals.marketValueCAD, allocation.reduce((s, a) => s + a.valueCAD, 0), 1);
  push('Allocation weights total (%)',
    100, rows.reduce((s, r) => s + r.allocationPct, 0), 0.5);
  if (totals.dailyPnlCAD != null) {
    push('Sum of holding daily P&L vs portfolio daily P&L',
      totals.dailyPnlCAD, rows.reduce((s, r) => s + (r.dailyPnlCAD ?? 0), 0), 1);
  }
  return out;
}

/** Account → CAD market value. */
export function accountTotalsOf(rows: EnrichedHolding[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of rows) map[r.h.account] = (map[r.h.account] ?? 0) + r.marketValueCAD;
  return map;
}

export type { Currency };
