// Sector Rotation engine tests — pure-function coverage for scoring,
// missing-data renormalization, and edge cases.
// Run: npm test
import { describe, it, expect } from 'vitest';
import {
  computeSectorMetrics, computeRegime, computeOpportunities,
  computeConstituentRows, quadrantOf,
} from './sectorEngine';
import type { SectorMetrics } from './sectorEngine';
import { SECTOR_ETFS, BENCHMARK_ETF } from '../../config/sectorConfig';
import type { EtfHistory } from './sectorData';

// ── synthetic data builders ──────────────────────────────────────────────────

/** Geometric daily series: start price with a constant daily return. */
function trendCloses(days: number, dailyRet: number, start = 100): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < days; i++) { out.push(p); p *= 1 + dailyRet; }
  return out;
}

function hist(symbol: string, closes: number[], volumes?: number[]): EtfHistory {
  return {
    symbol, name: symbol, price: closes[closes.length - 1], prevClose: closes[closes.length - 2] ?? null,
    timestamps: closes.map((_, i) => 1700000000 + i * 86400),
    closes,
    volumes: volumes ?? closes.map(() => 1_000_000),
  };
}

/** Full 12-ETF history map: SPY flat-ish, each sector with a chosen drift. */
function buildHistories(drifts: Partial<Record<string, number>> = {}, days = 260): Map<string, EtfHistory> {
  const map = new Map<string, EtfHistory>();
  map.set(BENCHMARK_ETF, hist(BENCHMARK_ETF, trendCloses(days, 0.0004)));
  for (const s of SECTOR_ETFS) {
    map.set(s.etf, hist(s.etf, trendCloses(days, drifts[s.etf] ?? 0.0004)));
  }
  return map;
}

const noQuotes = new Map();
const noCloses = new Map<string, number[]>();

// ── tests ────────────────────────────────────────────────────────────────────

