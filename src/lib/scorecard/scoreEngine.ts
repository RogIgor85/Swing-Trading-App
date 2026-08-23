// ─────────────────────────────────────────────────────────────────────────────
// Scorecard engine. Pure calculations, no fetching, no UI.
//
// THE core rule: a metric with no data returns null, is dropped from the blend,
// and the remaining weights are renormalised. Missing data is NEVER scored 5.0 —
// that silently dragged every score toward mediocre and was the reason a
// business like Apple read as "6.5".
//
// Four independent dimensions (Company Quality, Valuation, Technical Setup,
// Market Alignment) are computed first, then blended into three horizon scores.
// ─────────────────────────────────────────────────────────────────────────────

import {
  COMPANY_QUALITY_WEIGHTS, VALUATION_WEIGHTS, TECHNICAL_WEIGHTS,
  MARKET_ALIGNMENT_WEIGHTS, SWING_WEIGHTS, MEDIUM_TERM_WEIGHTS, LONG_TERM_WEIGHTS,
  SCORE_THRESHOLDS, QUALITY_THRESHOLDS, DATA_COVERAGE_THRESHOLDS,
} from '../../config/scorecardConfig';

export interface Component {
  label: string;
  /** null when the metric was unavailable — excluded, never defaulted */
  score: number | null;
  weight: number;
  display: string;
}

export interface DimensionScore {
  score: number | null;
  label: string;
  /** 0–100: share of total weight backed by real data */
  coverage: number;
  confidence: 'HIGH' | 'MODERATE' | 'LOW';
  components: Component[];
  available: number;
  total: number;
}

const clamp10 = (x: number) => Math.max(0, Math.min(10, x));

/** Map a value through ascending breakpoints. Returns null for null input. */
function band(v: number | null | undefined, points: Array<[number, number]>): number | null {
  if (v == null || !isFinite(v)) return null;
  let s = points[0][1];
  for (const [t, x] of points) if (v >= t) s = x;
  return s;
}

/** Descending metrics (lower is better) — negate before banding. */
function bandDesc(v: number | null | undefined, points: Array<[number, number]>): number | null {
  if (v == null || !isFinite(v)) return null;
  return band(-v, points);
}

/**
 * Weighted average of sub-metrics inside a single component. Null parts are
 * dropped and the surviving weights renormalised — never filled with a default.
 */
function weighted(parts: Array<[number | null, number]>): number | null {
  let sum = 0, w = 0;
  for (const [v, weight] of parts) { if (v == null) continue; sum += v * weight; w += weight; }
  return w > 0 ? sum / w : null;
}

function labelFor(score: number | null, table: Array<[number, string]>): string {
  if (score == null) return 'NO DATA';
  for (const [t, l] of table) if (score >= t) return l;
  return table[table.length - 1][1];
}

function confidenceFor(coverage: number): DimensionScore['confidence'] {
  if (coverage < DATA_COVERAGE_THRESHOLDS.low) return 'LOW';
  if (coverage < DATA_COVERAGE_THRESHOLDS.moderate) return 'MODERATE';
  return 'HIGH';
}

/**
 * Blend components, dropping nulls and renormalising the remaining weights.
 * Returns null only when NO component had data.
 */
function blend(components: Component[], thresholds: Array<[number, string]>): DimensionScore {
  const totalWeight = components.reduce((s, c) => s + c.weight, 0) || 1;
  let sum = 0, usedWeight = 0, available = 0;
  for (const c of components) {
    if (c.score == null) continue;
    sum += c.score * c.weight;
    usedWeight += c.weight;
    available++;
  }
  const score = usedWeight > 0 ? clamp10(sum / usedWeight) : null;
  const coverage = Math.round((usedWeight / totalWeight) * 100);
  return {
    score, label: labelFor(score, thresholds), coverage,
    confidence: confidenceFor(coverage), components,
    available, total: components.length,
  };
}

// ── inputs ───────────────────────────────────────────────────────────────────

