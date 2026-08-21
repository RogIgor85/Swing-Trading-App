// ─────────────────────────────────────────────────────────────────────────────
// Sector Rotation — scoring engine. Pure calculations, no fetching, no UI.
//
// Rotation Pressure (−100…+100): direction current evidence suggests rotation
//   is moving. Cross-sectional z-scores of momentum/RS-change/volume/trend
//   components, weight-summed (weights in sectorConfig).
// Rotation Score (0–100): overall sector strength via cross-sectional
//   percentiles of level metrics.
// Neither metric represents literal dollar fund flows.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SECTOR_ETFS, BENCHMARK_ETF, ROTATION_PRESSURE_WEIGHTS, ROTATION_SCORE_WEIGHTS,
  ROTATION_THRESHOLDS, MOMENTUM_THRESHOLDS, PRESSURE_TREND_THRESHOLDS,
  SIGNAL_THRESHOLDS, BREADTH_SETTINGS, MATRIX_TRAIL, TIMEFRAME_DAYS,
} from '../../config/sectorConfig';
import type { SectorDef, MatrixTimeframe, Timeframe } from '../../config/sectorConfig';
import type { EtfHistory, ConstituentQuote } from './sectorData';

export type Classification = 'Leading' | 'Improving' | 'Neutral' | 'Weakening' | 'Lagging';
export type MomentumState  = 'ACCELERATING' | 'STEADY' | 'DECELERATING';
export type TrendArrow     = 'up' | 'flat' | 'down';

export interface BreadthInfo {
  score: number;
  above50Pct: number;
  above200Pct: number;
  positiveTodayPct: number;
  count: number;
  change: number | null; // vs snapshot ≥3 trading days ago (built up over app usage)
}

export interface SignalInfo {
  label: string;
  direction: 'in' | 'out' | 'hold';
  reasons: string[];
}

export interface MatrixPoint { x: number; y: number }

export interface SectorMetrics {
  def: SectorDef;
  etf: string;
  name: string;
  price: number;
  ret: Partial<Record<Timeframe, number | null>>;
  rs: Partial<Record<'5D' | '1M' | '3M' | '6M', number | null>>; // decimals
  rsChange1M: number | null;
  accelShort: number | null;
  accelMedium: number | null;
  momentum: MomentumState;
  volumeRatio: number | null;
  above50: boolean | null;
  above200: boolean | null;
  breadth: BreadthInfo | null;
  pressure: number;
  pressureSeries: number[]; // oldest → newest, ~40 points
  pressureDelta: { d1: number | null; d5: number | null; d20: number | null };
  trendArrow: TrendArrow;
  score: number;
  classification: Classification;
  signal: SignalInfo | null;
  matrix: Record<MatrixTimeframe, { x: number; y: number; trail: MatrixPoint[] }>;
}

export interface MarketRegime {
  regime: 'Risk-On' | 'Risk-Off' | 'Mixed';
  leader: string | null;
  fastestImproving: string | null;
  weakeningLeader: string | null;
  lagging: string | null;
  breadthPct: number | null; // % of sectors with positive 1M RS
}

export interface Opportunity {
  category: string;
  direction: 'in' | 'out';
  etf: string;
  name: string;
  score: number;
  pressure: number;
  reasons: string[];
  participants: string[];
}

// ── small math helpers ───────────────────────────────────────────────────────

function retN(closes: number[], n: number, endOffset = 0): number | null {
  const end = closes.length - 1 - endOffset;
  const start = end - n;
  if (start < 0 || end <= 0 || closes[start] === 0) return null;
  return closes[end] / closes[start] - 1;
}

function sma(closes: number[], n: number, endOffset = 0): number | null {
  const end = closes.length - endOffset;
  if (end - n < 0) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += closes[i];
  return s / n;
}

function mean(xs: number[]): number { return xs.reduce((s, x) => s + x, 0) / (xs.length || 1); }

function zScores(xs: (number | null)[]): number[] {
  const valid = xs.filter((x): x is number => x != null && isFinite(x));
  if (valid.length < 2) return xs.map(() => 0);
  const mu = mean(valid);
  const sd = Math.sqrt(mean(valid.map(x => (x - mu) ** 2))) || 1e-9;
  return xs.map(x => (x == null || !isFinite(x)) ? 0 : Math.max(-2.5, Math.min(2.5, (x - mu) / sd)));
}

