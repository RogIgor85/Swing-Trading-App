// ─────────────────────────────────────────────────────────────────────────────
// Sector Rotation — scoring engine. Pure calculations, no fetching, no UI.
//
// Rotation Pressure (−100…+100): direction current evidence suggests rotation
//   is moving. Cross-sectional z-scores of momentum/RS-change/breadth/volume/
//   trend components, weight-summed (weights in sectorConfig). Components with
//   no data are DROPPED and remaining weights renormalized — missing data is
//   never treated as zero/bearish.
// Rotation Score (0–100): overall sector strength via cross-sectional
//   percentiles of level metrics (same renormalization rule).
// Neither metric represents literal dollar fund flows.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SECTOR_ETFS, BENCHMARK_ETF, ROTATION_PRESSURE_WEIGHTS, ROTATION_SCORE_WEIGHTS,
  ROTATION_THRESHOLDS, MOMENTUM_THRESHOLDS, PRESSURE_TREND_THRESHOLDS,
  SIGNAL_THRESHOLDS, BREADTH_SETTINGS, MATRIX_TRAIL, TIMEFRAME_DAYS,
  PARTICIPATION_WEIGHTS, OPPORTUNITY_THRESHOLDS,
} from '../../config/sectorConfig';
import type { SectorDef, MatrixTimeframe, Timeframe } from '../../config/sectorConfig';
import type { EtfHistory, ConstituentQuote } from './sectorData';

export type Classification = 'Leading' | 'Improving' | 'Neutral' | 'Weakening' | 'Lagging';
export type MomentumState  = 'ACCELERATING' | 'STEADY' | 'DECELERATING';
export type TrendArrow     = 'up' | 'flat' | 'down';

export interface BreadthInfo {
  score: number;
  above20Pct: number | null;
  above50Pct: number | null;
  above200Pct: number | null;
  pos5DPct: number | null;
  pos20DPct: number | null;
  positiveTodayPct: number | null;
  count: number;
  change: number | null; // score now vs ~5 trading days ago (real history)
  source: 'history' | 'quotes';
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
  rs: Partial<Record<'5D' | '1M' | '3M' | '6M', number | null>>;
  rsChange1M: number | null;
  accelShort: number | null;
  accelMedium: number | null;
  momentum: MomentumState;
  volumeRatio: number | null;
  above50: boolean | null;
  above200: boolean | null;
  breadth: BreadthInfo | null;
  pressure: number;
  pressureSeries: number[];
  pressureDelta: { d1: number | null; d5: number | null; d20: number | null };
  trendArrow: TrendArrow;
  score: number;
  classification: Classification;
  signal: SignalInfo | null;
  matrix: Record<MatrixTimeframe, { x: number; y: number; trail: MatrixPoint[] }>;
}

export interface MarketRegime {
  regime: 'Risk-On' | 'Risk-Off' | 'Mixed';
  reason: string;
  leader: string | null;
  fastestImproving: string | null;
  weakeningLeader: string | null;
  weakeningLeaderDetail: string | null;
  lagging: string | null;
  breadthPct: number | null;
  positiveCount: number;
  totalCount: number;
}

export interface Opportunity {
  category: string;
  direction: 'in' | 'out';
  etf: string;
  name: string;
  score: number;
  pressure: number;
  pressureDelta5: number | null;
  breadth: number | null;
  breadthChange: number | null;
  momentum: MomentumState;
  reasons: string[];
  participants: string[];
}

