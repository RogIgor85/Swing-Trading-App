// ─────────────────────────────────────────────────────────────────────────────
// Portfolio Review decision model. Pure calculations, no fetching, no UI.
//
// Two deliberately separate scores:
//   Company Quality (0–10) — the underlying business. Identical for every
//     account holding the same company. Price action is NOT an input.
//   Position Fit (0–10)   — this specific holding: size, combined exposure,
//     relative strength, trend, rotation, target distance.
//
// EXIT is never inferred from a drawdown. Losses raise review severity; only an
// explicit thesis-break marker produces EXIT.
// ─────────────────────────────────────────────────────────────────────────────

import {
  COMPANY_QUALITY_WEIGHTS, ETF_ROLE_WEIGHTS, POSITION_FIT_WEIGHTS,
  PORTFOLIO_HEALTH_WEIGHTS, EXPOSURE_THRESHOLDS, DRAWDOWN_THRESHOLDS,
  RELATIVE_STRENGTH_THRESHOLDS, FIT_BANDS,
} from '../../config/reviewConfig';
import type { ReviewStatus } from '../../config/reviewConfig';
import { ETF_REGISTRY, SECTOR_NAME_BY_ETF, DIVERSIFIED_LABEL, GROWTH_ETF_LABEL } from '../../config/portfolioConfig';
import type { PositionType } from '../../config/portfolioConfig';
import type { Holding, FinnhubMetrics } from '../../types';
import type { SectorMetrics } from '../sector/sectorEngine';

type Metric = FinnhubMetrics['metric'] | null;

export interface QualityComponent { label: string; display: string; score: number | null }

export interface CompanyQuality {
  score: number;                 // 0–10
  isEtf: boolean;
  kind: 'company' | 'etf';
  components: QualityComponent[];
  pros: string[];
  cons: string[];
  coverage: number;              // 0–1 share of weights with real data
}

export interface FitComponent { label: string; display: string; score: number }

export interface PositionReview {
  holding: Holding;
  ticker: string;
  base: string;
  companyName: string;
  account: string;
  currency: string;
  positionType: PositionType;
  isEtf: boolean;

  // shared across accounts holding the same underlying
  companyQuality: CompanyQuality;
  combinedExposurePct: number;
  siblingCount: number;

  // specific to this holding
  positionPct: number;
  positionFit: number;
  fitComponents: FitComponent[];
  status: ReviewStatus;
  flags: string[];
  pros: string[];
  cons: string[];
  action: string;

  // context
  sectorEtf: string | null;
  sectorLabel: string;
  sector: SectorMetrics | null;
  rsVsSector1M: number | null;
  ret1M: number | null;
  ret3M: number | null;