/**
 * Business inputs only. Note there is deliberately NO marketCap or price here:
 * FCF *yield* (FCF ÷ market cap) is a valuation metric, so using it would let
 * the share price leak into Company Quality. Cash flow is measured as FCF
 * margin (FCF ÷ revenue), which is a property of the business alone.
 */
export interface QualityInputs {
  netMargin?: number | null;        // %
  operatingMargin?: number | null;  // %
  grossMargin?: number | null;      // %
  roe?: number | null;              // %
  roic?: number | null;             // %
  fcf?: number | null;              // absolute, for sign/positivity
  revenue?: number | null;          // absolute, to derive FCF margin
  debtToEquity?: number | null;     // ratio
  currentRatio?: number | null;
  revenueGrowth?: number | null;    // %
  epsGrowth?: number | null;        // %
}

export interface ValuationInputs {
  forwardPE?: number | null;
  trailingPE?: number | null;
  peg?: number | null;
  fcf?: number | null;
  marketCap?: number | null;
  priceToBook?: number | null;
}

export interface TechnicalInputs {
  price?: number | null;
  ma50?: number | null;
  ma200?: number | null;
  low52?: number | null;
  high52?: number | null;
  volume?: number | null;
  avgVolume?: number | null;
  ret1M?: number | null;            // decimal
}

export interface AlignmentInputs {
  sectorPressure?: number | null;   // −100…100
  rsVsSector1M?: number | null;     // decimal
  ret3M?: number | null;            // decimal
  bullishPercent?: number | null;   // 0–1
}

// ── Company Quality ──────────────────────────────────────────────────────────