function percentiles(xs: (number | null)[]): number[] {
  const idx = xs.map((x, i) => ({ x, i })).filter(p => p.x != null && isFinite(p.x as number));
  const sorted = [...idx].sort((a, b) => (a.x as number) - (b.x as number));
  const out = xs.map(() => 50);
  sorted.forEach((p, rank) => { out[p.i] = sorted.length > 1 ? (rank / (sorted.length - 1)) * 100 : 50; });
  return out;
}

// ── breadth (from batched constituent quotes) ────────────────────────────────

const BREADTH_HIST_KEY = 'swing_sec_breadth_hist';

function computeBreadth(def: SectorDef, quotes: Map<string, ConstituentQuote>): Omit<BreadthInfo, 'change'> | null {
  const qs = def.constituents.map(t => quotes.get(t)).filter((q): q is ConstituentQuote => !!q && q.price != null);
  if (qs.length < 4) return null;
  const above50  = qs.filter(q => q.ma50 != null  && q.price! > q.ma50!).length / qs.length;
  const above200 = qs.filter(q => q.ma200 != null && q.price! > q.ma200!).length / qs.length;
  const posToday = qs.filter(q => (q.changePct ?? 0) > 0).length / qs.length;
  const w = BREADTH_SETTINGS.weights;
  const score = (above50 * w.above50 + above200 * w.above200 + posToday * w.positiveToday) * 100;
  return {
    score: Math.round(score),
    above50Pct: Math.round(above50 * 100),
    above200Pct: Math.round(above200 * 100),
    positiveTodayPct: Math.round(posToday * 100),
    count: qs.length,
  };
}

/** Persist today's breadth snapshot; return change vs a snapshot ≥3 days old. */
function breadthChangeTracker(scores: Record<string, number>): Record<string, number | null> {
  let hist: Record<string, Record<string, number>> = {};
  try { hist = JSON.parse(localStorage.getItem(BREADTH_HIST_KEY) ?? '{}'); } catch { /* fresh */ }
  const today = new Date().toISOString().split('T')[0];
  hist[today] = scores;
  // keep last 15 snapshots
  const dates = Object.keys(hist).sort();
  while (dates.length > 15) { delete hist[dates.shift()!]; }
  try { localStorage.setItem(BREADTH_HIST_KEY, JSON.stringify(hist)); } catch { /* full */ }

  const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
  const refDate = Object.keys(hist).sort().filter(d => d <= cutoff).pop();
  const out: Record<string, number | null> = {};
  for (const etf of Object.keys(scores)) {
    out[etf] = refDate != null && hist[refDate]?.[etf] != null ? scores[etf] - hist[refDate][etf] : null;
  }
  return out;
}

// ── pressure component extraction (price/volume-derived, historical-capable) ─

interface PressureComponents {
  rsChange1M: number | null;
  rsChange5D: number | null;
  accelShort: number | null;
  accelMedium: number | null;
  shortMomentum: number | null;
  mediumMomentum: number | null;
  volumeConfirm: number | null;
  trend: number | null;
}

function componentsAt(sec: number[], vol: number[], spy: number[], endOffset: number): PressureComponents {
  const rsRatioAt = (off: number): number | null => {
    const i = sec.length - 1 - off;
    const j = spy.length - 1 - off;
    if (i < 0 || j < 0 || spy[j] === 0) return null;
    return sec[i] / spy[j];
  };
  const rNow  = rsRatioAt(endOffset);
  const r5    = rsRatioAt(endOffset + 5);
  const r21   = rsRatioAt(endOffset + 21);
  const m5    = retN(sec, 5, endOffset);
  const m5p   = retN(sec, 5, endOffset + 5);
  const m20   = retN(sec, 20, endOffset);
  const m20p  = retN(sec, 20, endOffset + 20);
  const m21   = retN(sec, 21, endOffset);

  // volume: avg last 5 vs avg previous 20
  let volumeConfirm: number | null = null;
  const vEnd = vol.length - endOffset;
  if (vEnd - 25 >= 0) {
    const v5  = mean(vol.slice(vEnd - 5, vEnd));
    const v20 = mean(vol.slice(vEnd - 25, vEnd - 5));
    if (v20 > 0) volumeConfirm = v5 / v20 - 1;
  }

  // trend composite: above 50DMA + above 200DMA + 50DMA>200DMA (0…3 → −1…+1)
  let trend: number | null = null;
  const px = sec[sec.length - 1 - endOffset];
  const ma50  = sma(sec, 50, endOffset);
  const ma200 = sma(sec, 200, endOffset);
  if (px != null && ma50 != null) {
    let t = px > ma50 ? 1 : 0;
    if (ma200 != null) {
      t += px > ma200 ? 1 : 0;
      t += ma50 > ma200 ? 1 : 0;
      trend = t / 1.5 - 1; // 0…3 → −1…+1
    } else {
      trend = t * 2 - 1;
    }
  }

  return {
    rsChange1M:    rNow != null && r21 != null && r21 !== 0 ? rNow / r21 - 1 : null,
    rsChange5D:    rNow != null && r5  != null && r5  !== 0 ? rNow / r5 - 1 : null,
    accelShort:    m5 != null && m5p != null ? m5 - m5p : null,
    accelMedium:   m20 != null && m20p != null ? m20 - m20p : null,
    shortMomentum: m5,
    mediumMomentum: m21,
    volumeConfirm,
    trend,
  };
}

