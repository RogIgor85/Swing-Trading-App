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
  COMPANY_QUALITY_WEIGHTS, ETF_QUALITY_WEIGHTS, ETF_POSITION_FIT_WEIGHTS,
  EXPENSE_BENCHMARKS, POSITION_FIT_WEIGHTS,
  PORTFOLIO_HEALTH_WEIGHTS, EXPOSURE_THRESHOLDS, DRAWDOWN_THRESHOLDS,
  RELATIVE_STRENGTH_THRESHOLDS, FIT_BANDS, MARKET_ALIGNMENT_WEIGHTS,
  HEALTH_BANDS, ALIGNMENT_BANDS, CONCENTRATION_BY_TYPE, HEALTH_COMPONENT_LABELS,
} from '../../config/reviewConfig';
import type { ReviewStatus } from '../../config/reviewConfig';
import { ETF_REGISTRY, SECTOR_NAME_BY_ETF, DIVERSIFIED_LABEL, GROWTH_ETF_LABEL } from '../../config/portfolioConfig';
import type { PositionType, EtfRole } from '../../config/portfolioConfig';
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
  /** CAD-converted market value — the ONLY basis for portfolio weighting. */
  marketValueCAD: number;
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

/**
 * ETF Quality — measures the PRODUCT only: does it deliver its own mandate
 * efficiently? Takes no portfolio input, so overlap with your other holdings
 * can never reduce it. Missing facts are dropped and weights renormalized.
 */
export function computeEtfQuality(ticker: string): CompanyQuality {
  const W = ETF_QUALITY_WEIGHTS;
  const def = ETF_REGISTRY[ticker.toUpperCase()];
  const type: PositionType = def?.type ?? 'Other';
  const pros: string[] = [];
  const cons: string[] = [];

  // Mandate / index quality — judged against the fund's OWN stated mandate
  const sMandate =
    type === 'Broad-Market ETF' ? 9.3
    : type === 'Growth/Index ETF' ? 8.8   // a major rules-based index is a sound mandate
    : type === 'Sector ETF' ? 8.2
    : 6.5;

  // Liquidity / fund stability
  const sLiquidity = def?.aumTier === 'mega' ? 9.6 : def?.aumTier === 'large' ? 9.0
    : def?.aumTier === 'mid' ? 7.8 : def?.aumTier === 'small' ? 6.0 : null;

  // Cost — compared to peers of the SAME type, not across types
  const bench = EXPENSE_BENCHMARKS[type as keyof typeof EXPENSE_BENCHMARKS] ?? EXPENSE_BENCHMARKS.Other;
  const er = def?.expenseRatio ?? null;
  const sCost = er == null ? null
    : er <= bench.excellent ? 9.5
    : er <= bench.good ? 8.0
    : er <= bench.fair ? 6.0
    : 4.0;

  // Tracking / implementation — plain index replication tracks well
  const sTracking = def?.indexName ? (type === 'Broad-Market ETF' ? 8.8 : 8.5) : null;

  // Diversification WITHIN the mandate (100 names is broad for a Nasdaq-100 fund)
  const n = def?.holdingsCount ?? null;
  const sDivInMandate = n == null ? null
    : type === 'Broad-Market ETF'
      ? (n >= 3000 ? 9.5 : n >= 1000 ? 9.0 : n >= 500 ? 8.2 : 7.0)
      : (n >= 200 ? 8.8 : n >= 100 ? 8.2 : n >= 50 ? 7.2 : 5.5);

  const sIssuer = def?.issuer ? 9.0 : null;

  const { value, coverage } = weighted([
    [sMandate, W.mandateQuality],
    [sLiquidity, W.liquidityStability],
    [sCost, W.cost],
    [sTracking, W.tracking],
    [sDivInMandate, W.diversificationInMandate],
    [sIssuer, W.issuerStructure],
  ]);

  if (type === 'Broad-Market ETF') {
    pros.push(`${def?.note ?? 'Index fund'} — broad diversification across sectors and regions`);
  } else if (type === 'Growth/Index ETF') {
    pros.push(`Tracks ${def?.indexName ?? 'a major index'} — rules-based, no single-name selection risk`);
    pros.push(`${n ?? 'Many'} holdings within its mandate; concentration in mega-cap growth is the exposure it is designed to provide`);
  } else if (type === 'Sector ETF') {
    pros.push(`Tracks ${def?.indexName ?? 'its sector index'} — removes single-stock risk within the sector`);
  }
  if (er != null && er <= bench.good) pros.push(`Low cost for its category (MER ${er.toFixed(2)}%)`);
  if (er != null && er > bench.fair) cons.push(`Expensive for its category (MER ${er.toFixed(2)}%)`);
  if (def?.aumTier === 'small') cons.push('Smaller fund — check liquidity and spreads before sizing up');

  return {
    score: clamp10(value), isEtf: true, kind: 'etf',
    components: [
      { label: 'Mandate / index quality', display: def?.indexName ?? type, score: sMandate },
      { label: 'Liquidity / stability',   display: def?.aumTier ? `${def.aumTier} fund` : 'N/A', score: sLiquidity },
      { label: 'Cost (vs category)',      display: er == null ? 'N/A' : `MER ${er.toFixed(2)}%`, score: sCost },
      { label: 'Tracking / implementation', display: def?.indexName ? 'Physical index replication' : 'N/A', score: sTracking },
      { label: 'Diversification in mandate', display: n == null ? 'N/A' : `${n.toLocaleString()} holdings`, score: sDivInMandate },
      { label: 'Issuer / structure',      display: def?.issuer ?? 'N/A', score: sIssuer },
    ],
    pros, cons, coverage,
  };
}