export function scoreCompanyQuality(i: QualityInputs): DimensionScore {
  const W = COMPANY_QUALITY_WEIGHTS;
  const pct = (v: number | null | undefined, d = 1) => v == null ? 'N/A' : `${v.toFixed(d)}%`;

  // Profitability — net margin, lifted by a strong operating margin
  const netScore = band(i.netMargin, [[-100, 1], [0, 4], [5, 5.5], [10, 6.5], [18, 8], [25, 9], [35, 9.8]]);
  const opScore  = band(i.operatingMargin, [[-100, 1], [0, 4], [8, 5.5], [15, 7], [25, 8.5], [35, 9.5]]);
  const profitability = netScore == null && opScore == null ? null
    : netScore == null ? opScore : opScore == null ? netScore : (netScore * 0.6 + opScore * 0.4);

  // Cash flow — FCF as a share of REVENUE, not market cap. FCF/market cap is a
  // valuation measure (it falls simply because the stock got more expensive) and
  // is scored under Valuation instead.
  const fcfMargin = i.fcf != null && i.revenue != null && i.revenue > 0
    ? (i.fcf / i.revenue) * 100 : null;
  const cashFlow = i.fcf != null && i.fcf <= 0 ? 2.5
    : band(fcfMargin, [[-100, 1.5], [0, 4], [5, 5.5], [10, 6.8], [18, 8.2], [28, 9.3]]);

  // Capital efficiency — ROIC preferred, ROE fallback
  const capitalEfficiency = i.roic != null
    ? band(i.roic, [[-100, 1], [0, 4], [8, 5.5], [12, 7], [20, 8.5], [30, 9.6]])
    : band(i.roe, [[-100, 1], [0, 4], [8, 5.5], [15, 7], [25, 8.8], [40, 9.6]]);

  // Financial durability — leverage and liquidity, but weighed against cash
  // generation: debt carried by a business throwing off large free cash flow is
  // not the same risk as the same ratio at a company that burns cash.
  const levScore = bandDesc(i.debtToEquity, [[-6, 2], [-3, 3.5], [-2, 5], [-1.2, 6.5], [-0.6, 8], [-0.3, 9.2]]);
  const crScore  = band(i.currentRatio, [[0, 3], [0.8, 4.5], [1.2, 6.5], [1.8, 8], [2.5, 9]]);
  const selfFund = i.fcf != null && i.fcf <= 0 ? 3
    : band(fcfMargin, [[0, 5], [5, 6.3], [12, 7.5], [20, 8.5], [30, 9.3]]);
  const financialDurability = weighted([
    [levScore, 0.55], [crScore, 0.20], [selfFund, 0.25],
  ]);

  // Growth quality — revenue and earnings growth durability
  const revScore = band(i.revenueGrowth, [[-100, 1.5], [-5, 3.5], [0, 5], [5, 6.2], [10, 7.3], [18, 8.6], [28, 9.5]]);
  const epsScore = band(i.epsGrowth, [[-100, 1.5], [-5, 3.5], [0, 5], [8, 6.5], [15, 7.8], [25, 9], [40, 9.6]]);
  const growthQuality = revScore == null && epsScore == null ? null
    : revScore == null ? epsScore : epsScore == null ? revScore : (revScore * 0.5 + epsScore * 0.5);

  // Moat proxy — durable pricing power shows up as a high, stable gross margin.
  // Calibrated against the real distribution: the S&P 500 median sits near 33%,
  // so 40%+ is genuinely above average rather than merely mid-table.
  const moat = band(i.grossMargin, [[0, 3], [20, 4.5], [30, 5.8], [40, 7], [55, 8.2], [68, 9.2], [78, 9.7]]);

  return blend([
    { label: 'Profitability',        score: profitability,       weight: W.profitability,
      display: i.netMargin != null ? `net margin ${pct(i.netMargin)}` : i.operatingMargin != null ? `op margin ${pct(i.operatingMargin)}` : 'N/A' },
    { label: 'Cash Flow',            score: cashFlow,            weight: W.cashFlow,
      display: fcfMargin != null ? `FCF margin ${pct(fcfMargin)}` : i.fcf != null && i.fcf <= 0 ? 'negative FCF' : 'N/A' },
    { label: 'Capital Efficiency',   score: capitalEfficiency,   weight: W.capitalEfficiency,
      display: i.roic != null ? `ROIC ${pct(i.roic)}` : i.roe != null ? `ROE ${pct(i.roe)}` : 'N/A' },
    { label: 'Financial Durability', score: financialDurability, weight: W.financialDurability,
      display: i.debtToEquity != null ? `D/E ${i.debtToEquity.toFixed(2)}`
        : i.currentRatio != null ? `current ratio ${i.currentRatio.toFixed(2)}`
        : selfFund != null ? 'cash generation only' : 'N/A' },
    { label: 'Growth Quality',       score: growthQuality,       weight: W.growthQuality,
      display: i.revenueGrowth != null ? `revenue ${pct(i.revenueGrowth)}` : i.epsGrowth != null ? `EPS ${pct(i.epsGrowth)}` : 'N/A' },
    { label: 'Moat',                 score: moat,                weight: W.moat,
      display: i.grossMargin != null ? `gross margin ${pct(i.grossMargin)}` : 'N/A' },
  ], QUALITY_THRESHOLDS);
}

// ── Valuation ────────────────────────────────────────────────────────────────

export function scoreValuation(i: ValuationInputs): DimensionScore {
  const W = VALUATION_WEIGHTS;
  const peBands: Array<[number, number]> = [[-100, 1.5], [-60, 3], [-40, 4.3], [-30, 5.3], [-22, 6.5], [-16, 7.8], [-11, 9]];

  // Negative earnings is a real valuation problem, not missing data
  const fwd = i.forwardPE != null && i.forwardPE < 0 ? 2 : bandDesc(i.forwardPE, peBands);
  const ttm = i.trailingPE != null && i.trailingPE < 0 ? 2 : bandDesc(i.trailingPE, peBands);
  const peg = i.peg != null && i.peg <= 0 ? 3
    : bandDesc(i.peg, [[-5, 2], [-3, 3.5], [-2, 5], [-1.5, 6.5], [-1, 8], [-0.7, 9.3]]);

  const fcfYield = i.fcf != null && i.marketCap != null && i.marketCap > 0
    ? (i.fcf / i.marketCap) * 100 : null;
  const fcfScore = i.fcf != null && i.fcf <= 0 ? 2.5
    : band(fcfYield, [[0, 4], [2, 5.5], [4, 7], [6, 8.3], [9, 9.5]]);

  const pb = bandDesc(i.priceToBook, [[-20, 2], [-10, 3.5], [-6, 5], [-4, 6.3], [-2.5, 7.6], [-1.5, 9]]);

  return blend([
    { label: 'Forward P/E',  score: fwd,      weight: W.forwardPE,
      display: i.forwardPE == null ? 'N/A' : i.forwardPE < 0 ? 'negative' : `${i.forwardPE.toFixed(1)}x` },
    { label: 'Trailing P/E', score: ttm,      weight: W.trailingPE,
      display: i.trailingPE == null ? 'N/A' : i.trailingPE < 0 ? 'negative' : `${i.trailingPE.toFixed(1)}x` },
    { label: 'PEG',          score: peg,      weight: W.peg,
      display: i.peg == null ? 'N/A' : i.peg.toFixed(2) },
    { label: 'FCF Yield',    score: fcfScore, weight: W.fcfYield,
      display: fcfYield == null ? 'N/A' : `${fcfYield.toFixed(1)}%` },
    { label: 'Price / Book', score: pb,       weight: W.priceToBook,
      display: i.priceToBook == null ? 'N/A' : `${i.priceToBook.toFixed(1)}x` },
  ], SCORE_THRESHOLDS);
}

