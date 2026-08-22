// ─────────────────────────────────────────────────────────────────────────────
// Watch List engine — pure calculations. No fetching, no UI.
// Derives Watch Status, Actionability Score, entry distance, stock/sector
// alignment and stale-watch reasons. Missing inputs are dropped from scoring
// and the remaining weights renormalized — never treated as zero.
// ─────────────────────────────────────────────────────────────────────────────

import {
  WATCH_THRESHOLDS, WATCH_RS_THRESHOLDS, ACTIONABILITY_WEIGHTS,
} from '../../config/watchConfig';
import type { WatchStatus, Alignment } from '../../config/watchConfig';
import type { WatchMeta } from './watchMeta';
import type { WatchItem } from '../../types';
import type { SectorMetrics } from '../sector/sectorEngine';
import type { StockReturns } from './watchSectorContext';

export interface WatchRow {
  item: WatchItem;
  meta: WatchMeta;
  market: 'US' | 'TSX';

  currentPrice: number | null;
  dayPct: number | null;
  sinceWatchPct: number | null;
  watchAgeDays: number;

  /** % current price sits above target entry (negative = below entry). */
  entryDistancePct: number | null;
  insideEntry: boolean | null;

  targetUpsidePct: number | null;

  sector: SectorMetrics | null;
  sectorEtf: string | null;
  stockReturns: StockReturns | null;
  /** stock 1M return minus sector ETF 1M return (decimal) */
  rsVsSector1M: number | null;
  alignment: Alignment | null;
  sectorShift: number | null;   // sector 5D pressure change when material

  status: WatchStatus;
  actionability: number;
  reviewReasons: string[];
  reviewDue: boolean;
  catalystDaysAway: number | null;
}

export function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export function daysUntil(dateStr: string | null | undefined): number | null {
  const d = daysSince(dateStr);
  return d == null ? null : -d;
}

export function getMarket(ticker: string): 'TSX' | 'US' {
  return /\.(TO|V|TSX|CN|NEO|VN)$/i.test(ticker) ? 'TSX' : 'US';
}