/** Role label used to explain Position Fit for a fund. */
export function etfRoleOf(ticker: string): EtfRole | null {
  const def = ETF_REGISTRY[ticker.toUpperCase()];
  if (!def) return null;
  if (def.role) return def.role;
  return def.type === 'Broad-Market ETF' ? 'CORE' : def.type === 'Sector ETF' ? 'SECTOR' : 'SATELLITE';
}

/**
 * Real overlap: the share of the fund's index weight sitting in names you also
 * hold directly. A Position Fit input only — never an ETF Quality input.
 */
export function computeEtfOverlap(ticker: string, directlyHeldBases: Set<string>): number | null {
  const def = ETF_REGISTRY[ticker.toUpperCase()];
  if (!def?.topHoldings) return null;
  return def.topHoldings
    .filter(([sym]) => directlyHeldBases.has(sym.toUpperCase()))
    .reduce((s, [, w]) => s + w, 0);
}

export interface EtfFitInput {
  ticker: string;
  overlapPct: number | null;
  positionPct: number;
  /** portfolio weight of the style/sector the fund concentrates in */
  styleExposurePct: number | null;
  correlation: number | null;
  ret3M: number | null;
  sectorPressure: number | null;
}

export function computeEtfPositionFit(i: EtfFitInput): { score: number; components: FitComponent[] } {
  const W = ETF_POSITION_FIT_WEIGHTS;
  const role = etfRoleOf(i.ticker);
  const type = positionTypeFor(i.ticker);

  // A core fund earns its place structurally; a satellite must justify its size
  const sRole = role === 'CORE' ? 9.3 : role === 'SATELLITE' ? 7.0 : role === 'SECTOR' ? 6.0 : 5.5;

  const sOverlap = i.overlapPct == null ? null
    : band(-i.overlapPct, [[-80, 2], [-60, 3], [-45, 4], [-30, 5.5], [-20, 6.8], [-10, 8], [-3, 9.3]]);

  // Core funds are meant to be large; satellites are not
  const sSize = type === 'Broad-Market ETF'
    ? band(-i.positionPct, [[-90, 5], [-75, 7], [-60, 8.5], [-45, 9.3], [-20, 9]])
    : band(-i.positionPct, [[-50, 1.5], [-35, 3], [-25, 4.5], [-18, 6], [-12, 7.5], [-6, 9]]);

  const sStyle = i.styleExposurePct == null ? null
    : band(-i.styleExposurePct, [[-80, 1.5], [-60, 3], [-45, 4.5], [-35, 6], [-25, 7.5], [-15, 9]]);

  const sCorr = i.correlation == null ? null
    : band(-i.correlation, [[-1, 2], [-0.9, 3.5], [-0.8, 5], [-0.65, 6.5], [-0.5, 8], [-0.3, 9]]);

  const sTrend = i.ret3M == null ? null
    : band(i.ret3M, [[-1, 2], [-0.25, 3.5], [-0.10, 5], [0, 6], [0.10, 7.5], [0.25, 9]]);

  const sAlign = i.sectorPressure == null ? null
    : band(i.sectorPressure, [[-100, 2.5], [-50, 4], [-22, 5], [-5, 5.5], [5, 6.5], [22, 8], [55, 9]]);

  const { value } = weighted([
    [sRole, W.portfolioRole], [sOverlap, W.overlap], [sSize, W.positionSize],
    [sStyle, W.styleConcentration], [sCorr, W.correlation],
    [sTrend, W.trend], [sAlign, W.marketAlignment],
  ]);

  return {
    score: clamp10(value),
    components: [
      { label: 'Portfolio role',      display: role ?? 'n/a', score: sRole },
      { label: 'Overlap with holdings', display: i.overlapPct == null ? 'N/A' : `${i.overlapPct.toFixed(0)}% of index weight`, score: sOverlap ?? 5 },
      { label: 'Position size',       display: `${i.positionPct.toFixed(1)}%`, score: sSize },
      { label: 'Style concentration', display: i.styleExposurePct == null ? 'N/A' : `${i.styleExposurePct.toFixed(1)}% portfolio`, score: sStyle ?? 5 },
      { label: 'Correlation',         display: i.correlation == null ? 'N/A' : i.correlation.toFixed(2), score: sCorr ?? 5 },
      { label: 'Trend (3M)',          display: pctDec(i.ret3M), score: sTrend ?? 5 },
      { label: 'Market alignment',    display: i.sectorPressure == null ? 'N/A' : `${i.sectorPressure >= 0 ? '+' : ''}${i.sectorPressure}`, score: sAlign ?? 5 },
    ],
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

  // Non-broad funds: a small drawdown is market noise, not a fund problem.
  // Status follows portfolio-level reasons (overlap, size, sustained trend),
  // never a modest negative P&L.
  if (i.isEtf) {
    const etfDrawdown = i.pnlPct ?? 0;
    const materialDecline = etfDrawdown <= DRAWDOWN_THRESHOLDS.review;
    if (i.fit >= FIT_BANDS.strongHold) return { status: 'STRONG HOLD', flags };
    if (i.fit >= FIT_BANDS.hold)       return { status: 'HOLD', flags };
    if (i.fit >= FIT_BANDS.watch)      return { status: materialDecline ? 'WATCH' : 'HOLD', flags };
    return { status: materialDecline ? 'REVIEW' : 'WATCH', flags };
  }

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
  overlapPct?: number | null;
}): string {
  const overweight = r.flags.includes('OVERWEIGHT');
  const elevated = r.flags.includes('HIGH EXPOSURE');
  const exposureNote = r.siblingCount > 1
    ? `combined ${r.companyName} exposure across accounts is ${r.combinedExposurePct.toFixed(1)}%`
    : `this position is ${r.combinedExposurePct.toFixed(1)}% of the portfolio`;

  // ── ETF-specific language. Funds have no earnings report, so none of the
  // company phrasing below applies to them. ──────────────────────────────────
  if (r.isBroadEtf) {
    return r.status === 'REVIEW'
      ? 'Diversified core holding in a drawdown. Broad funds are expected to fall with the market — stay with your allocation plan unless your objectives or time horizon have changed.'
      : 'Diversified core holding. Continue according to your portfolio plan unless the intended asset allocation changes.';
  }
  if (r.isGrowthEtf || r.quality.isEtf) {
    const overlapNote = r.overlapPct != null && r.overlapPct >= 25
      ? ` It overlaps roughly ${r.overlapPct.toFixed(0)}% of its index weight with names you already hold directly, so your true exposure to those companies is higher than the position size suggests.`
      : '';
    if (r.status === 'REVIEW') {
      return `Fund quality is intact; the concern is portfolio-level.${overlapNote} Reassess how much of this style exposure you want rather than reacting to the drawdown.`;
    }
    if (r.status === 'WATCH' || r.status === 'TRIM') {
      return `High-quality index exposure, but the fit in this portfolio is only moderate.${overlapNote} Maintain if the growth tilt is intentional; avoid increasing the position solely because of short-term weakness.`;
    }
    return `High-quality index exposure delivering its stated mandate.${overlapNote} Maintain as a satellite position sized to the tilt you actually want.`;
  }

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

// ── Single routing entry point ───────────────────────────────────────────────
// The ONLY supported way to review a holding. Callers cannot pick a scorer, so
// an ETF can never fall through to company logic. Every branch is reported in
// `routing` and logged in dev.

export type SecurityKind = 'stock' | 'etf';

export interface RoutingInfo {
  ticker: string;
  securityType: SecurityKind;
  etfType: PositionType | null;
  etfRole: EtfRole | null;
  qualityScorer: 'etfQualityScorer' | 'companyQualityScorer';
  positionFitScorer: 'etfPositionFitScorer' | 'stockPositionFitScorer';
  statusLogic: 'etfStatusService' | 'stockStatusService';
  actionGenerator: 'etfActionService' | 'stockActionService';
}

export interface ReviewHoldingInput {
  ticker: string;
  companyName: string;
  /** Company fundamentals — ignored entirely for ETFs. */
  metrics: Metric;
  positionPct: number;
  combinedExposurePct: number;
  siblingCount: number;
  pnlPct: number | null;
  rsVsSector1M: number | null;
  ret3M: number | null;
  sectorLabel: string;
  sectorPressure: number | null;
  targetRemainingPct: number | null;
  thesisBroken: boolean;
  /** ETF-only inputs; ignored for stocks. */
  directlyHeldBases?: Set<string>;
  styleExposurePct?: number | null;
  correlation?: number | null;
}

export interface ReviewHoldingResult {
  quality: CompanyQuality;
  fit: { score: number; components: FitComponent[] };
  status: ReviewStatus;
  flags: string[];
  action: string;
  overlapPct: number | null;
  routing: RoutingInfo;
}

export function reviewHolding(i: ReviewHoldingInput): ReviewHoldingResult {
  const type = positionTypeFor(i.ticker);
  const isEtfHolding = type !== 'Individual Stock';
  const broad = isBroadEtf(i.ticker);
  const growth = isGrowthEtf(i.ticker);

  const routing: RoutingInfo = {
    ticker: i.ticker,
    securityType: isEtfHolding ? 'etf' : 'stock',
    etfType: isEtfHolding ? type : null,
    etfRole: isEtfHolding ? etfRoleOf(i.ticker) : null,
    qualityScorer: isEtfHolding ? 'etfQualityScorer' : 'companyQualityScorer',
    positionFitScorer: isEtfHolding ? 'etfPositionFitScorer' : 'stockPositionFitScorer',
    statusLogic: isEtfHolding ? 'etfStatusService' : 'stockStatusService',
    actionGenerator: isEtfHolding ? 'etfActionService' : 'stockActionService',
  };

  let quality: CompanyQuality;
  let fit: { score: number; components: FitComponent[] };
  let overlapPct: number | null = null;

  if (isEtfHolding) {
    // Product quality only — company fundamentals are never consulted
    quality = computeEtfQuality(i.ticker);
    overlapPct = i.directlyHeldBases ? computeEtfOverlap(i.ticker, i.directlyHeldBases) : null;
    fit = computeEtfPositionFit({
      ticker: i.ticker,
      overlapPct,
      positionPct: i.positionPct,
      styleExposurePct: i.styleExposurePct ?? null,
      correlation: i.correlation ?? null,
      ret3M: i.ret3M,
      sectorPressure: i.sectorPressure,
    });
  } else {
    quality = computeCompanyQuality(i.metrics);
    fit = computePositionFit({
      companyQuality: quality.score,
      rsVsSector1M: i.rsVsSector1M,
      ret3M: i.ret3M,
      positionPct: i.positionPct,
      combinedExposurePct: i.combinedExposurePct,
      sectorPressure: i.sectorPressure,
      targetRemainingPct: i.targetRemainingPct,
      isEtf: false, isBroadEtf: false,
    });
  }

  const { status, flags } = deriveStatus({
    fit: fit.score, quality,
    combinedExposurePct: i.combinedExposurePct,
    pnlPct: i.pnlPct, rsVsSector1M: i.rsVsSector1M,
    isEtf: isEtfHolding, isBroadEtf: broad,
    thesisBroken: i.thesisBroken,
  });

  const action = buildAction({
    status, flags, companyName: i.companyName, quality,
    combinedExposurePct: i.combinedExposurePct, siblingCount: i.siblingCount,
    pnlPct: i.pnlPct, rsVsSector1M: i.rsVsSector1M,
    sectorLabel: i.sectorLabel, sectorPressure: i.sectorPressure,
    isBroadEtf: broad, isGrowthEtf: growth, overlapPct,
  });

  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(
      `[review routing] ${routing.ticker} · ${routing.securityType}` +
      `${routing.etfType ? ` (${routing.etfType}, role ${routing.etfRole})` : ''}` +
      ` → quality=${routing.qualityScorer} fit=${routing.positionFitScorer}` +
      ` status=${routing.statusLogic} action=${routing.actionGenerator}` +
      ` | quality ${quality.score.toFixed(2)} fit ${fit.score.toFixed(2)} status ${status}` +
      `${overlapPct != null ? ` overlap ${overlapPct.toFixed(1)}%` : ''}`
    );
  }

  return { quality, fit, status, flags, action, overlapPct, routing };
}