// ── Technical Setup ──────────────────────────────────────────────────────────

export function scoreTechnical(i: TechnicalInputs): DimensionScore {
  const W = TECHNICAL_WEIGHTS;
  const p = i.price ?? null;

  const pctAbove = (ma: number | null | undefined) =>
    p != null && ma != null && ma > 0 ? ((p - ma) / ma) * 100 : null;

  const above200 = pctAbove(i.ma200);
  const above50  = pctAbove(i.ma50);

  const vs200 = band(above200, [[-60, 1.5], [-20, 3], [-8, 4.3], [0, 6.3], [6, 7.6], [15, 8.6], [30, 8.2]]);
  const vs50  = band(above50,  [[-40, 1.8], [-12, 3.3], [-4, 4.8], [0, 6.5], [5, 7.8], [12, 8.6], [25, 7.8]]);

  const rangePos = p != null && i.low52 != null && i.high52 != null && i.high52 > i.low52
    ? ((p - i.low52) / (i.high52 - i.low52)) * 100 : null;
  // Mid-to-upper range scores best; extremes are less attractive entries
  const position52W = band(rangePos, [[0, 3], [15, 4.5], [30, 6], [50, 7.5], [70, 8.3], [88, 6.5], [97, 5]]);

  const volRatio = i.volume != null && i.avgVolume != null && i.avgVolume > 0
    ? i.volume / i.avgVolume : null;
  const volume = band(volRatio, [[0, 3.5], [0.7, 5], [1, 6.5], [1.3, 7.8], [2, 8.5]]);

  const momentum = band(i.ret1M, [[-1, 1.5], [-0.15, 3.3], [-0.05, 5], [0.03, 6.5], [0.10, 7.8], [0.20, 8.8]]);

  return blend([
    { label: 'Price vs 200DMA', score: vs200,       weight: W.vs200MA,
      display: above200 == null ? 'N/A' : `${above200 >= 0 ? '+' : ''}${above200.toFixed(1)}%` },
    { label: 'Price vs 50DMA',  score: vs50,        weight: W.vs50MA,
      display: above50 == null ? 'N/A' : `${above50 >= 0 ? '+' : ''}${above50.toFixed(1)}%` },
    { label: '52-Week Position', score: position52W, weight: W.position52W,
      display: rangePos == null ? 'N/A' : `${rangePos.toFixed(0)}% of range` },
    { label: 'Volume',          score: volume,      weight: W.volume,
      display: volRatio == null ? 'N/A' : `${volRatio.toFixed(2)}x avg` },
    { label: 'Momentum (1M)',   score: momentum,    weight: W.momentum,
      display: i.ret1M == null ? 'N/A' : `${i.ret1M >= 0 ? '+' : ''}${(i.ret1M * 100).toFixed(1)}%` },
  ], SCORE_THRESHOLDS);
}

// ── Market Alignment ─────────────────────────────────────────────────────────