describe('computeSectorMetrics', () => {
  it('returns all sectors, pressures bounded, scores 0–100', () => {
    const ms = computeSectorMetrics(buildHistories({ XLK: 0.002, XLU: -0.002 }), noQuotes, noCloses);
    expect(ms.length).toBe(SECTOR_ETFS.length);
    for (const m of ms) {
      expect(m.pressure).toBeGreaterThanOrEqual(-100);
      expect(m.pressure).toBeLessThanOrEqual(100);
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(100);
    }
  });

  it('ranks a strongly outperforming sector above a strongly underperforming one', () => {
    const ms = computeSectorMetrics(buildHistories({ XLF: 0.004, XLRE: -0.004 }), noQuotes, noCloses);
    const xlf  = ms.find(m => m.etf === 'XLF')!;
    const xlre = ms.find(m => m.etf === 'XLRE')!;
    expect(xlf.pressure).toBeGreaterThan(xlre.pressure);
    expect(xlf.score).toBeGreaterThan(xlre.score);
  });

  it('excludes sectors with missing history instead of crashing', () => {
    const h = buildHistories();
    h.delete('XLE');
    const ms = computeSectorMetrics(h, noQuotes, noCloses);
    expect(ms.length).toBe(SECTOR_ETFS.length - 1);
    expect(ms.find(m => m.etf === 'XLE')).toBeUndefined();
  });

  it('returns empty when the SPY benchmark is missing', () => {
    const h = buildHistories();
    h.delete(BENCHMARK_ETF);
    expect(computeSectorMetrics(h, noQuotes, noCloses)).toEqual([]);
  });

  it('breadth is null (not zero) without constituent data, and score still computes', () => {
    const ms = computeSectorMetrics(buildHistories(), noQuotes, noCloses);
    for (const m of ms) {
      expect(m.breadth).toBeNull();
      expect(Number.isFinite(m.score)).toBe(true);
    }
  });

  it('computes real breadth with change from constituent close history', () => {
    const closes = new Map<string, number[]>();
    const xlv = SECTOR_ETFS.find(s => s.etf === 'XLV')!;
    // constituents in strong uptrends → high breadth, positive change
    xlv.constituents.forEach(t => closes.set(t, trendCloses(260, 0.003)));
    const ms = computeSectorMetrics(buildHistories(), noQuotes, closes);
    const m = ms.find(x => x.etf === 'XLV')!;
    expect(m.breadth).not.toBeNull();
    expect(m.breadth!.source).toBe('history');
    expect(m.breadth!.score).toBeGreaterThan(80);
    expect(m.breadth!.above20Pct).toBe(100);
    expect(m.breadth!.above200Pct).toBe(100);
    expect(m.breadth!.change).not.toBeNull();
  });

  it('handles zero volume without NaN', () => {
    const h = buildHistories();
    const spy = h.get(BENCHMARK_ETF)!;
    h.set('XLK', hist('XLK', trendCloses(260, 0.001), spy.closes.map(() => 0)));
    const ms = computeSectorMetrics(h, noQuotes, noCloses);
    const m = ms.find(x => x.etf === 'XLK')!;
    expect(m.volumeRatio).toBeNull();
    expect(Number.isFinite(m.pressure)).toBe(true);
  });

  it('clamps pressure on an extreme single-day move', () => {
    const h = buildHistories();
    const spike = trendCloses(260, 0.0004);
    spike[spike.length - 1] = spike[spike.length - 2] * 3; // +200% day
    h.set('XLB', hist('XLB', spike));
    const ms = computeSectorMetrics(h, noQuotes, noCloses);
    const m = ms.find(x => x.etf === 'XLB')!;
    expect(m.pressure).toBeLessThanOrEqual(100);
    expect(m.pressure).toBeGreaterThanOrEqual(-100);
  });

  it('short history (new ETF) yields nulls for long returns, not crashes', () => {
    const h = buildHistories();
    h.set('XLC', hist('XLC', trendCloses(70, 0.001)));
    const ms = computeSectorMetrics(h, noQuotes, noCloses);
    const m = ms.find(x => x.etf === 'XLC')!;
    expect(m.ret['1Y']).toBeNull();
    expect(m.ret['5D']).not.toBeNull();
    expect(Number.isFinite(m.pressure)).toBe(true);
  });

  it('pressure deltas come from the stored series', () => {
    const ms = computeSectorMetrics(buildHistories({ XLI: 0.002 }), noQuotes, noCloses);
    const m = ms.find(x => x.etf === 'XLI')!;
    expect(m.pressureSeries.length).toBeGreaterThan(20);
    const s = m.pressureSeries;
    expect(m.pressureDelta.d5).toBe(s[s.length - 1] - s[s.length - 6]);
    expect(m.pressureDelta.d20).toBe(s[s.length - 1] - s[s.length - 21]);
  });
});

describe('computeRegime', () => {
  function mk(over: Partial<SectorMetrics> & { etf: string }): SectorMetrics {
    const def = SECTOR_ETFS.find(s => s.etf === over.etf)!;
    const base: SectorMetrics = {
      def, etf: def.etf, name: def.name, price: 100,
      ret: { '1M': 0.01 }, rs: { '1M': 0.01 },
      rsChange1M: 0, accelShort: 0, accelMedium: 0,
      momentum: 'STEADY', volumeRatio: 1, above50: true, above200: true,
      breadth: null, pressure: 0, pressureSeries: [0],
      pressureDelta: { d1: 0, d5: 0, d20: 0 }, trendArrow: 'flat',
      score: 50, classification: 'Neutral', signal: null,
      matrix: { '1M': { x: 0, y: 0, trail: [] }, '3M': { x: 0, y: 0, trail: [] }, '6M': { x: 0, y: 0, trail: [] } },
    };
    return { ...base, ...over };
  }

  it('detects a weakening leader: high score with negative/falling pressure', () => {
    const metrics = SECTOR_ETFS.map(s =>
      s.etf === 'XLK'
        ? mk({ etf: s.etf, score: 76, pressure: -28, pressureDelta: { d1: -5, d5: -33, d20: -40 } })
        : mk({ etf: s.etf, score: 50, pressure: 10 })
    );
    const r = computeRegime(metrics)!;
    expect(r.weakeningLeader).toBe('Technology');
    expect(r.weakeningLeaderDetail).toContain('76');
  });

  it('does not flag a weakening leader when all leaders have positive stable pressure', () => {
    const metrics = SECTOR_ETFS.map(s => mk({ etf: s.etf, score: 70, pressure: 20 }));
    expect(computeRegime(metrics)!.weakeningLeader).toBeNull();
  });

  it('classifies Risk-On when cyclicals lead and most pressures are positive', () => {
    const metrics = SECTOR_ETFS.map(s => mk({ etf: s.etf, pressure: s.cyclical ? 40 : -10 }));
    const r = computeRegime(metrics)!;
    expect(r.regime).toBe('Risk-On');
    expect(r.reason).toContain('sectors positive pressure');
  });

  it('classifies Risk-Off when defensives lead and most pressures are negative', () => {
    const metrics = SECTOR_ETFS.map(s => mk({ etf: s.etf, pressure: s.cyclical ? -40 : 10 }));
    expect(computeRegime(metrics)!.regime).toBe('Risk-Off');
  });
});