/** Observations for a holding, routed the same way as its scoring. */
export function buildObservations(
  r: ReviewHoldingResult,
  ctx: { sectorLabel: string; rsVsSector1M: number | null; pnlPct: number | null; combinedExposurePct: number; sectorPressure: number | null },
): { pros: string[]; cons: string[] } {
  const pros = [...r.quality.pros];
  const cons = [...r.quality.cons];
  const isEtfHolding = r.routing.securityType === 'etf';

  if (isEtfHolding) {
    // Portfolio-fit concerns — explicitly NOT product-quality concerns
    if (r.overlapPct != null && r.overlapPct >= 20) {
      cons.push(`Overlaps ~${r.overlapPct.toFixed(0)}% of its index weight with names you hold directly — a portfolio fit concern, not a fund quality issue`);
    }
    if (r.routing.etfType === 'Growth/Index ETF') {
      cons.push('Adds to existing growth / mega-cap concentration rather than diversifying it');
    }
  } else {
    if (ctx.rsVsSector1M != null && ctx.rsVsSector1M > 0.05) pros.push(`Outperforming ${ctx.sectorLabel} by ${pctDec(ctx.rsVsSector1M)} over 1M`);
    if (ctx.rsVsSector1M != null && ctx.rsVsSector1M < -0.05) cons.push(`Lagging ${ctx.sectorLabel} by ${pctDec(Math.abs(ctx.rsVsSector1M))} over 1M`);
    if (ctx.pnlPct != null && ctx.pnlPct >= 25) pros.push(`Up ${ctx.pnlPct.toFixed(1)}% in this account`);
    if (ctx.pnlPct != null && ctx.pnlPct <= -20) cons.push(`Down ${Math.abs(ctx.pnlPct).toFixed(1)}% in this account`);
    if (ctx.combinedExposurePct >= EXPOSURE_THRESHOLDS.overweight) {
      cons.push(`Combined exposure across accounts is ${ctx.combinedExposurePct.toFixed(1)}% of the portfolio`);
    }
  }
  if (ctx.sectorPressure != null && ctx.sectorPressure <= -22) cons.push(`${ctx.sectorLabel} rotation pressure ${ctx.sectorPressure}`);
  if (ctx.sectorPressure != null && ctx.sectorPressure >= 22) pros.push(`${ctx.sectorLabel} rotation pressure +${ctx.sectorPressure}`);
  return { pros, cons };
}