export function scoreMarketAlignment(i: AlignmentInputs): DimensionScore {
  const W = MARKET_ALIGNMENT_WEIGHTS;

  const rotation = band(i.sectorPressure, [[-100, 1.5], [-55, 3], [-22, 4.3], [-5, 5.3], [5, 6.3], [22, 7.8], [55, 9.3]]);
  const rs = band(i.rsVsSector1M, [[-1, 1.5], [-0.10, 3], [-0.03, 4.5], [0.03, 6.3], [0.08, 7.6], [0.20, 9.2]]);
  const momentum = band(i.ret3M, [[-1, 1.5], [-0.25, 3], [-0.10, 4.5], [0, 5.8], [0.10, 7.3], [0.25, 8.8]]);
  const sentiment = band(i.bullishPercent, [[0, 3], [0.35, 4.5], [0.5, 6], [0.65, 7.5], [0.8, 8.5]]);

  return blend([
    { label: 'Sector Rotation',   score: rotation,  weight: W.sectorRotation,
      display: i.sectorPressure == null ? 'N/A' : `pressure ${i.sectorPressure >= 0 ? '+' : ''}${i.sectorPressure}` },
    { label: 'Relative Strength', score: rs,        weight: W.relativeStrength,
      display: i.rsVsSector1M == null ? 'N/A' : `${i.rsVsSector1M >= 0 ? '+' : ''}${(i.rsVsSector1M * 100).toFixed(1)}% vs sector` },
    { label: 'Momentum (3M)',     score: momentum,  weight: W.momentum,
      display: i.ret3M == null ? 'N/A' : `${i.ret3M >= 0 ? '+' : ''}${(i.ret3M * 100).toFixed(1)}%` },
    { label: 'Sentiment',         score: sentiment, weight: W.sentiment,
      display: i.bullishPercent == null ? 'N/A' : `${(i.bullishPercent * 100).toFixed(0)}% bullish` },
  ], SCORE_THRESHOLDS);
}

// ── Horizon blends ───────────────────────────────────────────────────────────

export interface Dimensions {
  companyQuality: DimensionScore;
  valuation: DimensionScore;
  technicalSetup: DimensionScore;
  marketAlignment: DimensionScore;
}

export interface HorizonScore {
  key: 'swing' | 'medium' | 'long';
  score: number | null;
  label: string;
  coverage: number;
  confidence: DimensionScore['confidence'];
  contributions: Array<{ label: string; score: number | null; weight: number; contribution: number | null }>;
  positives: string[];
  negatives: string[];
}

function horizon(
  key: HorizonScore['key'],
  d: Dimensions,
  weights: { companyQuality: number; valuation: number; technicalSetup: number; marketAlignment: number },
): HorizonScore {
  const parts = [
    { label: 'Company Quality',  dim: d.companyQuality,  weight: weights.companyQuality },
    { label: 'Valuation',        dim: d.valuation,       weight: weights.valuation },
    { label: 'Technical Setup',  dim: d.technicalSetup,  weight: weights.technicalSetup },
    { label: 'Market Alignment', dim: d.marketAlignment, weight: weights.marketAlignment },
  ];

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0) || 1;
  let sum = 0, usedWeight = 0, coverageWeighted = 0;
  for (const p of parts) {
    if (p.dim.score == null) continue;
    sum += p.dim.score * p.weight;
    usedWeight += p.weight;
    coverageWeighted += p.dim.coverage * p.weight;
  }
  const score = usedWeight > 0 ? clamp10(sum / usedWeight) : null;
  // Coverage is the weighted coverage of the dimensions actually used, scaled
  // by how much of the intended weighting was available at all.
  const coverage = usedWeight > 0
    ? Math.round((coverageWeighted / usedWeight) * (usedWeight / totalWeight))
    : 0;

  const contributions = parts.map(p => ({
    label: p.label,
    score: p.dim.score,
    weight: p.weight,
    contribution: p.dim.score != null && usedWeight > 0 ? (p.dim.score * p.weight) / usedWeight : null,
  }));

  // Drivers: dimensions pulling the score up or down, weighted by influence
  const positives: string[] = [];
  const negatives: string[] = [];
  const ranked = parts
    .filter(p => p.dim.score != null)
    .map(p => ({ ...p, impact: (p.dim.score! - 5.5) * (p.weight / totalWeight) }))
    .sort((a, b) => b.impact - a.impact);

  for (const p of ranked.filter(x => x.impact > 0.15).slice(0, 3)) {
    positives.push(`${p.label} ${p.dim.score!.toFixed(1)} — ${p.dim.label.toLowerCase()}`);
  }
  for (const p of [...ranked].reverse().filter(x => x.impact < -0.15).slice(0, 3)) {
    negatives.push(`${p.label} ${p.dim.score!.toFixed(1)} — ${p.dim.label.toLowerCase()}`);
  }
  for (const p of parts.filter(x => x.dim.score == null || x.dim.confidence === 'LOW')) {
    negatives.push(p.dim.score == null
      ? `${p.label} unavailable — excluded from this score`
      : `${p.label} data coverage ${p.dim.coverage}% — low confidence`);
  }

  return {
    key, score, label: labelFor(score, SCORE_THRESHOLDS),
    coverage, confidence: confidenceFor(coverage),
    contributions, positives, negatives,
  };
}