function pressureFromComponents(
  all: PressureComponents[],
  breadthZ: number[] | null,
  breadthChangeZ: number[] | null,
): number[] {
  const W = ROTATION_PRESSURE_WEIGHTS;
  const priceKeys: (keyof PressureComponents)[] = [
    'rsChange1M', 'rsChange5D', 'accelShort', 'accelMedium',
    'shortMomentum', 'mediumMomentum', 'volumeConfirm', 'trend',
  ];
  const z: Record<string, number[]> = {};
  for (const k of priceKeys) z[k] = zScores(all.map(c => c[k]));

  let totalW = priceKeys.reduce((s, k) => s + W[k as keyof typeof W], 0);
  if (breadthZ) totalW += W.breadthLevel;
  if (breadthChangeZ) totalW += W.breadthChange;

  return all.map((_, i) => {
    let sum = 0;
    for (const k of priceKeys) sum += z[k][i] * W[k as keyof typeof W];
    if (breadthZ)       sum += breadthZ[i] * W.breadthLevel;
    if (breadthChangeZ) sum += breadthChangeZ[i] * W.breadthChange;
    const raw = (sum / totalW) * 40; // z∈±2.5 → ±100
    return Math.round(Math.max(-100, Math.min(100, raw)));
  });
}

// ── main computation ─────────────────────────────────────────────────────────

const PRESSURE_HISTORY_DAYS = 40;