export interface ConstituentRow {
  symbol: string;
  name: string;
  price: number | null;
  marketCap: number | null;
  ret1D: number | null;     // decimals
  ret5D: number | null;
  ret1M: number | null;
  ret3M: number | null;
  rsVsSector1M: number | null;
  rsVsSpy1M: number | null;
  volRatio: number | null;
  above20: boolean | null;
  above50: boolean | null;
  above200: boolean | null;
  forwardPE: number | null;
  epsTTM: number | null;
  earningsTs: number | null;
  participation: number | null; // 0–100
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

function percentiles(xs: (number | null)[]): (number | null)[] {
  const idx = xs.map((x, i) => ({ x, i })).filter(p => p.x != null && isFinite(p.x as number));
  const sorted = [...idx].sort((a, b) => (a.x as number) - (b.x as number));
  const out: (number | null)[] = xs.map(() => null);
  sorted.forEach((p, rank) => { out[p.i] = sorted.length > 1 ? (rank / (sorted.length - 1)) * 100 : 50; });
  return out;
}

/** Quadrant label matching the on-screen matrix layout. */
export function quadrantOf(x: number, y: number): Classification | 'Lagging' {
  if (y >= 0) return x >= 0 ? 'Leading' : 'Improving';
  return x >= 0 ? 'Weakening' : 'Lagging';
}

// ── breadth from constituent close history ───────────────────────────────────

interface BreadthComponents {
  above20: number | null;
  above50: number | null;
  above200: number | null;
  pos5D: number | null;
  pos20D: number | null;
}

function breadthComponentsAt(
  def: SectorDef,
  closesMap: Map<string, number[]>,
  offset: number,
): { comps: BreadthComponents; count: number } | null {
  const lists = def.constituents.map(t => closesMap.get(t)).filter((c): c is number[] => !!c && c.length > offset + 25);
  if (lists.length < BREADTH_SETTINGS.minConstituents) return null;

  const frac = (test: (c: number[]) => boolean | null): number | null => {
    let yes = 0, n = 0;
    for (const c of lists) {
      const r = test(c);
      if (r == null) continue;
      n++;
      if (r) yes++;
    }
    return n >= BREADTH_SETTINGS.minConstituents ? yes / n : null;
  };

  const px = (c: number[]) => c[c.length - 1 - offset];
  return {
    count: lists.length,
    comps: {
      above20:  frac(c => { const m = sma(c, 20, offset);  return m == null ? null : px(c) > m; }),
      above50:  frac(c => { const m = sma(c, 50, offset);  return m == null ? null : px(c) > m; }),
      above200: frac(c => { const m = sma(c, 200, offset); return m == null ? null : px(c) > m; }),
      pos5D:    frac(c => { const r = retN(c, 5, offset);  return r == null ? null : r > 0; }),
      pos20D:   frac(c => { const r = retN(c, 20, offset); return r == null ? null : r > 0; }),
    },
  };
}

function breadthScoreFrom(comps: BreadthComponents): number | null {
  const W = BREADTH_SETTINGS.weights;
  const parts: Array<[number | null, number]> = [
    [comps.above20, W.above20], [comps.above50, W.above50], [comps.above200, W.above200],
    [comps.pos5D, W.pos5D], [comps.pos20D, W.pos20D],
  ];
  let sum = 0, wSum = 0;
  for (const [v, w] of parts) {
    if (v == null) continue; // renormalize — missing component never counts as 0
    sum += v * w;
    wSum += w;
  }
  if (wSum === 0) return null;
  return Math.round((sum / wSum) * 100);
}

/** Fallback breadth from current batch quotes only (no history available). */
function breadthFromQuotes(def: SectorDef, quotes: Map<string, ConstituentQuote>): BreadthInfo | null {
  const qs = def.constituents.map(t => quotes.get(t)).filter((q): q is ConstituentQuote => !!q && q.price != null);
  if (qs.length < BREADTH_SETTINGS.minConstituents) return null;
  const above50  = qs.filter(q => q.ma50 != null  && q.price! > q.ma50!).length / qs.length;
  const above200 = qs.filter(q => q.ma200 != null && q.price! > q.ma200!).length / qs.length;
  const posToday = qs.filter(q => (q.changePct ?? 0) > 0).length / qs.length;
  const w = BREADTH_SETTINGS.quoteFallbackWeights;
  return {
    score: Math.round((above50 * w.above50 + above200 * w.above200 + posToday * w.positiveToday) * 100),
    above20Pct: null,
    above50Pct: Math.round(above50 * 100),
    above200Pct: Math.round(above200 * 100),
    pos5DPct: null, pos20DPct: null,
    positiveTodayPct: Math.round(posToday * 100),
    count: qs.length,
    change: null,
    source: 'quotes',
  };
}

// ── pressure components ──────────────────────────────────────────────────────

interface PressureComponents {
  rsChange1M: number | null;
  rsChange5D: number | null;
  accelShort: number | null;
  accelMedium: number | null;
  shortMomentum: number | null;
  mediumMomentum: number | null;
  volumeConfirm: number | null;
  trend: number | null;
  breadthLevel: number | null;
  breadthChange: number | null;
}

function componentsAt(sec: number[], vol: number[], spy: number[], endOffset: number): Omit<PressureComponents, 'breadthLevel' | 'breadthChange'> {
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

  let volumeConfirm: number | null = null;
  const vEnd = vol.length - endOffset;
  if (vEnd - 25 >= 0) {
    const v5  = mean(vol.slice(vEnd - 5, vEnd));
    const v20 = mean(vol.slice(vEnd - 25, vEnd - 5));
    if (v20 > 0) volumeConfirm = v5 / v20 - 1;
  }

  let trend: number | null = null;
  const px = sec[sec.length - 1 - endOffset];
  const ma50  = sma(sec, 50, endOffset);
  const ma200 = sma(sec, 200, endOffset);
  if (px != null && ma50 != null) {
    let t = px > ma50 ? 1 : 0;
    if (ma200 != null) {
      t += px > ma200 ? 1 : 0;
      t += ma50 > ma200 ? 1 : 0;
      trend = t / 1.5 - 1;
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

/**
 * Cross-sectional pressure for one day. Components where fewer than 2 sectors
 * report data are dropped entirely and the weight pool renormalized.
 */
function pressuresForDay(all: PressureComponents[]): number[] {
  const W = ROTATION_PRESSURE_WEIGHTS;
  const keys = Object.keys(W) as (keyof PressureComponents)[];
  const active: Array<{ z: number[]; w: number }> = [];
  for (const k of keys) {
    const vals = all.map(c => c[k]);
    if (vals.filter(v => v != null && isFinite(v)).length < 2) continue; // drop, renormalize
    active.push({ z: zScores(vals), w: W[k as keyof typeof W] });
  }
  const totalW = active.reduce((s, a) => s + a.w, 0) || 1;
  return all.map((_, i) => {
    const sum = active.reduce((s, a) => s + a.z[i] * a.w, 0);
    return Math.round(Math.max(-100, Math.min(100, (sum / totalW) * 40)));
  });
}

// ── main computation ─────────────────────────────────────────────────────────

const PRESSURE_HISTORY_DAYS = 40;

export function computeSectorMetrics(
  histories: Map<string, EtfHistory>,
  constituentQuotes: Map<string, ConstituentQuote>,
  constituentCloses: Map<string, number[]> = new Map(),
): SectorMetrics[] {
  const spyH = histories.get(BENCHMARK_ETF);
  if (!spyH) return [];
  const spy = spyH.closes;

  const available = SECTOR_ETFS.filter(s => histories.has(s.etf));

  // Breadth score series per sector (from real constituent history when we
  // have it). breadthSeries[etf][k] = score at offset (PRESSURE_HISTORY_DAYS − k).
  const lookback = BREADTH_SETTINGS.changeLookbackDays;
  const breadthSeries = new Map<string, (number | null)[]>();
  const breadthCurrent = new Map<string, BreadthInfo | null>();
  for (const s of available) {
    const series: (number | null)[] = [];
    for (let off = PRESSURE_HISTORY_DAYS; off >= 0; off--) {
      const b = breadthComponentsAt(s, constituentCloses, off);
      series.push(b ? breadthScoreFrom(b.comps) : null);
    }
    breadthSeries.set(s.etf, series);

    const nowB = breadthComponentsAt(s, constituentCloses, 0);
    if (nowB) {
      const score = breadthScoreFrom(nowB.comps);
      const prev = series.length > lookback ? series[series.length - 1 - lookback] : null;
      breadthCurrent.set(s.etf, score == null ? null : {
        score,
        above20Pct:  nowB.comps.above20  != null ? Math.round(nowB.comps.above20 * 100)  : null,
        above50Pct:  nowB.comps.above50  != null ? Math.round(nowB.comps.above50 * 100)  : null,
        above200Pct: nowB.comps.above200 != null ? Math.round(nowB.comps.above200 * 100) : null,
        pos5DPct:    nowB.comps.pos5D    != null ? Math.round(nowB.comps.pos5D * 100)    : null,
        pos20DPct:   nowB.comps.pos20D   != null ? Math.round(nowB.comps.pos20D * 100)   : null,
        positiveTodayPct: null,
        count: nowB.count,
        change: prev != null && score != null ? score - prev : null,
        source: 'history',
      });
    } else {
      breadthCurrent.set(s.etf, breadthFromQuotes(s, constituentQuotes));
    }
  }

  // Pressure series with breadth level/change as historical components
  const seriesByEtf = new Map<string, number[]>(available.map(s => [s.etf, []]));
  for (let off = PRESSURE_HISTORY_DAYS; off >= 0; off--) {
    const k = PRESSURE_HISTORY_DAYS - off;
    const comps: PressureComponents[] = available.map(s => {
      const h = histories.get(s.etf)!;
      const base = componentsAt(h.closes, h.volumes, spy, off);
      const bs = breadthSeries.get(s.etf)!;
      const bNow  = bs[k] ?? null;
      const bPrev = k - lookback >= 0 ? bs[k - lookback] : null;
      return {
        ...base,
        breadthLevel:  bNow != null ? bNow - 50 : null,
        breadthChange: bNow != null && bPrev != null ? bNow - bPrev : null,
      };
    });
    const dayPressures = pressuresForDay(comps);
    available.forEach((s, i) => seriesByEtf.get(s.etf)!.push(dayPressures[i]));
  }

  // Rotation Score inputs (cross-sectional percentiles, renormalized)
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

    const breadth = breadthCurrent.get(s.etf) ?? null;

    // Rotation Score — drop unavailable parts and renormalize
    const parts: Array<[number | null, number]> = [
      [p5[i], SW.mom5D], [p1m[i], SW.mom1M], [p3m[i], SW.mom3M], [pRs[i], SW.rsVsSpy],
      [pVol[i], SW.volume], [pAcc[i], SW.acceleration],
      [breadth ? breadth.score : null, SW.breadth],
    ];
    let scoreSum = 0, scoreW = 0;
    for (const [v, w] of parts) {
      if (v == null) continue;
      scoreSum += v * w;
      scoreW += w;
    }
    const score = scoreW > 0 ? Math.round(scoreSum / scoreW) : 50;

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
  const shortBeatsMedium = (m.ret['5D'] ?? 0) / 5 > (m.ret['1M'] ?? 0) / 21;

  const addCommon = () => {
    if (m.rsChange1M != null) reasons.push(`Relative strength vs SPY ${rsImproving ? 'improving' : 'deteriorating'} (${pct(m.rsChange1M)} over 1M)`);
    reasons.push(`5D momentum ${m.momentum.toLowerCase()} (5D ${pct(m.ret['5D'])}, 1M ${pct(m.ret['1M'])})`);
    if (m.breadth) {
      const b = m.breadth;
      if (b.change != null) {
        reasons.push(`Breadth ${b.change >= 0 ? 'increased' : 'decreased'} ${b.score - b.change} → ${b.score}`);
      } else {
        reasons.push(`Breadth ${b.score}`);
      }
      if (b.above20Pct != null) reasons.push(`${b.above20Pct}% of tracked stocks above 20DMA`);
      else if (b.above50Pct != null) reasons.push(`${b.above50Pct}% of tracked stocks above 50DMA`);
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
  return null;
}

// ── market regime ────────────────────────────────────────────────────────────

export function computeRegime(metrics: SectorMetrics[]): MarketRegime | null {
  if (metrics.length < 6) return null;
  const cyc = metrics.filter(m => m.def.cyclical);
  const def = metrics.filter(m => !m.def.cyclical);
  const cycAvg = mean(cyc.map(m => m.pressure));
  const defAvg = mean(def.map(m => m.pressure));
  const spread = Math.round(cycAvg - defAvg);
  const posCount = metrics.filter(m => m.pressure > 0).length;
  const total = metrics.length;
  const rsPositive = metrics.filter(m => (m.rs['1M'] ?? 0) > 0).length;
  const breadthPct = Math.round((rsPositive / total) * 100);

  // Deterministic rules
  let regime: MarketRegime['regime'];
  if (spread > 10 && posCount >= Math.ceil(total * 0.55)) regime = 'Risk-On';
  else if (spread < -10 && posCount <= Math.floor(total * 0.45)) regime = 'Risk-Off';
  else regime = 'Mixed';

  const reasonParts = [
    `${posCount}/${total} sectors positive pressure`,
    `${breadthPct}% outperforming SPY (1M)`,
    spread > 5 ? `cyclicals leading defensives (+${spread})`
      : spread < -5 ? `defensives leading cyclicals (${spread})`
      : `cyclicals ≈ defensives (${spread >= 0 ? '+' : ''}${spread})`,
  ];

  const byScore  = [...metrics].sort((a, b) => b.score - a.score);
  const byDelta5 = [...metrics].sort((a, b) => (b.pressureDelta.d5 ?? -999) - (a.pressureDelta.d5 ?? -999));

  // Weakening Leader: still relatively strong (score) but pressure negative
  // or falling fast — a leader losing its bid.
  const weakLeaders = metrics
    .filter(m => m.score >= ROTATION_THRESHOLDS.improving
      && (m.pressure < -15 || (m.pressureDelta.d5 ?? 0) < -20))
    .sort((a, b) => (a.pressure + (a.pressureDelta.d5 ?? 0)) - (b.pressure + (b.pressureDelta.d5 ?? 0)));
  const wl = weakLeaders[0] ?? null;

  return {
    regime,
    reason: reasonParts.join(' · '),
    leader: byScore[0]?.name ?? null,
    fastestImproving: byDelta5[0]?.name ?? null,
    weakeningLeader: wl?.name ?? null,
    weakeningLeaderDetail: wl
      ? `Score ${wl.score}, pressure ${wl.pressure >= 0 ? '+' : ''}${wl.pressure}${wl.pressureDelta.d5 != null ? `, Δ5D ${wl.pressureDelta.d5 >= 0 ? '+' : ''}${wl.pressureDelta.d5}` : ''}`
      : null,
    lagging: byScore[byScore.length - 1]?.name ?? null,
    breadthPct,
    positiveCount: posCount,
    totalCount: total,
  };
}

// ── opportunities ────────────────────────────────────────────────────────────

export function computeOpportunities(
  metrics: SectorMetrics[],
  quotes: Map<string, ConstituentQuote>,
  constituentCloses: Map<string, number[]> = new Map(),
): Opportunity[] {
  const O = OPPORTUNITY_THRESHOLDS;

  const participants = (m: SectorMetrics): string[] => {
    // Prefer quote data; fall back to close-history-derived participation
    const rows = m.def.constituents.map(t => {
      const q = quotes.get(t);
      const closes = constituentCloses.get(t);
      const ret1M = closes ? retN(closes, 21) : null;
      const above50 = q?.price != null && q.ma50 != null ? q.price > q.ma50
        : closes ? (() => { const ma = sma(closes, 50); return ma != null ? closes[closes.length - 1] > ma : null; })()
        : null;
      const chg = q?.changePct != null ? q.changePct / 100 : (closes ? retN(closes, 1) : null);
      return { t, ret1M, above50, chg };
    });
    return rows
      .filter(r => r.above50 === true && ((r.ret1M ?? 0) > 0 || (r.chg ?? 0) > 0))
      .sort((a, b) => (b.ret1M ?? b.chg ?? 0) - (a.ret1M ?? a.chg ?? 0))
      .slice(0, 3)
      .map(r => r.t);
  };

  // One card per sector — pick the highest-priority category that applies
  const cards: Opportunity[] = [];
  for (const m of metrics) {
    const base = {
      etf: m.etf, name: m.name, score: m.score, pressure: m.pressure,
      pressureDelta5: m.pressureDelta.d5,
      breadth: m.breadth?.score ?? null,
      breadthChange: m.breadth?.change ?? null,
      momentum: m.momentum,
    };
    const sig = m.signal;
    let card: Opportunity | null = null;

    if (sig?.label === 'EARLY ROTATION') {
      card = { ...base, category: 'EARLY ROTATION', direction: 'in', reasons: sig.reasons, participants: participants(m) };
    } else if (m.score >= O.acceleratingLeaderScore && m.momentum === 'ACCELERATING') {
      card = { ...base, category: 'ACCELERATING LEADER', direction: 'in', reasons: sig?.reasons ?? [`Score ${m.score} with accelerating momentum`], participants: participants(m) };
    } else if (m.breadth?.change != null && m.breadth.change >= O.improvingBreadthChange && m.pressure > 0) {
      card = { ...base, category: 'IMPROVING BREADTH', direction: 'in', reasons: [`Breadth expanded ${m.breadth.score - m.breadth.change} → ${m.breadth.score} — participation spreading`, ...(sig?.reasons.slice(0, 2) ?? [])], participants: participants(m) };
    } else if (m.score >= O.strongLeaderScore && m.pressure >= 0) {
      card = { ...base, category: 'STRONG LEADER', direction: 'in', reasons: sig?.reasons ?? [`Score ${m.score} with positive pressure`], participants: participants(m) };
    } else if (m.score >= O.pullbackScore && (m.ret['5D'] ?? 0) < O.pullback5D && m.above50 === true) {
      card = { ...base, category: 'PULLBACK IN LEADER', direction: 'in', reasons: [`5D ${pct(m.ret['5D'])} pullback while still above 50DMA with score ${m.score}`], participants: participants(m) };
    } else if (sig?.label === 'LEADERSHIP WEAKENING') {
      card = { ...base, category: 'LEADERSHIP DETERIORATING', direction: 'out', reasons: sig.reasons, participants: [] };
    } else if (sig?.label === 'STRONG ROTATION OUT') {
      card = { ...base, category: 'STRONG ROTATION OUT', direction: 'out', reasons: sig.reasons, participants: [] };
    } else if (m.pressure <= O.rotationOutPressure) {
      card = { ...base, category: 'ROTATION OUT', direction: 'out', reasons: sig?.reasons ?? [`Pressure ${m.pressure} with ${m.momentum.toLowerCase()} momentum`], participants: [] };
    }

    if (card) cards.push(card);
  }

  return cards
    .sort((a, b) => Math.abs(b.pressure) + Math.abs(b.pressureDelta5 ?? 0) - (Math.abs(a.pressure) + Math.abs(a.pressureDelta5 ?? 0)))
    .slice(0, O.maxCards);
}

// ── constituent rows for drill-down ──────────────────────────────────────────

export function computeConstituentRows(
  def: SectorDef,
  sectorCloses: number[] | null,
  spyCloses: number[] | null,
  quotes: Map<string, ConstituentQuote>,
  constituentCloses: Map<string, number[]>,
): ConstituentRow[] {
  const secRet1M = sectorCloses ? retN(sectorCloses, 21) : null;
  const spyRet1M = spyCloses ? retN(spyCloses, 21) : null;

  const rows = def.constituents.map((t): ConstituentRow | null => {
    const q = quotes.get(t) ?? null;
    const closes = constituentCloses.get(t) ?? null;
    if (!q && !closes) return null;

    const price = q?.price ?? (closes ? closes[closes.length - 1] : null);
    const ret1D = q?.changePct != null ? q.changePct / 100 : (closes ? retN(closes, 1) : null);
    const ret5D = closes ? retN(closes, 5) : null;
    const ret1M = closes ? retN(closes, 21) : null;
    const ret3M = closes ? retN(closes, 63) : null;

    const maStatus = (n: 20 | 50 | 200): boolean | null => {
      if (closes) {
        const m = sma(closes, n);
        return m != null ? closes[closes.length - 1] > m : null;
      }
      if (q?.price != null) {
        if (n === 50 && q.ma50 != null) return q.price > q.ma50;
        if (n === 200 && q.ma200 != null) return q.price > q.ma200;
      }
      return null;
    };

    return {
      symbol: t,
      name: q?.name ?? t,
      price,
      marketCap: q?.marketCap ?? null,
      ret1D, ret5D, ret1M, ret3M,
      rsVsSector1M: ret1M != null && secRet1M != null ? ret1M - secRet1M : null,
      rsVsSpy1M:    ret1M != null && spyRet1M != null ? ret1M - spyRet1M : null,
      volRatio: q?.volume != null && q?.avgVolume3M ? q.volume / q.avgVolume3M : null,
      above20: maStatus(20), above50: maStatus(50), above200: maStatus(200),
      forwardPE: q?.forwardPE ?? null,
      epsTTM: q?.epsTTM ?? null,
      earningsTs: q?.earningsTs ?? null,
      participation: null,
    };
  }).filter((r): r is ConstituentRow => r != null);

  // Participation Score — cross-sectional percentiles within the sector,
  // missing components dropped and weights renormalized per stock
  const PW = PARTICIPATION_WEIGHTS;
  const pRsSec = percentiles(rows.map(r => r.rsVsSector1M));
  const pR1M   = percentiles(rows.map(r => r.ret1M));
  const pR5D   = percentiles(rows.map(r => r.ret5D));
  const pVolR  = percentiles(rows.map(r => r.volRatio));

  rows.forEach((r, i) => {
    const parts: Array<[number | null, number]> = [
      [pRsSec[i], PW.rsVsSector1M],
      [pR1M[i],   PW.ret1M],
      [pR5D[i],   PW.ret5D],
      [pVolR[i],  PW.volumeRatio],
      [r.above50 == null ? null : (r.above50 ? 100 : 0), PW.above50],
      [r.above200 == null ? null : (r.above200 ? 100 : 0), PW.above200],
    ];
    let sum = 0, w = 0;
    for (const [v, wt] of parts) {
      if (v == null) continue;
      sum += v * wt;
      w += wt;
    }
    r.participation = w > 0 ? Math.round(sum / w) : null;
  });

  return rows;
}