export function scoreHorizons(d: Dimensions): { swing: HorizonScore; medium: HorizonScore; long: HorizonScore } {
  return {
    swing:  horizon('swing',  d, SWING_WEIGHTS),
    medium: horizon('medium', d, MEDIUM_TERM_WEIGHTS),
    long:   horizon('long',   d, LONG_TERM_WEIGHTS),
  };
}

// ── Best fit, with reasoning ─────────────────────────────────────────────────

export interface BestFitResult {
  key: HorizonScore['key'] | null;
  title: string;
  reason: string;
}

export function explainBestFit(h: { swing: HorizonScore; medium: HorizonScore; long: HorizonScore }, d: Dimensions): BestFitResult {
  const titles = { swing: 'Swing', medium: 'Medium Term', long: 'Long Term' };
  const scored = [h.swing, h.medium, h.long].filter(x => x.score != null);
  if (scored.length === 0) return { key: null, title: 'N/A', reason: 'Not enough data to score any horizon.' };

  const sorted = [...scored].sort((a, b) => b.score! - a.score!);
  const win = sorted[0];
  const others = sorted.slice(1);

  const gaps = others
    .map(o => `${titles[o.key]} by ${(win.score! - o.score!).toFixed(1)}`)
    .join(' and ');

  const bits: string[] = [`${titles[win.key]} leads ${gaps}.`];
  if (d.companyQuality.score != null && d.companyQuality.score >= 7.5) {
    bits.push('Strong business quality supports the thesis');
  } else if (d.companyQuality.score != null && d.companyQuality.score < 5) {
    bits.push('Business quality is the main constraint');
  }
  const drags: string[] = [];
  if (d.technicalSetup.score != null && d.technicalSetup.score < 5.5) drags.push('the current technical setup');
  if (d.marketAlignment.score != null && d.marketAlignment.score < 5.5) drags.push('sector conditions');
  if (d.valuation.score != null && d.valuation.score < 5) drags.push('an elevated valuation');
  if (drags.length > 0) {
    bits.push(`${drags.join(' and ')} ${drags.length > 1 ? 'prevent' : 'prevents'} a stronger short-term rating`);
  }

  return { key: win.key, title: titles[win.key], reason: bits.join('. ').replace(/\.\./g, '.') + '.' };
}

// ── What would improve / weaken the setup ────────────────────────────────────