// ── Portfolio Health ─────────────────────────────────────────────────────────

export interface HealthComponent { key: keyof typeof PORTFOLIO_HEALTH_WEIGHTS; label: string; score: number; weight: number; detail: string }

export interface PortfolioHealth {
  /** Rounded to 1dp — the label is derived from this same value. */
  score: number;
  label: string;
  components: HealthComponent[];
  risks: string[];
  positives: string[];
  /** Concentration sub-scores, each measuring a distinct (non-overlapping) risk. */
  penalties: Array<{ factor: string; basis: string; score: number; weight: number }>;
}

export interface MarketAlignment {
  score: number;
  label: string;
  components: Array<{ label: string; score: number; weight: number; detail: string }>;
  notes: string[];
}

function labelFor(score: number, bands: Array<[number, string]>): string {
  for (const [t, l] of bands) if (score >= t) return l;
  return bands[bands.length - 1][1];
}

/** Concentration tolerance for a holding, by what it actually is. */
function concentrationTier(ticker: string) {
  const type = positionTypeFor(ticker);
  if (type === 'Broad-Market ETF') return CONCENTRATION_BY_TYPE.broadEtf;
  if (type === 'Growth/Index ETF') return CONCENTRATION_BY_TYPE.growthEtf;
  if (type === 'Sector ETF')       return CONCENTRATION_BY_TYPE.sectorEtf;
  return CONCENTRATION_BY_TYPE.stock;
}