export function computeSectorMetrics(
  histories: Map<string, EtfHistory>,
  constituentQuotes: Map<string, ConstituentQuote>,
): SectorMetrics[] {
  const spyH = histories.get(BENCHMARK_ETF);
  if (!spyH) return [];
  const spy = spyH.closes;

  const available = SECTOR_ETFS.filter(s => histories.has(s.etf));

  // Breadth (current only) + change tracker
  const breadthRaw = new Map(available.map(s => [s.etf, computeBreadth(s, constituentQuotes)]));
  const breadthScores: Record<string, number> = {};
  breadthRaw.forEach((b, etf) => { if (b) breadthScores[etf] = b.score; });
  const breadthChanges = breadthChangeTracker(breadthScores);

  // Pressure series: components at each historical offset, cross-sectional per day
  const seriesByEtf = new Map<string, number[]>(available.map(s => [s.etf, []]));
  for (let off = PRESSURE_HISTORY_DAYS; off >= 0; off--) {
    const comps = available.map(s => {
      const h = histories.get(s.etf)!;
      return componentsAt(h.closes, h.volumes, spy, off);
    });
    const isCurrent = off === 0;
    const bZ  = isCurrent && Object.keys(breadthScores).length >= 4
      ? zScores(available.map(s => breadthScores[s.etf] != null ? breadthScores[s.etf] - 50 : null))
      : null;
    const bcZ = isCurrent && Object.values(breadthChanges).some(v => v != null)
      ? zScores(available.map(s => breadthChanges[s.etf] ?? null))
      : null;
    const dayPressures = pressureFromComponents(comps, bZ, bcZ);
    available.forEach((s, i) => seriesByEtf.get(s.etf)!.push(dayPressures[i]));
  }

  // Rotation Score inputs (cross-sectional percentiles)
  const cur = available.map(s => {
    const h = histories.get(s.etf)!;
    return { s, h, c: componentsAt(h.closes, h.volumes, spy, 0) };
  });
  const p5   = percentiles(cur.map(x => retN(x.h.closes, 5)));
  const p1m  = percentiles(cur.map(x => retN(x.h.closes, 21)));
  const p3m  = percentiles(cur.map(x => retN(x.h.closes, 63)));
  const pRs  = percentiles(cur.map(x => {
    const sr = retN(x.h.closes, 21), br = retN(spy, 21);
    return sr != null && br != null ? sr - br : null;
  }));
  const pVol = percentiles(cur.map(x => x.c.volumeConfirm));
  const pAcc = percentiles(cur.map(x =>
    x.c.accelShort != null && x.c.accelMedium != null ? x.c.accelShort * 0.6 + x.c.accelMedium * 0.4 : null));

  const SW = ROTATION_SCORE_WEIGHTS;

  return cur.map(({ s, h, c }, i) => {
    const closes = h.closes;

    const ret: SectorMetrics['ret'] = {};
    (Object.keys(TIMEFRAME_DAYS) as Timeframe[]).forEach(tf => {
      ret[tf] = retN(closes, TIMEFRAME_DAYS[tf]);
    });

    const rs: SectorMetrics['rs'] = {};
    (['5D', '1M', '3M', '6M'] as const).forEach(tf => {
      const sr = retN(closes, TIMEFRAME_DAYS[tf]);
      const br = retN(spy, TIMEFRAME_DAYS[tf]);
      rs[tf] = sr != null && br != null ? sr - br : null;
    });

    const blendAccel = c.accelShort != null && c.accelMedium != null
      ? c.accelShort * 0.6 + c.accelMedium * 0.4 : null;
    const momentum: MomentumState =
      blendAccel == null ? 'STEADY'
      : blendAccel > MOMENTUM_THRESHOLDS.accelerating ? 'ACCELERATING'
      : blendAccel < MOMENTUM_THRESHOLDS.decelerating ? 'DECELERATING'
      : 'STEADY';

    const series = seriesByEtf.get(s.etf)!;
    const pressure = series[series.length - 1];
    const delta = (n: number): number | null =>
      series.length > n ? pressure - series[series.length - 1 - n] : null;
    const pressureDelta = { d1: delta(1), d5: delta(5), d20: delta(20) };
    const trendArrow: TrendArrow =
      (pressureDelta.d5 ?? 0) > PRESSURE_TREND_THRESHOLDS.up ? 'up'
      : (pressureDelta.d5 ?? 0) < PRESSURE_TREND_THRESHOLDS.down ? 'down'
      : 'flat';

    const bRaw = breadthRaw.get(s.etf) ?? null;
    const breadth: BreadthInfo | null = bRaw
      ? { ...bRaw, change: breadthChanges[s.etf] ?? null }
      : null;

    // Rotation Score
    const totalSW = SW.mom5D + SW.mom1M + SW.mom3M + SW.rsVsSpy + SW.volume + SW.acceleration + SW.breadth;
    const breadthPart = breadth ? breadth.score : 50;
    const score = Math.round(
      (p5[i] * SW.mom5D + p1m[i] * SW.mom1M + p3m[i] * SW.mom3M + pRs[i] * SW.rsVsSpy
       + pVol[i] * SW.volume + pAcc[i] * SW.acceleration + breadthPart * SW.breadth) / totalSW
    );

    const T = ROTATION_THRESHOLDS;
    const classification: Classification =
      score >= T.leading ? 'Leading'
      : score >= T.improving ? 'Improving'
      : score >= T.neutral ? 'Neutral'
      : score >= T.weakening ? 'Weakening'
      : 'Lagging';

    const px    = closes[closes.length - 1];
    const ma50  = sma(closes, 50);
    const ma200 = sma(closes, 200);
    const above50  = ma50  != null ? px > ma50  : null;
    const above200 = ma200 != null ? px > ma200 : null;

    // Matrix coordinates + trails
    const matrix = {} as SectorMetrics['matrix'];
    (['1M', '3M', '6M'] as MatrixTimeframe[]).forEach(tf => {
      const days = TIMEFRAME_DAYS[tf];
      const pointAt = (off: number): MatrixPoint | null => {
        const sr = retN(closes, days, off);
        const br = retN(spy, days, off);
        if (sr == null || br == null) return null;
        const y = (sr - br) * 100;
        const i2 = closes.length - 1 - off;
        const j2 = spy.length - 1 - off;
        const step = Math.max(5, Math.round(days / 4));
        const i1 = i2 - step, j1 = j2 - step;
        if (i1 < 0 || j1 < 0 || spy[j1] === 0 || spy[j2] === 0 || closes[i1] === 0) return null;
        const rNow = closes[i2] / spy[j2];
        const rPrev = closes[i1] / spy[j1];
        const x = (rNow / rPrev - 1) * 100;
        return { x, y };
      };
      const current = pointAt(0) ?? { x: 0, y: 0 };
      const trail: MatrixPoint[] = [];
      for (let k = MATRIX_TRAIL.points; k >= 1; k--) {
        const p = pointAt(k * MATRIX_TRAIL.stepDays);
        if (p) trail.push(p);
      }
      matrix[tf] = { ...current, trail };
    });

    const m: SectorMetrics = {
      def: s, etf: s.etf, name: s.name, price: h.price,
      ret, rs,
      rsChange1M: c.rsChange1M,
      accelShort: c.accelShort, accelMedium: c.accelMedium,
      momentum,
      volumeRatio: c.volumeConfirm != null ? c.volumeConfirm + 1 : null,
      above50, above200,
      breadth,
      pressure, pressureSeries: series, pressureDelta, trendArrow,
      score, classification,
      signal: null,
      matrix,
    };
    m.signal = deriveSignal(m);
    return m;
  });
}