export function scoreLevers(d: Dimensions, a: AlignmentInputs, t: TechnicalInputs): { improve: string[]; weaken: string[] } {
  const improve: string[] = [];
  const weaken: string[] = [];

  const above200 = t.price != null && t.ma200 != null && t.ma200 > 0 ? (t.price / t.ma200 - 1) * 100 : null;
  const above50  = t.price != null && t.ma50  != null && t.ma50  > 0 ? (t.price / t.ma50  - 1) * 100 : null;

  if (above50 != null && above50 < 0) improve.push('Price reclaims its 50-day moving average');
  else if (above50 != null) weaken.push('Price loses its 50-day moving average');

  if (above200 != null && above200 < 0) improve.push('Price recovers above its 200-day moving average');
  else if (above200 != null) weaken.push('Price breaks below its 200-day moving average');

  if (a.sectorPressure != null) {
    if (a.sectorPressure <= 0) improve.push('Sector rotation pressure turns positive');
    else weaken.push('Sector rotation pressure turns negative');
  }
  if (a.rsVsSector1M != null) {
    if (a.rsVsSector1M <= 0) improve.push('Relative strength versus its sector improves');
    else weaken.push('Relative strength versus its sector deteriorates');
  }
  if (d.valuation.score != null) {
    if (d.valuation.score < 6) improve.push('Valuation compresses, or earnings grow into the current price');
    else weaken.push('Valuation expands without matching earnings growth');
  }
  if (d.companyQuality.score != null) {
    if (d.companyQuality.score < 7) improve.push('Margins or growth durability improve');
    weaken.push('Margins compress or earnings growth stalls');
  }
  // Coverage is itself a lever — more data means a more reliable score
  for (const [name, dim] of Object.entries(d)) {
    if (dim.confidence === 'LOW') {
      improve.push(`More complete data for ${name.replace(/([A-Z])/g, ' $1').toLowerCase().trim()} (currently ${dim.coverage}%)`);
    }
  }

  return { improve: improve.slice(0, 6), weaken: weaken.slice(0, 6) };
}

// ── Full run + audit ─────────────────────────────────────────────────────────

export interface ScorecardResult {
  dimensions: Dimensions;
  horizons: { swing: HorizonScore; medium: HorizonScore; long: HorizonScore };
  bestFit: BestFitResult;
  levers: { improve: string[]; weaken: string[] };
  overallCoverage: number;
}

export function runScorecard(inputs: {
  quality: QualityInputs;
  valuation: ValuationInputs;
  technical: TechnicalInputs;
  alignment: AlignmentInputs;
  ticker?: string;
}): ScorecardResult {
  const dimensions: Dimensions = {
    companyQuality:  scoreCompanyQuality(inputs.quality),
    valuation:       scoreValuation(inputs.valuation),
    technicalSetup:  scoreTechnical(inputs.technical),
    marketAlignment: scoreMarketAlignment(inputs.alignment),
  };
  const horizons = scoreHorizons(dimensions);
  const bestFit = explainBestFit(horizons, dimensions);
  const levers = scoreLevers(dimensions, inputs.alignment, inputs.technical);

  const dims = Object.values(dimensions);
  const overallCoverage = Math.round(dims.reduce((s, x) => s + x.coverage, 0) / dims.length);

  if (import.meta.env?.DEV) {
    /* eslint-disable no-console */
    console.groupCollapsed(`[scorecard] ${inputs.ticker ?? ''} — coverage ${overallCoverage}%`);
    console.table(Object.entries(dimensions).map(([k, v]) => ({
      dimension: k, score: v.score?.toFixed(2) ?? 'n/a', label: v.label,
      coverage: `${v.coverage}%`, metrics: `${v.available}/${v.total}`, confidence: v.confidence,
    })));
    for (const [k, v] of Object.entries(dimensions) as Array<[string, DimensionScore]>) {
      console.groupCollapsed(`${k} components`);
      console.table(v.components.map((c: Component) => ({
        metric: c.label, value: c.display,
        score: c.score?.toFixed(2) ?? 'EXCLUDED (no data)', weight: `${c.weight}%`,
      })));
      console.groupEnd();
    }
    console.table([horizons.swing, horizons.medium, horizons.long].map(x => ({
      horizon: x.key, score: x.score?.toFixed(2) ?? 'n/a', label: x.label, coverage: `${x.coverage}%`,
    })));
    console.log('best fit:', bestFit.key, '—', bestFit.reason);
    console.groupEnd();
    /* eslint-enable no-console */
  }

  return { dimensions, horizons, bestFit, levers, overallCoverage };
}

export { labelFor };