/** True when combined exposure to this underlying is genuinely overweight. */
export function isOverweightExposure(ticker: string, combinedPct: number): boolean {
  return combinedPct >= concentrationTier(ticker).excessive;
}

export interface HealthInput {
  reviews: PositionReview[];
  /** base ticker → combined % of portfolio */
  combinedExposure: Map<string, number>;
  /** base ticker → a representative ticker (for type lookup) */
  representativeTicker: Map<string, string>;
  /** sector label → % of portfolio (diversified funds excluded) */
  sectorTotals: Map<string, number>;
  broadEtfPct: number;
  growthEtfPct: number;
  avgRs: number | null;
  avgSectorPressure: number | null;
}

export function computePortfolioHealth(a: HealthInput): PortfolioHealth | null {
  const { reviews } = a;
  if (reviews.length === 0) return null;
  const W = PORTFOLIO_HEALTH_WEIGHTS;
  // Weighting is strictly by CAD value so USD and CAD holdings are comparable
  const totalValue = reviews.reduce((s, r) => s + r.marketValueCAD, 0) || 1;
  const wt = (r: PositionReview) => r.marketValueCAD / totalValue;
  const distinctSectors = a.sectorTotals.size;
  const largestSectorPct = Math.max(0, ...a.sectorTotals.values());

  const risks: string[] = [];
  const positives: string[] = [];

  // ── Asset Quality (35%) — value-weighted business / fund quality ─────────
  const assetQuality = clamp10(reviews.reduce((s, r) => s + r.companyQuality.score * wt(r), 0));

  // ── Position Fit (20%) — value-weighted ──────────────────────────────────
  const positionFit = clamp10(reviews.reduce((s, r) => s + r.positionFit * wt(r), 0));

  // ── Diversification (20%) ────────────────────────────────────────────────
  const uniqueUnderlying = a.combinedExposure.size;
  let diversification =
    band(distinctSectors, [[0, 3], [2, 4.5], [3, 5.5], [4, 6.5], [5, 7.3], [7, 8.2], [9, 9]]) * 0.45
    + band(uniqueUnderlying, [[0, 3], [3, 4.5], [5, 6], [8, 7.5], [12, 8.5], [18, 9.5]]) * 0.25
    + band(-largestSectorPct, [[-80, 2], [-55, 4], [-40, 5.5], [-30, 7], [-22, 8.2], [-15, 9]]) * 0.30;
  // Broad diversified funds genuinely improve diversification
  const broadBonus = a.broadEtfPct >= 40 ? 1.5 : a.broadEtfPct >= 25 ? 1.1 : a.broadEtfPct >= 10 ? 0.6 : 0;
  diversification = clamp10(diversification + broadBonus);
  if (a.broadEtfPct >= 10) {
    positives.push(`${a.broadEtfPct.toFixed(1)}% held in broad diversified core funds`);
  }

  // ── Concentration (15%) — type-aware, counted ONCE per underlying ────────
  // Broad funds are excluded: a large core-ETF weight is design, not risk.
  const stockExposures: Array<[string, number]> = [];
  for (const [base, pct] of a.combinedExposure) {
    const ticker = a.representativeTicker.get(base) ?? base;
    if (positionTypeFor(ticker) === 'Broad-Market ETF') continue;
    stockExposures.push([base, pct]);
  }
  stockExposures.sort((x, y) => y[1] - x[1]);

  const largestStock = stockExposures[0] ?? null;
  const largestStockPct = largestStock?.[1] ?? 0;

  // Each sub-score measures a DISTINCT risk. The largest single name is scored
  // once, then excluded from the breadth and sector terms so the same exposure
  // is not penalised three times.
  const next2Pct = stockExposures.slice(1, 3).reduce((s, [, p]) => s + p, 0);

  // Sector concentration BEYOND the single name already penalised above
  let largestSectorLabel: string | null = null;
  for (const [label, pct] of a.sectorTotals) {
    if (pct === largestSectorPct) { largestSectorLabel = label; break; }
  }
  const largestStockSector = largestStock
    ? reviews.find(r => r.base === largestStock[0])?.sectorLabel ?? null
    : null;
  const sectorExLargest = largestSectorLabel != null && largestStockSector === largestSectorLabel
    ? Math.max(0, largestSectorPct - largestStockPct)
    : largestSectorPct;

  const T = CONCENTRATION_BY_TYPE.stock;
  const sLargest = band(-largestStockPct, [[-60, 1], [-40, 2.5], [-T.excessive - 5, 4], [-T.excessive, 5], [-T.high, 6.5], [-T.elevated, 8], [-5, 9.5]]);
  const sNext2   = band(-next2Pct, [[-60, 1.5], [-45, 3], [-32, 4.5], [-24, 6], [-16, 7.5], [-8, 9]]);
  const sSector  = band(-sectorExLargest, [[-60, 1.5], [-45, 3], [-35, 4.5], [-25, 6], [-18, 7.5], [-10, 9]]);
  const sGrowth  = band(-a.growthEtfPct, [[-60, 3], [-40, 4.5], [-25, 6], [-15, 7.5], [-5, 9]]);
  const concentration = clamp10(sLargest * 0.40 + sNext2 * 0.25 + sSector * 0.20 + sGrowth * 0.15);

  const penalties: Array<{ factor: string; basis: string; score: number; weight: number }> = [
    { factor: 'Largest single company', basis: largestStock ? `${largestStock[0]} ${largestStockPct.toFixed(1)}%` : 'none', score: sLargest, weight: 40 },
    { factor: 'Next two companies',     basis: `${next2Pct.toFixed(1)}% (largest excluded)`, score: sNext2, weight: 25 },
    { factor: 'Sector beyond top name', basis: `${largestSectorLabel ?? 'n/a'} ${sectorExLargest.toFixed(1)}%`, score: sSector, weight: 20 },
    { factor: 'Growth/Nasdaq overlap',  basis: `${a.growthEtfPct.toFixed(1)}%`, score: sGrowth, weight: 15 },
  ];

  if (largestStockPct >= T.excessive && largestStock) {
    risks.push(`${largestStock[0]} combined exposure ${largestStockPct.toFixed(1)}% — overweight for a single company`);
  } else if (largestStockPct >= T.high && largestStock) {
    risks.push(`${largestStock[0]} combined exposure ${largestStockPct.toFixed(1)}% — high for a single company`);
  }
  if (sectorExLargest >= 25 && largestSectorLabel) {
    risks.push(`${largestSectorLabel} exposure ${sectorExLargest.toFixed(1)}% beyond the largest holding`);
  }
  if (a.growthEtfPct >= CONCENTRATION_BY_TYPE.growthEtf.high) {
    risks.push(`Growth / Nasdaq funds ${a.growthEtfPct.toFixed(1)}% — overlaps directly held large-cap names`);
  }
  if (assetQuality >= 7.5) positives.push(`High weighted asset quality (${assetQuality.toFixed(1)}/10)`);
  if (positionFit >= 6.5) positives.push(`Most capital sits in positions with sound fit (${positionFit.toFixed(1)}/10)`);

  // Value-weighted drag from holdings needing attention — a 4% REVIEW must not
  // weigh the same as a 30% one.
  const attentionWeight = reviews
    .filter(r => r.status === 'REVIEW' || r.status === 'EXIT')
    .reduce((s, r) => s + wt(r), 0) * 100;
  if (attentionWeight >= 5) {
    risks.push(`${attentionWeight.toFixed(1)}% of portfolio value in holdings needing review`);
  }

  // ── Tactical (10% combined) ──────────────────────────────────────────────
  const trendStrength = a.avgRs == null ? 5
    : clamp10(band(a.avgRs, [[-1, 2], [-0.10, 3.5], [-0.03, 4.5], [0.03, 6], [0.08, 7.5], [0.20, 9]]));
  const sectorAlignment = a.avgSectorPressure == null ? 5
    : clamp10(band(a.avgSectorPressure, [[-100, 2], [-50, 3.5], [-22, 4.5], [-5, 5.5], [5, 6.5], [22, 8], [55, 9.5]]));
  if (a.avgRs != null && a.avgRs > 0.03) positives.push(`Holdings are outperforming their sectors on average (${pctDec(a.avgRs)})`);

  const components: HealthComponent[] = [
    { key: 'assetQuality', label: HEALTH_COMPONENT_LABELS.assetQuality, score: assetQuality, weight: W.assetQuality,
      detail: 'Value-weighted company and ETF quality' },
    { key: 'positionFit', label: HEALTH_COMPONENT_LABELS.positionFit, score: positionFit, weight: W.positionFit,
      detail: 'Value-weighted Position Fit' },
    { key: 'diversification', label: HEALTH_COMPONENT_LABELS.diversification, score: diversification, weight: W.diversification,
      detail: `${distinctSectors} sectors · ${uniqueUnderlying} underlyings · ${a.broadEtfPct.toFixed(0)}% broad funds` },
    { key: 'concentration', label: HEALTH_COMPONENT_LABELS.concentration, score: concentration, weight: W.concentration,
      detail: largestStock
        ? `${largestStock[0]} ${largestStockPct.toFixed(1)}% · next two ${next2Pct.toFixed(1)}% · broad funds excluded`
        : 'No individual-company concentration' },
    { key: 'trendStrength', label: HEALTH_COMPONENT_LABELS.trendStrength, score: trendStrength, weight: W.trendStrength,
      detail: a.avgRs == null ? 'Relative strength unavailable' : `Average relative strength ${pctDec(a.avgRs)} vs sector` },
    { key: 'sectorAlignment', label: HEALTH_COMPONENT_LABELS.sectorAlignment, score: sectorAlignment, weight: W.sectorAlignment,
      detail: a.avgSectorPressure == null ? 'Rotation data unavailable' : `Weighted sector pressure ${a.avgSectorPressure >= 0 ? '+' : ''}${a.avgSectorPressure.toFixed(0)}` },
  ];

  const totalW = components.reduce((s, c) => s + c.weight, 0);
  const raw = clamp10(components.reduce((s, c) => s + c.score * c.weight, 0) / totalW);
  // Standard mathematical rounding to 1dp. The LABEL is derived from the same
  // rounded value the user sees, so display and label can never disagree.
  const score = Math.round(raw * 10) / 10;

  if (import.meta.env?.DEV) {
    /* eslint-disable no-console */
    console.groupCollapsed(`[Portfolio Health] ${score.toFixed(1)} — ${labelFor(score, HEALTH_BANDS)} (raw ${raw.toFixed(4)})`);
    console.table(components.map(c => ({
      component: c.label,
      score: +c.score.toFixed(2),
      weight: `${c.weight}%`,
      contribution: +(c.score * c.weight / totalW).toFixed(3),
      basis: c.detail,
    })));
    console.table(penalties.map(p => ({ ...p, score: +p.score.toFixed(2), weight: `${p.weight}%` })));
    console.log('excluded from concentration (broad funds):',
      [...a.combinedExposure]
        .filter(([b]) => positionTypeFor(a.representativeTicker.get(b) ?? b) === 'Broad-Market ETF')
        .map(([b, p]) => `${b} ${p.toFixed(1)}%`));
    console.log('largest name counted once; excluded from breadth and sector terms:',
      largestStock ? `${largestStock[0]} ${largestStockPct.toFixed(1)}%` : 'none');
    console.log('value weighting basis: CAD market value, total', Math.round(totalValue));
    console.log('risks:', risks);
    console.log('positives:', positives);
    console.groupEnd();
    /* eslint-enable no-console */
  }

  return { score, label: labelFor(score, HEALTH_BANDS), components, risks, positives, penalties };
}