/** Weighted average that skips null components and renormalizes. */
function weighted(parts: Array<[number | null, number]>): number {
  let sum = 0, w = 0;
  for (const [v, wt] of parts) {
    if (v == null || !isFinite(v)) continue;
    sum += v * wt;
    w += wt;
  }
  return w > 0 ? sum / w : 50;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

function alignmentOf(sectorPressure: number | null, rs: number | null): Alignment | null {
  if (sectorPressure == null && rs == null) return null;
  const sectorUp = (sectorPressure ?? 0) > 0;
  const R = WATCH_RS_THRESHOLDS;
  if (rs == null) return sectorUp ? 'SECTOR TAILWIND' : null;
  if (sectorUp && rs >= R.outperform) return 'STRONG ALIGNMENT';
  if (sectorUp) return 'SECTOR TAILWIND';
  if (rs >= R.strongOutperform) return 'STOCK LEADER';
  if (rs <= R.underperform) return 'WEAK ALIGNMENT';
  return null;
}

export function buildWatchRow(args: {
  item: WatchItem;
  meta: WatchMeta;
  currentPrice: number | null;
  dayPct: number | null;
  sector: SectorMetrics | null;
  sectorEtf: string | null;
  stockReturns: StockReturns | null;
}): WatchRow {
  const { item, meta, currentPrice, dayPct, sector, sectorEtf, stockReturns } = args;
  const T = WATCH_THRESHOLDS;

  const watchAgeDays = daysSince(item.watch_date) ?? 0;

  const sinceWatchPct =
    currentPrice != null && item.watch_price
      ? ((currentPrice - item.watch_price) / item.watch_price) * 100
      : null;

  // Distance to entry: positive = above entry (further from buying)
  const entryDistancePct =
    currentPrice != null && item.target_entry
      ? ((currentPrice - item.target_entry) / item.target_entry) * 100
      : null;
  const insideEntry = entryDistancePct == null ? null : entryDistancePct <= 0;

  const targetUpsidePct =
    currentPrice != null && item.analyst_target && currentPrice > 0
      ? ((item.analyst_target - currentPrice) / currentPrice) * 100
      : null;

  const rsVsSector1M =
    stockReturns?.ret1M != null && sector?.ret['1M'] != null
      ? stockReturns.ret1M - sector.ret['1M']!
      : null;

  const sectorPressure = sector?.pressure ?? null;
  const alignment = alignmentOf(sectorPressure, rsVsSector1M);

  const sectorShift =
    sector?.pressureDelta.d5 != null && Math.abs(sector.pressureDelta.d5) >= T.sectorShiftDelta
      ? sector.pressureDelta.d5
      : null;

  const catalystDaysAway = daysUntil(meta.catalyst_date);
  const lastReviewedDays = daysSince(meta.last_reviewed);
  const daysSinceAttention = lastReviewedDays ?? watchAgeDays;
  const reviewDue = daysSinceAttention >= T.reviewDueDays;

  // ── stale / review reasons ────────────────────────────────────────────────
  const reviewReasons: string[] = [];
  if (watchAgeDays >= T.staleDays) reviewReasons.push(`Watched ${watchAgeDays} days`);
  if (catalystDaysAway != null && catalystDaysAway < 0) {
    reviewReasons.push(`Catalyst passed ${Math.abs(catalystDaysAway)}d ago${meta.catalyst ? ` (${meta.catalyst})` : ''}`);
  }
  if (entryDistancePct != null && entryDistancePct > T.extendedPct && watchAgeDays >= T.staleDays) {
    reviewReasons.push(`Never approached entry — ${entryDistancePct.toFixed(1)}% above`);
  }
  if (sectorShift != null && sectorShift < 0) {
    reviewReasons.push(`Sector rotation deteriorating (${sectorShift} over 5D)`);
  }
  if (lastReviewedDays != null && lastReviewedDays >= T.reviewDueDays) {
    reviewReasons.push(`Not reviewed in ${lastReviewedDays} days`);
  }

  // ── status ────────────────────────────────────────────────────────────────
  // Thesis broken is ONLY user-set — never inferred from price.
  let status: WatchStatus;
  if (meta.thesis_broken) {
    status = 'THESIS BROKEN';
  } else if (reviewReasons.length > 0 && !(insideEntry === true)) {
    status = 'REVIEW';
  } else if (insideEntry === true) {
    status = 'ACTIONABLE';
  } else if (entryDistancePct != null && entryDistancePct <= T.nearEntryPct) {
    status = 'NEAR ENTRY';
  } else if (catalystDaysAway != null && catalystDaysAway >= 0 && meta.trigger) {
    status = 'WAIT FOR CATALYST';
  } else if (entryDistancePct != null && entryDistancePct > T.extendedPct) {
    status = 'EXTENDED';
  } else {
    status = 'WATCH';
  }

  // ── actionability score ───────────────────────────────────────────────────
  const W = ACTIONABILITY_WEIGHTS;

  // Entry proximity: inside entry = 100, decaying to 0 by ~2× the extended band
  const proximity =
    entryDistancePct == null ? null
    : entryDistancePct <= 0 ? 100
    : clamp(100 - (entryDistancePct / (T.extendedPct * 2)) * 100);

  const convictionScore =
    item.conviction === 'HIGH' ? 100 : item.conviction === 'MEDIUM' ? 60 : 25;

  const pressureScore = sectorPressure == null ? null : clamp((sectorPressure + 100) / 2);

  const rsScore =
    rsVsSector1M == null ? null
    : clamp(50 + (rsVsSector1M / WATCH_RS_THRESHOLDS.strongOutperform) * 50);

  const catalystScore =
    catalystDaysAway == null ? null
    : catalystDaysAway < 0 ? 20
    : catalystDaysAway <= T.catalystSoonDays ? 100
    : 45;

  // Freshness: recently added/reviewed ideas rank above forgotten ones
  const freshness = clamp(100 - (daysSinceAttention / T.staleDays) * 100);

  let actionability = Math.round(weighted([
    [proximity, W.entryProximity],
    [convictionScore, W.conviction],
    [pressureScore, W.sectorPressure],
    [rsScore, W.stockRelStrength],
    [catalystScore, W.catalystSoon],
    [freshness, W.freshness],
  ]));

  // Status overrides: a broken thesis is never "actionable"; review sinks
  if (status === 'THESIS BROKEN') actionability = Math.min(actionability, 5);
  else if (status === 'REVIEW') actionability = Math.min(actionability, 45);
  else if (status === 'ACTIONABLE') actionability = Math.max(actionability, 75);

  return {
    item, meta, market: getMarket(item.ticker),
    currentPrice, dayPct, sinceWatchPct, watchAgeDays,
    entryDistancePct, insideEntry, targetUpsidePct,
    sector, sectorEtf, stockReturns, rsVsSector1M, alignment, sectorShift,
    status, actionability: clamp(actionability), reviewReasons, reviewDue, catalystDaysAway,
  };
}

/** Rows that need the user's attention today. */
export function needsAttention(r: WatchRow): boolean {
  return r.status === 'ACTIONABLE'
    || r.status === 'NEAR ENTRY'
    || r.status === 'REVIEW'
    || r.status === 'THESIS BROKEN'
    || (r.catalystDaysAway != null && r.catalystDaysAway >= 0 && r.catalystDaysAway <= WATCH_THRESHOLDS.catalystSoonDays)
    || r.sectorShift != null;
}

export interface WatchSummary {
  total: number;
  actionable: number;
  nearEntry: number;
  extended: number;
  review: number;
  sectorsImproving: number;
  attention: number;
}

export function summarize(rows: WatchRow[]): WatchSummary {
  const improvingSectors = new Set(
    rows.filter(r => r.sector && r.sector.pressure > 0).map(r => r.sectorEtf!)
  );
  return {
    total: rows.length,
    actionable: rows.filter(r => r.status === 'ACTIONABLE').length,
    nearEntry: rows.filter(r => r.status === 'NEAR ENTRY').length,
    extended: rows.filter(r => r.status === 'EXTENDED').length,
    review: rows.filter(r => r.status === 'REVIEW' || r.status === 'THESIS BROKEN').length,
    sectorsImproving: improvingSectors.size,
    attention: rows.filter(needsAttention).length,
  };
}