// ── signals ──────────────────────────────────────────────────────────────────

function pct(x: number | null | undefined, d = 1): string {
  return x == null ? 'N/A' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
}

function deriveSignal(m: SectorMetrics): SignalInfo | null {
  const S = SIGNAL_THRESHOLDS;
  const reasons: string[] = [];
  const rsImproving = (m.rsChange1M ?? 0) > 0;
  const accel = m.momentum === 'ACCELERATING';
  const breadthUp = m.breadth?.change != null && m.breadth.change > 0;
  const shortBeatsMedium = (m.ret['5D'] ?? 0) / 5 > (m.ret['1M'] ?? 0) / 21;

  const addCommon = () => {
    if (m.rsChange1M != null) reasons.push(`Relative strength vs SPY ${rsImproving ? 'improving' : 'deteriorating'} (${pct(m.rsChange1M)} over 1M)`);
    reasons.push(`5D momentum ${m.momentum.toLowerCase()} (5D ${pct(m.ret['5D'])}, 1M ${pct(m.ret['1M'])})`);
    if (m.breadth) {
      reasons.push(`Top-holdings breadth ${m.breadth.score}${m.breadth.change != null ? ` (${m.breadth.change >= 0 ? '+' : ''}${m.breadth.change} vs last snapshot)` : ''} · ${m.breadth.above50Pct}% above 50DMA`);
    }
    if (m.volumeRatio != null) reasons.push(`Volume ${m.volumeRatio.toFixed(2)}x vs 20-day average`);
  };

  if (m.pressure >= S.strongIn) {
    addCommon();
    return { label: 'STRONG ROTATION IN', direction: 'in', reasons };
  }
  if (m.pressure >= S.rotationIn) {
    const early = m.score < ROTATION_THRESHOLDS.improving && rsImproving && accel && shortBeatsMedium;
    addCommon();
    if (early) reasons.push('Short-term performance stronger than medium-term — early-stage characteristics');
    return { label: early ? 'EARLY ROTATION' : 'IMPROVING', direction: 'in', reasons };
  }
  if (m.pressure <= S.strongOut) {
    addCommon();
    return { label: 'STRONG ROTATION OUT', direction: 'out', reasons };
  }
  if (m.pressure <= S.rotationOut) {
    const weakLeader = m.score >= ROTATION_THRESHOLDS.improving;
    addCommon();
    if (weakLeader) reasons.push('Historically strong sector now losing relative strength and momentum');
    return { label: weakLeader ? 'LEADERSHIP WEAKENING' : 'ROTATION OUT', direction: 'out', reasons };
  }
  if (m.score >= ROTATION_THRESHOLDS.leading) {
    addCommon();
    return { label: 'HOLDING LEADERSHIP', direction: 'hold', reasons };
  }
  void breadthUp;
  return null;
}