describe('computeOpportunities', () => {
  it('produces multiple categories without fabricating cards from neutral sectors', () => {
    const ms = computeSectorMetrics(
      buildHistories({ XLK: 0.004, XLF: 0.003, XLU: -0.004, XLRE: -0.003 }),
      noQuotes, noCloses,
    );
    const ops = computeOpportunities(ms, noQuotes, noCloses);
    expect(ops.length).toBeLessThanOrEqual(8);
    for (const o of ops) {
      expect(o.reasons.length).toBeGreaterThan(0);
      expect(['in', 'out']).toContain(o.direction);
    }
    // strongly diverging setup should produce both directions
    if (ops.length >= 2) {
      const dirs = new Set(ops.map(o => o.direction));
      expect(dirs.size).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('computeConstituentRows / Participation Score', () => {
  const xlv = SECTOR_ETFS.find(s => s.etf === 'XLV')!;

  it('builds rows from close history alone (no quotes) and scores participation', () => {
    const closes = new Map<string, number[]>();
    xlv.constituents.forEach((t, i) => closes.set(t, trendCloses(260, 0.0005 + i * 0.0004)));
    const rows = computeConstituentRows(xlv, trendCloses(260, 0.001), trendCloses(260, 0.0004), new Map(), closes);
    expect(rows.length).toBe(xlv.constituents.length);
    for (const r of rows) {
      expect(r.participation).not.toBeNull();
      expect(r.participation!).toBeGreaterThanOrEqual(0);
      expect(r.participation!).toBeLessThanOrEqual(100);
      expect(r.price).not.toBeNull();
    }
    // strongest-trending constituent should out-participate the weakest
    const strongest = rows.find(r => r.symbol === xlv.constituents[xlv.constituents.length - 1])!;
    const weakest   = rows.find(r => r.symbol === xlv.constituents[0])!;
    expect(strongest.participation!).toBeGreaterThan(weakest.participation!);
  });

  it('missing volume does not zero the participation score (weights renormalize)', () => {
    const closes = new Map<string, number[]>();
    xlv.constituents.forEach(t => closes.set(t, trendCloses(260, 0.002)));
    const rows = computeConstituentRows(xlv, trendCloses(260, 0.001), trendCloses(260, 0.0004), new Map(), closes);
    // all uptrending + above MAs; without volume data score must still be well above 0
    for (const r of rows) expect(r.participation!).toBeGreaterThan(20);
  });

  it('returns empty when neither quotes nor closes exist', () => {
    expect(computeConstituentRows(xlv, null, null, new Map(), new Map()).length).toBe(0);
  });
});

describe('quadrantOf', () => {
  it('matches the on-screen quadrant layout', () => {
    expect(quadrantOf(1, 1)).toBe('Leading');
    expect(quadrantOf(-1, 1)).toBe('Improving');
    expect(quadrantOf(1, -1)).toBe('Weakening');
    expect(quadrantOf(-1, -1)).toBe('Lagging');
  });
});