/** Tactical read on current conditions — deliberately separate from Health. */
export function computeMarketAlignment(a: {
  avgSectorPressure: number | null;
  avgRs: number | null;
  avgTrend3M: number | null;
  regime: 'Risk-On' | 'Risk-Off' | 'Mixed' | null;
  sectorNotes: string[];
}): MarketAlignment | null {
  const W = MARKET_ALIGNMENT_WEIGHTS;
  const sRotation = a.avgSectorPressure == null ? null
    : clamp10(band(a.avgSectorPressure, [[-100, 1.5], [-50, 3], [-22, 4.3], [-5, 5.3], [5, 6.3], [22, 7.8], [55, 9.3]]));
  const sRs = a.avgRs == null ? null
    : clamp10(band(a.avgRs, [[-1, 1.5], [-0.10, 3], [-0.03, 4.5], [0.03, 6], [0.08, 7.5], [0.20, 9.3]]));
  const sTrend = a.avgTrend3M == null ? null
    : clamp10(band(a.avgTrend3M, [[-1, 1.5], [-0.25, 3], [-0.10, 4.5], [0, 5.5], [0.10, 7], [0.25, 8.8]]));
  const sRegime = a.regime == null ? null
    : a.regime === 'Risk-On' ? 7.5 : a.regime === 'Risk-Off' ? 3.5 : 5.5;

  const { value, coverage } = weighted([
    [sRotation, W.sectorRotation], [sRs, W.relativeStrength],
    [sTrend, W.trendMomentum], [sRegime, W.marketRegime],
  ]);
  if (coverage === 0) return null;

  const score = clamp10(value);
  return {
    score,
    label: labelFor(score, ALIGNMENT_BANDS),
    components: [
      { label: 'Sector rotation',   score: sRotation ?? 5, weight: W.sectorRotation,
        detail: a.avgSectorPressure == null ? 'unavailable' : `weighted pressure ${a.avgSectorPressure >= 0 ? '+' : ''}${a.avgSectorPressure.toFixed(0)}` },
      { label: 'Relative strength', score: sRs ?? 5, weight: W.relativeStrength,
        detail: a.avgRs == null ? 'unavailable' : `${pctDec(a.avgRs)} vs sectors` },
      { label: 'Trend / momentum',  score: sTrend ?? 5, weight: W.trendMomentum,
        detail: a.avgTrend3M == null ? 'unavailable' : `${pctDec(a.avgTrend3M)} over 3M` },
      { label: 'Market regime',     score: sRegime ?? 5, weight: W.marketRegime,
        detail: a.regime ?? 'unavailable' },
    ],
    notes: a.sectorNotes,
  };
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export function buildAlerts(
  reviews: PositionReview[],
  combinedExposure: Map<string, number>,
  representativeTicker?: Map<string, string>,
  growthEtfPct = 0,
): string[] {
  const out: string[] = [];
  const totalValue = reviews.reduce((s, r) => s + r.marketValueCAD, 0) || 1;
  const valueShare = (s: ReviewStatus) =>
    reviews.filter(r => r.status === s).reduce((sum, r) => sum + r.marketValueCAD, 0) / totalValue * 100;
  const count = (s: ReviewStatus) => reviews.filter(r => r.status === s).length;

  // Overweight is judged against the tolerance for what the holding IS —
  // a broad diversified core fund is never "overweight" at a normal core size.
  const overweight = [...combinedExposure.entries()]
    .filter(([base, pct]) => isOverweightExposure(representativeTicker?.get(base) ?? base, pct))
    .sort((a, b) => b[1] - a[1]);
  for (const [base, pct] of overweight.slice(0, 3)) {
    out.push(`${base} combined exposure ${pct.toFixed(1)}% — OVERWEIGHT`);
  }

  const exit = count('EXIT');
  const review = count('REVIEW');
  const watch = count('WATCH');
  const trim = count('TRIM');

  if (exit > 0)   out.push(`${exit} holding${exit > 1 ? 's' : ''} marked thesis-broken`);
  if (review > 0) out.push(`${review} holding${review > 1 ? 's' : ''} require high-priority review (${valueShare('REVIEW').toFixed(1)}% of value)`);
  if (watch > 0)  out.push(`${watch} holding${watch > 1 ? 's' : ''} on watch`);
  if (trim > 0)   out.push(`${trim} holding${trim > 1 ? 's' : ''} suggest trimming`);

  if (growthEtfPct >= CONCENTRATION_BY_TYPE.growthEtf.high) {
    out.push(`Growth / Nasdaq ETF overlap elevated (${growthEtfPct.toFixed(1)}%)`);
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