// ── market regime ────────────────────────────────────────────────────────────

export function computeRegime(metrics: SectorMetrics[]): MarketRegime | null {
  if (metrics.length < 6) return null;
  const cyc = metrics.filter(m => m.def.cyclical);
  const def = metrics.filter(m => !m.def.cyclical);
  const cycAvg = mean(cyc.map(m => m.pressure));
  const defAvg = mean(def.map(m => m.pressure));
  const spread = cycAvg - defAvg;
  const regime: MarketRegime['regime'] = spread > 12 ? 'Risk-On' : spread < -12 ? 'Risk-Off' : 'Mixed';

  const byScore    = [...metrics].sort((a, b) => b.score - a.score);
  const byDelta5   = [...metrics].sort((a, b) => (b.pressureDelta.d5 ?? -999) - (a.pressureDelta.d5 ?? -999));
  const weakLeaders = metrics
    .filter(m => m.score >= ROTATION_THRESHOLDS.improving && m.pressure < 0)
    .sort((a, b) => a.pressure - b.pressure);

  const rsPositive = metrics.filter(m => (m.rs['1M'] ?? 0) > 0).length;

  return {
    regime,
    leader: byScore[0]?.name ?? null,
    fastestImproving: byDelta5[0]?.name ?? null,
    weakeningLeader: weakLeaders[0]?.name ?? null,
    lagging: byScore[byScore.length - 1]?.name ?? null,
    breadthPct: Math.round((rsPositive / metrics.length) * 100),
  };
}

// ── opportunities ────────────────────────────────────────────────────────────

export function computeOpportunities(
  metrics: SectorMetrics[],
  quotes: Map<string, ConstituentQuote>,
): Opportunity[] {
  const out: Opportunity[] = [];

  const participants = (m: SectorMetrics): string[] =>
    m.def.constituents
      .map(t => quotes.get(t))
      .filter((q): q is ConstituentQuote =>
        !!q && q.price != null && q.ma50 != null && q.price > q.ma50 && (q.changePct ?? 0) > 0)
      .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
      .slice(0, 3)
      .map(q => q.symbol);

  for (const m of metrics) {
    const sig = m.signal;
    if (sig?.label === 'EARLY ROTATION') {
      out.push({ category: 'EARLY ROTATION', direction: 'in', etf: m.etf, name: m.name, score: m.score, pressure: m.pressure, reasons: sig.reasons, participants: participants(m) });
    } else if (m.score >= ROTATION_THRESHOLDS.leading && m.momentum === 'ACCELERATING') {
      out.push({ category: 'ACCELERATING LEADER', direction: 'in', etf: m.etf, name: m.name, score: m.score, pressure: m.pressure, reasons: sig?.reasons ?? [], participants: participants(m) });
    } else if (m.score >= ROTATION_THRESHOLDS.leading && m.pressure >= 0) {
      out.push({ category: 'STRONG LEADER', direction: 'in', etf: m.etf, name: m.name, score: m.score, pressure: m.pressure, reasons: sig?.reasons ?? [], participants: participants(m) });
    } else if (m.score >= 75 && (m.ret['5D'] ?? 0) < -0.015 && m.above50 === true) {
      out.push({ category: 'PULLBACK IN LEADING SECTOR', direction: 'in', etf: m.etf, name: m.name, score: m.score, pressure: m.pressure, reasons: [`5D ${pct(m.ret['5D'])} pullback while still above 50DMA with score ${m.score}`], participants: participants(m) });
    } else if (sig?.label === 'LEADERSHIP WEAKENING') {
      out.push({ category: 'LEADERSHIP DETERIORATING', direction: 'out', etf: m.etf, name: m.name, score: m.score, pressure: m.pressure, reasons: sig.reasons, participants: [] });
    } else if (sig?.label === 'STRONG ROTATION OUT') {
      out.push({ category: 'ROTATION OUT', direction: 'out', etf: m.etf, name: m.name, score: m.score, pressure: m.pressure, reasons: sig.reasons, participants: [] });
    }
  }

  return out
    .sort((a, b) => Math.abs(b.pressure) - Math.abs(a.pressure))
    .slice(0, 10);
}