  currentPrice: number | null;
  pnlPct: number | null;
  marketValueNative: number;
  targetRemainingPct: number | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const clamp10 = (x: number) => Math.max(0, Math.min(10, x));

/** Map a value through ascending breakpoints to a 0–10 score. */
function band(v: number, points: Array<[number, number]>): number {
  // points: [threshold, score] ascending by threshold
  let score = points[0][1];
  for (const [t, s] of points) if (v >= t) score = s;
  return score;
}

/** Weighted mean that drops null components and renormalizes. */
function weighted(parts: Array<[number | null, number]>): { value: number; coverage: number } {
  let sum = 0, w = 0, total = 0;
  for (const [v, wt] of parts) {
    total += wt;
    if (v == null || !isFinite(v)) continue;
    sum += v * wt;
    w += wt;
  }
  return { value: w > 0 ? sum / w : 5, coverage: total > 0 ? w / total : 0 };
}

const pct1 = (x: number | null | undefined) =>
  x == null ? 'N/A' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
const pctDec = (x: number | null | undefined) =>
  x == null ? 'N/A' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

// ── Company Quality (business fundamentals only) ─────────────────────────────

export function computeCompanyQuality(m: Metric): CompanyQuality {
  const W = COMPANY_QUALITY_WEIGHTS;
  const components: QualityComponent[] = [];
  const pros: string[] = [];
  const cons: string[] = [];

  const revG = m?.revenueGrowth3Y ?? null;
  const epsG = m?.epsGrowth3Y ?? null;
  const gm   = m?.grossMarginTTM ?? null;
  const nm   = m?.netProfitMarginTTM ?? null;
  const roe  = m?.roeTTM ?? null;
  const de   = m?.debtEquityAnnual ?? null;
  const pe   = m?.peBasicExclExtraTTM ?? null;

  const sRev = revG == null ? null : band(revG, [[-100, 1], [-5, 3], [0, 5], [5, 6], [10, 7], [15, 8], [25, 9.5]]);
  const sEps = epsG == null ? null : band(epsG, [[-100, 1], [-5, 3], [0, 5], [8, 6.5], [15, 8], [25, 9.5]]);
  const sGm  = gm == null ? null : band(gm, [[0, 3], [20, 5], [35, 6.5], [50, 8], [65, 9.5]]);
  const sNm  = nm == null ? null : band(nm, [[-100, 1], [0, 4], [5, 5.5], [12, 7], [20, 8.5], [30, 9.5]]);
  const sRoe = roe == null ? null : band(roe, [[-100, 1], [0, 4], [8, 5.5], [15, 7], [25, 9], [40, 10]]);
  // Lower leverage scores higher
  const sLev = de == null ? null : band(-de, [[-5, 2], [-2, 4], [-1.2, 6], [-0.6, 7.5], [-0.3, 9]]);
  // Valuation: mild influence, negative earnings penalised modestly
  const sVal = pe == null ? null
    : pe < 0 ? 3
    : band(-pe, [[-90, 2.5], [-60, 4], [-40, 5.5], [-25, 6.5], [-15, 8], [-10, 9]]);

  components.push(
    { label: 'Revenue growth (3Y)', display: pct1(revG), score: sRev },
    { label: 'EPS growth (3Y)',     display: pct1(epsG), score: sEps },
    { label: 'Gross margin',        display: pct1(gm),   score: sGm },
    { label: 'Net margin',          display: pct1(nm),   score: sNm },
    { label: 'Return on equity',    display: pct1(roe),  score: sRoe },
    { label: 'Debt / equity',       display: de == null ? 'N/A' : de.toFixed(2), score: sLev },
    { label: 'P/E',                 display: pe == null ? 'N/A' : pe < 0 ? 'negative' : `${pe.toFixed(1)}x`, score: sVal },
  );

  const { value, coverage } = weighted([
    [sRev, W.revenueGrowth], [sEps, W.epsGrowth], [sGm, W.grossMargin],
    [sNm, W.netMargin], [sRoe, W.roe], [sLev, W.leverage], [sVal, W.valuation],
  ]);

  if (revG != null && revG > 15) pros.push(`Revenue growing ${revG.toFixed(1)}% (3-year CAGR)`);
  if (epsG != null && epsG > 15) pros.push(`Earnings growing ${epsG.toFixed(1)}% (3-year CAGR)`);
  if (gm != null && gm > 60)     pros.push(`Exceptional gross margin (${gm.toFixed(1)}%)`);
  if (roe != null && roe > 25)   pros.push(`High return on equity (${roe.toFixed(1)}%)`);
  if (de != null && de < 0.5)    pros.push(`Conservative balance sheet (D/E ${de.toFixed(2)})`);
  if (revG != null && revG < 0)  cons.push(`Revenue declining ${revG.toFixed(1)}% (3-year)`);
  if (epsG != null && epsG < 0)  cons.push(`Earnings declining ${epsG.toFixed(1)}% (3-year)`);
  if (nm != null && nm < 0)      cons.push(`Unprofitable on a net basis (${nm.toFixed(1)}% margin)`);
  if (de != null && de > 2)      cons.push(`High leverage (D/E ${de.toFixed(2)})`);
  if (pe != null && pe > 60)     cons.push(`Expensive valuation (P/E ${pe.toFixed(1)}x)`);

  return {
    score: clamp10(value), isEtf: false, kind: 'company',
    components, pros, cons, coverage,
  };
}

// ── ETF Quality / Portfolio Role (fundamentals do not apply) ─────────────────

export function computeEtfRole(ticker: string, overlapPct: number): CompanyQuality {
  const W = ETF_ROLE_WEIGHTS;
  const def = ETF_REGISTRY[ticker.toUpperCase()];
  const type: PositionType = def?.type ?? 'Other';
  const pros: string[] = [];
  const cons: string[] = [];

  let sDiv: number, sRole: number, sConc: number;
  const sLiq = 9; // all registry funds are large and liquid

  if (type === 'Broad-Market ETF') {
    sDiv = 9.5; sRole = 9.5; sConc = 9;
    pros.push('Broadly diversified across sectors and regions — suitable as a core holding');
    pros.push(`${def?.note ?? 'Index fund'} — single-stock risk is genuinely diluted`);
  } else if (type === 'Growth/Index ETF') {
    sDiv = 5.5; sRole = 6.5; sConc = 4.5;
    pros.push(`${def?.note ?? 'Index fund'} — rules-based exposure, no single-name selection risk`);
    cons.push('Concentrated in large-cap growth/technology — not a substitute for a broad-market fund');
    cons.push('Top holdings dominate performance; sector and style risk are meaningful');
    if (overlapPct > 0) {
      cons.push(`Overlaps roughly ${overlapPct.toFixed(0)}% of your direct holdings by name — true exposure is higher than the position size suggests`);
      sConc -= Math.min(2, overlapPct / 25);
    }
  } else if (type === 'Sector ETF') {
    sDiv = 4; sRole = 6; sConc = 4;
    pros.push('Removes single-stock risk within its sector');
    cons.push('Entire position rides one sector — a deliberate sector bet, not diversification');
  } else {
    sDiv = 5; sRole = 5.5; sConc = 5;
    cons.push('Specialty fund — review its mandate and concentration before sizing up');
  }

  const { value, coverage } = weighted([
    [sDiv, W.diversification], [sRole, W.portfolioRole],
    [clamp10(sConc), W.concentration], [sLiq, W.liquidity],
  ]);

  return {
    score: clamp10(value), isEtf: true, kind: 'etf',
    components: [
      { label: 'Diversification', display: type === 'Broad-Market ETF' ? 'Broad' : type === 'Growth/Index ETF' ? 'Concentrated (large-cap growth)' : 'Single sector', score: sDiv },
      { label: 'Portfolio role',  display: type === 'Broad-Market ETF' ? 'Core holding' : 'Satellite / tilt', score: sRole },
      { label: 'Internal concentration', display: overlapPct > 0 ? `${overlapPct.toFixed(0)}% name overlap with direct holdings` : 'No measured overlap', score: clamp10(sConc) },
      { label: 'Liquidity', display: 'High', score: sLiq },
    ],
    pros, cons, coverage,
  };
}

// ── Position Fit ─────────────────────────────────────────────────────────────

export interface PositionFitInput {
  companyQuality: number;
  rsVsSector1M: number | null;
  ret3M: number | null;
  positionPct: number;
  combinedExposurePct: number;
  sectorPressure: number | null;
  targetRemainingPct: number | null;
  isEtf: boolean;
  isBroadEtf: boolean;
}

export function computePositionFit(i: PositionFitInput): { score: number; components: FitComponent[] } {
  const W = POSITION_FIT_WEIGHTS;
  const E = EXPOSURE_THRESHOLDS;

  const sQuality = i.companyQuality;

  const sRs = i.rsVsSector1M == null ? null
    : band(i.rsVsSector1M, [[-1, 1.5], [-0.10, 3], [-0.05, 4], [-0.02, 5], [0.02, 6.5], [0.05, 8], [0.15, 9.5]]);

  const sTrend = i.ret3M == null ? null
    : band(i.ret3M, [[-1, 1.5], [-0.25, 3], [-0.10, 4.5], [0, 6], [0.10, 7.5], [0.25, 9]]);

  // Oversized single positions score lower; broad ETFs are exempt from the
  // penalty because size in a diversified core fund is not concentration.
  const sSize = i.isBroadEtf ? 9
    : band(-i.positionPct, [[-60, 1], [-35, 3], [-25, 4.5], [-18, 6], [-12, 7.5], [-6, 9]]);

  const sExposure = i.isBroadEtf ? 9
    : band(-i.combinedExposurePct, [
        [-60, 1], [-E.overweight - 10, 2.5], [-E.overweight, 4],
        [-E.high, 5.5], [-E.elevated, 7], [-5, 9],
      ]);

  const sRotation = i.sectorPressure == null ? null
    : band(i.sectorPressure, [[-100, 2], [-50, 3.5], [-22, 4.5], [-5, 5.5], [5, 6.5], [22, 8], [55, 9.5]]);

  // Room to target: more remaining upside scores higher; at/above target lower
  const sTarget = i.targetRemainingPct == null ? null
    : band(i.targetRemainingPct, [[-100, 3], [0, 4.5], [5, 5.5], [15, 7], [30, 8.5], [60, 9.5]]);

  const { value } = weighted([
    [sQuality, W.companyQuality],
    [sRs, W.relativeStrength],
    [sTrend, W.trendMomentum],
    [sSize, W.positionSize],
    [sExposure, W.combinedExposure],
    [sRotation, W.sectorRotation],
    [sTarget, W.targetValuation],
  ]);

  const components: FitComponent[] = [
    { label: 'Company quality',    display: sQuality.toFixed(1), score: sQuality },
    { label: 'Relative strength',  display: pctDec(i.rsVsSector1M), score: sRs ?? 5 },
    { label: 'Trend (3M)',         display: pctDec(i.ret3M), score: sTrend ?? 5 },
    { label: 'Position size',      display: `${i.positionPct.toFixed(1)}%`, score: sSize },
    { label: 'Combined exposure',  display: `${i.combinedExposurePct.toFixed(1)}%`, score: sExposure },
    { label: 'Sector rotation',    display: i.sectorPressure == null ? 'N/A' : `${i.sectorPressure >= 0 ? '+' : ''}${i.sectorPressure}`, score: sRotation ?? 5 },
    { label: 'Room to target',     display: i.targetRemainingPct == null ? 'no target' : `${i.targetRemainingPct.toFixed(1)}%`, score: sTarget ?? 5 },
  ];

  return { score: clamp10(value), components };
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface StatusInput {
  fit: number;
  quality: CompanyQuality;
  combinedExposurePct: number;
  pnlPct: number | null;
  rsVsSector1M: number | null;
  isEtf: boolean;
  isBroadEtf: boolean;
  thesisBroken: boolean;
}

export function deriveStatus(i: StatusInput): { status: ReviewStatus; flags: string[] } {
  const E = EXPOSURE_THRESHOLDS;
  const D = DRAWDOWN_THRESHOLDS;
  const flags: string[] = [];

  if (i.combinedExposurePct >= E.overweight && !i.isBroadEtf) flags.push('OVERWEIGHT');
  else if (i.combinedExposurePct >= E.high && !i.isBroadEtf) flags.push('HIGH EXPOSURE');

  // EXIT requires an explicit thesis break — never a drawdown alone.
  if (i.thesisBroken) return { status: 'EXIT', flags };

  // Broad-market funds are core holdings by construction.
  if (i.isBroadEtf) return { status: 'CORE', flags };

  const drawdown = i.pnlPct ?? 0;
  const severeDrawdown = drawdown <= D.review;
  const weakRs = (i.rsVsSector1M ?? 0) <= RELATIVE_STRENGTH_THRESHOLDS.weak;
  const weakBusiness = !i.quality.isEtf && i.quality.coverage > 0.4 && i.quality.score < 4.5;

  // A serious drawdown, or several deteriorating signals, means reassess —
  // NOT that the thesis is proven broken.
  if (severeDrawdown || (weakBusiness && weakRs) || (drawdown <= D.watch && weakBusiness)) {
    return { status: 'REVIEW', flags };
  }

  // Trim only when the position is both oversized AND performing poorly.
  if (i.combinedExposurePct >= E.overweight && i.fit < E.trimRequiresFitBelow) {
    return { status: 'TRIM', flags };
  }

  if (i.fit >= FIT_BANDS.strongHold) return { status: 'STRONG HOLD', flags };
  if (i.fit >= FIT_BANDS.hold)       return { status: 'HOLD', flags };
  if (i.fit >= FIT_BANDS.watch)      return { status: 'WATCH', flags };
  if (i.fit >= FIT_BANDS.trim)       return { status: 'TRIM', flags };
  return { status: 'REVIEW', flags };
}

// ── Suggested action language ────────────────────────────────────────────────

export function buildAction(r: {
  status: ReviewStatus;
  flags: string[];
  companyName: string;
  quality: CompanyQuality;
  combinedExposurePct: number;
  siblingCount: number;
  pnlPct: number | null;
  rsVsSector1M: number | null;
  sectorLabel: string;
  sectorPressure: number | null;
  isBroadEtf: boolean;
  isGrowthEtf: boolean;
}): string {
  const overweight = r.flags.includes('OVERWEIGHT');
  const elevated = r.flags.includes('HIGH EXPOSURE');
  const exposureNote = r.siblingCount > 1
    ? `combined ${r.companyName} exposure across accounts is ${r.combinedExposurePct.toFixed(1)}%`
    : `this position is ${r.combinedExposurePct.toFixed(1)}% of the portfolio`;

  switch (r.status) {
    case 'EXIT':
      return 'You marked this thesis as broken. Reassess whether to close the position and redeploy the capital.';

    case 'CORE':
      return r.isBroadEtf
        ? 'Diversified core holding. Maintain and keep contributing on schedule — position size here is by design, not concentration risk.'
        : 'Core holding. Maintain the position.';

    case 'STRONG HOLD':
      if (overweight) {
        return `Fundamentals and relative strength remain strong, but ${exposureNote}. Maintain the position and avoid adding unless that exposure falls back toward your target range.`;
      }
      if (elevated) {
        return `Strong on both the business and relative performance. Maintain; note that ${exposureNote}, so size any additions carefully.`;
      }
      return 'Fundamentals and relative strength both look strong. Maintain the position; there is room to add if you want more exposure.';

    case 'HOLD':
      if (overweight) {
        return `Reasonable holding, but ${exposureNote}. Maintain and avoid adding — monitor relative strength for signs of deterioration.`;
      }
      return r.isGrowthEtf
        ? 'Reasonable satellite position. Monitor its overlap with your direct holdings so total large-cap growth exposure stays where you want it.'
        : 'Reasonable position. Maintain and monitor trend and relative strength.';

    case 'WATCH': {
      const bits: string[] = [];
      if ((r.rsVsSector1M ?? 0) < 0) bits.push(`lagging ${r.sectorLabel}`);
      if ((r.sectorPressure ?? 0) <= -22) bits.push('sector rotation is negative');
      if ((r.pnlPct ?? 0) < 0) bits.push(`position is down ${Math.abs(r.pnlPct!).toFixed(1)}%`);
      const why = bits.length > 0 ? ` (${bits.join(', ')})` : '';
      return `Watch this one${why}. Monitor the trend and reassess after the next earnings report before changing the position.`;
    }

    case 'TRIM':
      return overweight
        ? `Company quality is acceptable, but ${exposureNote} and the position is not performing well enough to justify that size. Consider trimming toward your concentration target.`
        : 'Position fit has weakened. Consider trimming if it no longer earns its place, or set a level that would prompt a decision.';

    case 'REVIEW':
    default: {
      const bits: string[] = [];
      if ((r.pnlPct ?? 0) <= DRAWDOWN_THRESHOLDS.review) bits.push(`a ${Math.abs(r.pnlPct!).toFixed(1)}% drawdown`);
      if ((r.rsVsSector1M ?? 0) <= RELATIVE_STRENGTH_THRESHOLDS.weak) bits.push(`weak relative strength versus ${r.sectorLabel}`);
      if (!r.quality.isEtf && r.quality.score < 4.5 && r.quality.coverage > 0.4) bits.push('deteriorating fundamentals');
      const why = bits.length > 0 ? bits.join(' and ') : 'several weakening signals';
      return `${why.charAt(0).toUpperCase() + why.slice(1)} warrant a fresh look at your original thesis. This is a prompt to reassess, not evidence the thesis is broken — decide deliberately rather than on price alone.`;
    }
  }
}

// ── Portfolio Health ─────────────────────────────────────────────────────────

export interface HealthComponent { key: keyof typeof PORTFOLIO_HEALTH_WEIGHTS; label: string; score: number; weight: number; detail: string }

export interface PortfolioHealth {
  score: number;
  label: string;
  components: HealthComponent[];
}

export function computePortfolioHealth(args: {
  reviews: PositionReview[];
  largestCombinedExposurePct: number;
  distinctSectors: number;
  broadEtfPct: number;
  avgRs: number | null;
  avgSectorPressure: number | null;
  worstDrawdownPct: number | null;
}): PortfolioHealth | null {
  const { reviews } = args;
  if (reviews.length === 0) return null;
  const W = PORTFOLIO_HEALTH_WEIGHTS;

  const totalValue = reviews.reduce((s, r) => s + r.marketValueNative, 0) || 1;
  // Value-weighted position quality (Position Fit reflects both business and fit)
  const positionQuality = clamp10(
    reviews.reduce((s, r) => s + r.positionFit * r.marketValueNative, 0) / totalValue
  );

  const concentration = clamp10(band(-args.largestCombinedExposurePct, [
    [-70, 1], [-45, 2.5], [-30, 4], [-22, 5.2], [-15, 6.8], [-10, 8], [-6, 9.2],
  ]));

  const diversification = clamp10(
    band(args.distinctSectors, [[0, 2], [2, 4], [3, 5.5], [4, 6.5], [5, 7.5], [7, 8.5], [9, 9.5]])
    + (args.broadEtfPct >= 25 ? 1 : args.broadEtfPct >= 10 ? 0.5 : 0)
  );

  const trendMomentum = args.avgRs == null ? 5
    : clamp10(band(args.avgRs, [[-1, 2], [-0.10, 3.5], [-0.03, 4.5], [0.03, 6], [0.08, 7.5], [0.20, 9]]));

  const sectorAlignment = args.avgSectorPressure == null ? 5
    : clamp10(band(args.avgSectorPressure, [[-100, 2], [-50, 3.5], [-22, 4.5], [-5, 5.5], [5, 6.5], [22, 8], [55, 9.5]]));

  const drawdownRisk = args.worstDrawdownPct == null ? 6
    : clamp10(band(args.worstDrawdownPct, [[-100, 1.5], [-45, 3], [-30, 4.5], [-20, 6], [-10, 7.5], [0, 9]]));

  const components: HealthComponent[] = [
    { key: 'positionQuality', label: 'Average Position Quality', score: positionQuality, weight: W.positionQuality,
      detail: 'Value-weighted Position Fit across holdings' },
    { key: 'concentration', label: 'Concentration', score: concentration, weight: W.concentration,
      detail: `Largest combined underlying exposure ${args.largestCombinedExposurePct.toFixed(1)}%` },
    { key: 'diversification', label: 'Diversification', score: diversification, weight: W.diversification,
      detail: `${args.distinctSectors} sector${args.distinctSectors === 1 ? '' : 's'}, ${args.broadEtfPct.toFixed(0)}% in broad-market funds` },
    { key: 'trendMomentum', label: 'Momentum / Trend', score: trendMomentum, weight: W.trendMomentum,
      detail: args.avgRs == null ? 'Relative strength unavailable' : `Average relative strength ${pctDec(args.avgRs)} vs sector` },
    { key: 'sectorAlignment', label: 'Sector Rotation Alignment', score: sectorAlignment, weight: W.sectorAlignment,
      detail: args.avgSectorPressure == null ? 'Rotation data unavailable' : `Weighted sector pressure ${args.avgSectorPressure >= 0 ? '+' : ''}${args.avgSectorPressure.toFixed(0)}` },
    { key: 'drawdownRisk', label: 'Drawdown / Risk', score: drawdownRisk, weight: W.drawdownRisk,
      detail: args.worstDrawdownPct == null ? 'No drawdown data' : `Worst position ${args.worstDrawdownPct.toFixed(1)}%` },
  ];

  const totalW = components.reduce((s, c) => s + c.weight, 0);
  const score = components.reduce((s, c) => s + c.score * c.weight, 0) / totalW;

  const label =
    score >= 8 ? 'STRONG' : score >= 6.5 ? 'HEALTHY' : score >= 5 ? 'MIXED' : score >= 3.5 ? 'NEEDS ATTENTION' : 'AT RISK';

  return { score: clamp10(score), label, components };
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export function buildAlerts(reviews: PositionReview[], combinedExposure: Map<string, number>): string[] {
  const out: string[] = [];
  const count = (s: ReviewStatus) => reviews.filter(r => r.status === s).length;

  const review = count('REVIEW');
  const watch = count('WATCH');
  const trim = count('TRIM');
  const exit = count('EXIT');

  if (exit > 0)   out.push(`${exit} holding${exit > 1 ? 's' : ''} marked thesis-broken`);
  if (review > 0) out.push(`${review} holding${review > 1 ? 's' : ''} require high-priority review`);
  if (watch > 0)  out.push(`${watch} holding${watch > 1 ? 's' : ''} on watch`);
  if (trim > 0)   out.push(`${trim} holding${trim > 1 ? 's' : ''} suggest trimming`);

  const overweight = [...combinedExposure.entries()]
    .filter(([, pct]) => pct >= EXPOSURE_THRESHOLDS.overweight)
    .sort((a, b) => b[1] - a[1]);
  for (const [base, pct] of overweight.slice(0, 3)) {
    out.push(`${base} is overweight at ${pct.toFixed(1)}% combined exposure`);
  }

  return out;
}

// ── sector label helper (shared mapping, no local sector logic) ──────────────

export function sectorLabelFor(ticker: string, detectedEtf: string | null): { etf: string | null; label: string } {
  const def = ETF_REGISTRY[ticker.toUpperCase()];
  if (def) return { etf: def.sectorEtf ?? null, label: def.label };
  if (detectedEtf) return { etf: detectedEtf, label: SECTOR_NAME_BY_ETF[detectedEtf] ?? detectedEtf };
  return { etf: null, label: 'Unclassified' };
}

export function isBroadEtf(ticker: string): boolean {
  return ETF_REGISTRY[ticker.toUpperCase()]?.type === 'Broad-Market ETF';
}
export function isGrowthEtf(ticker: string): boolean {
  return ETF_REGISTRY[ticker.toUpperCase()]?.type === 'Growth/Index ETF';
}
export function positionTypeFor(ticker: string): PositionType {
  return ETF_REGISTRY[ticker.toUpperCase()]?.type ?? 'Individual Stock';
}

export { DIVERSIFIED_LABEL, GROWTH_ETF_LABEL };
export type { Holding };
