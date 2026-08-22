import { describe, it, expect } from 'vitest';
import {
  enrichHolding, withAllocation, computeTotals, computeAllocation,
  computeConcentration, computeRotationExposure, validateTotals, accountTotalsOf,
  classifyHolding, positionTypeOf, returnOver,
} from './portfolioEngine';
import type { EnrichedHolding, PriceInfo } from './portfolioEngine';
import { pearson, dailyReturns, computeCorrelationMatrix, averageCorrelation } from './correlation';
import { DIVERSIFIED_LABEL, SPECIALTY_LABEL, UNCLASSIFIED_LABEL } from '../../config/portfolioConfig';
import type { Holding, Account, Currency } from '../../types';
import type { SectorMetrics } from '../sector/sectorEngine';
import { SECTOR_ETFS } from '../../config/sectorConfig';

const FX = 1.40;

function holding(over: Partial<Holding> = {}): Holding {
  return {
    id: 'h1', ticker: 'MSFT', shares: 100, avg_cost: 400,
    sector: 'Technology', account: 'RRSP' as Account, currency: 'USD' as Currency,
    liquidity_risk: 'LOW', notes: '', purchase_date: null, sell_date: null,
    target_price: null, created_at: new Date().toISOString(),
    ...over,
  };
}

function sector(etf: string, over: Partial<SectorMetrics> = {}): SectorMetrics {
  const def = SECTOR_ETFS.find(s => s.etf === etf)!;
  return {
    def, etf, name: def.name, price: 100,
    ret: { '1M': 0.027 }, rs: { '1M': 0 },
    rsChange1M: 0, accelShort: 0, accelMedium: 0,
    momentum: 'STEADY', volumeRatio: 1, above50: true, above200: true,
    breadth: null, pressure: -17, pressureSeries: [-17],
    pressureDelta: { d1: 0, d5: -3, d20: -8 }, trendArrow: 'flat',
    score: 55, classification: 'Neutral', signal: null,
    matrix: { '1M': { x: 0, y: 0, trail: [] }, '3M': { x: 0, y: 0, trail: [] }, '6M': { x: 0, y: 0, trail: [] } },
    ...over,
  };
}

function enrich(h: Holding, price: PriceInfo | null, opts: {
  sectorEtf?: string | null; sector?: SectorMetrics | null; closes?: number[];
} = {}) {
  return enrichHolding({
    h, price, fxUsdCad: FX,
    detectedSectorEtf: opts.sectorEtf ?? null,
    sector: opts.sector ?? null,
    closes: opts.closes,
  });
}

// ── PRIORITY 1: daily returns and FX ─────────────────────────────────────────

describe('daily return calculation', () => {
  it('uses previous close, never average cost', () => {
    // cost 400, prev close 480, price 483 → +0.625% (NOT +20.75% vs cost)
    const r = enrich(holding({ avg_cost: 400 }), { price: 483, prevClose: 480 });
    expect(r.dailyPct).toBeCloseTo(0.625, 3);
    expect(r.dailyPnlNative).toBeCloseTo(300, 6);
  });

  it('returns null daily values when previous close is missing', () => {
    const r = enrich(holding(), { price: 483, prevClose: null });
    expect(r.dailyPct).toBeNull();
    expect(r.dailyPnlNative).toBeNull();
    expect(r.dailyPnlCAD).toBeNull();
  });

  it('treats a zero previous close as missing rather than infinite', () => {
    const r = enrich(holding(), { price: 483, prevClose: 0 });
    expect(r.dailyPct).toBeNull();
  });

  it('keeps the last close-vs-prior-close move when the market is closed', () => {
    const r = enrich(holding(), { price: 480, prevClose: 500 });
    expect(r.dailyPct).toBeCloseTo(-4, 6);   // not reset to zero
  });

  it('flags daily change derived from a manual price override', () => {
    const r = enrich(holding(), { price: 500, prevClose: 480, manual: true });
    expect(r.priceSource).toBe('manual');
    expect(r.dailyFromManualPrice).toBe(true);
    expect(r.dailyPct).toBeCloseTo(4.1667, 3);
  });

  it('falls back to average cost for value when no price exists, with no daily figure', () => {
    const r = enrich(holding({ avg_cost: 400, shares: 10 }), null);
    expect(r.priceSource).toBe('cost');
    expect(r.marketValueNative).toBe(4000);
    expect(r.dailyPct).toBeNull();
  });
});

describe('FX conversion happens exactly once', () => {
  it('does not convert a CAD-listed holding', () => {
    const h = holding({ ticker: 'XEQT.TO', currency: 'CAD', shares: 100, avg_cost: 30 });
    const r = enrich(h, { price: 35, prevClose: 34 });
    expect(r.marketValueNative).toBe(3500);
    expect(r.marketValueCAD).toBe(3500);          // unchanged
    expect(r.dailyPnlCAD).toBeCloseTo(100, 6);    // 1 × 100 shares, no FX
  });

  it('converts a USD-listed holding once', () => {
    const h = holding({ ticker: 'MSFT', currency: 'USD', shares: 10, avg_cost: 400 });
    const r = enrich(h, { price: 500, prevClose: 490 });
    expect(r.marketValueNative).toBe(5000);
    expect(r.marketValueCAD).toBeCloseTo(5000 * FX, 6);
    expect(r.dailyPnlNative).toBeCloseTo(100, 6);
    expect(r.dailyPnlCAD).toBeCloseTo(100 * FX, 6);
  });

  it('handles the same company listed in both CAD and USD independently', () => {
    const usd = enrich(holding({ id: 'a', ticker: 'MSFT', currency: 'USD', shares: 10, avg_cost: 400 }),
      { price: 500, prevClose: 495 });
    const cad = enrich(holding({ id: 'b', ticker: 'MSFT.TO', currency: 'CAD', shares: 10, avg_cost: 560 }),
      { price: 700, prevClose: 693 });
    expect(usd.marketValueCAD).toBeCloseTo(5000 * FX, 6);
    expect(cad.marketValueCAD).toBe(7000);
    // percentage moves match because both listings moved ~1%
    expect(usd.dailyPct).toBeCloseTo(1.0101, 3);
    expect(cad.dailyPct).toBeCloseTo(1.0101, 3);
  });
});

describe('portfolio totals', () => {
  const rows = withAllocation([
    enrich(holding({ id: 'a', ticker: 'MSFT', currency: 'USD', shares: 10, avg_cost: 400 }), { price: 500, prevClose: 490 }),
    enrich(holding({ id: 'b', ticker: 'XEQT.TO', currency: 'CAD', shares: 100, avg_cost: 30 }), { price: 35, prevClose: 34.5 }),
  ]);

  it('sums market value and cost basis in CAD', () => {
    const t = computeTotals(rows);
    expect(t.marketValueCAD).toBeCloseTo(10 * 500 * FX + 3500, 4);
    expect(t.costBasisCAD).toBeCloseTo(10 * 400 * FX + 3000, 4);
    expect(t.pnlCAD).toBeCloseTo(t.marketValueCAD - t.costBasisCAD, 6);
  });

  it('derives daily % from prior-close value, not from cost basis', () => {
    const t = computeTotals(rows);
    const dailyCAD = 10 * 10 * FX + 100 * 0.5;              // 140 + 50
    const prevCAD  = 10 * 490 * FX + 100 * 34.5;            // 6860 + 3450
    expect(t.dailyPnlCAD).toBeCloseTo(dailyCAD, 4);
    expect(t.dailyPct).toBeCloseTo((dailyCAD / prevCAD) * 100, 4);
    expect(t.dailyPct!).toBeLessThan(3);                     // sane magnitude
  });

  it('reports partial daily coverage when a previous close is missing', () => {
    const partial = withAllocation([
      enrich(holding({ id: 'a' }), { price: 500, prevClose: 490 }),
      enrich(holding({ id: 'b', ticker: 'ORCL' }), { price: 146, prevClose: null }),
    ]);
    const t = computeTotals(partial);
    expect(t.dailyCoverage).toEqual({ counted: 1, total: 2 });
    expect(t.dailyPnlCAD).not.toBeNull();
  });

  it('returns null daily figures when nothing has a previous close', () => {
    const none = withAllocation([enrich(holding(), { price: 500, prevClose: null })]);
    const t = computeTotals(none);
    expect(t.dailyPnlCAD).toBeNull();
    expect(t.dailyPct).toBeNull();
  });
});

// ── PRIORITY 2: classification ───────────────────────────────────────────────

describe('position type and sector classification', () => {
  it('recognizes broad ETFs, specialty ETFs and sector ETFs', () => {
    expect(positionTypeOf('XEQT.TO')).toBe('Broad-Market ETF');
    expect(positionTypeOf('QQC.TO')).toBe('Specialty ETF');
    expect(positionTypeOf('XLK')).toBe('Sector ETF');
    expect(positionTypeOf('MSFT')).toBe('Individual Stock');
  });

  it('buckets a broad ETF as diversified with no sector', () => {
    const c = classifyHolding(holding({ ticker: 'XEQT.TO', sector: 'Other' }), null);
    expect(c.sectorLabel).toBe(DIVERSIFIED_LABEL);
    expect(c.sectorEtf).toBeNull();
  });

  it('buckets a Nasdaq-100 ETF as specialty, not Technology', () => {
    expect(classifyHolding(holding({ ticker: 'QQC.TO' }), null).sectorLabel).toBe(SPECIALTY_LABEL);
  });

  it('maps a sector ETF to its own sector', () => {
    const c = classifyHolding(holding({ ticker: 'XLV' }), null);
    expect(c.sectorLabel).toBe('Healthcare');
    expect(c.sectorEtf).toBe('XLV');
  });

  it('uses the detected sector for individual stocks', () => {
    const c = classifyHolding(holding({ ticker: 'META', sector: 'Other' }), 'XLC');
    expect(c.sectorLabel).toBe('Communication Services');
    expect(c.sectorIsManual).toBe(false);
  });

  it('respects and flags a manual sector override', () => {
    const c = classifyHolding(holding({ ticker: 'META', sector: 'Technology' }), 'XLC');
    expect(c.sectorLabel).toBe('Technology');
    expect(c.sectorIsManual).toBe(true);
  });

  it('marks a stock as Unclassified rather than Other when nothing is known', () => {
    expect(classifyHolding(holding({ ticker: 'ZZZZ', sector: '' }), null).sectorLabel).toBe(UNCLASSIFIED_LABEL);
  });
});

describe('sector allocation', () => {
  const rows = withAllocation([
    enrich(holding({ id: 'a', ticker: 'MSFT', currency: 'USD', shares: 10, avg_cost: 400 }), { price: 500, prevClose: 495 }, { sectorEtf: 'XLK' }),
    enrich(holding({ id: 'b', ticker: 'META', currency: 'USD', shares: 5, avg_cost: 400, sector: 'Other' }), { price: 600, prevClose: 595 }, { sectorEtf: 'XLC' }),
    enrich(holding({ id: 'c', ticker: 'XEQT.TO', currency: 'CAD', shares: 100, avg_cost: 30 }), { price: 35, prevClose: 34 }),
  ]);

  it('totals to 100% and keeps diversified ETFs separate', () => {
    const alloc = computeAllocation(rows);
    expect(alloc.reduce((s, a) => s + a.weightPct, 0)).toBeCloseTo(100, 4);
    const div = alloc.find(a => a.label === DIVERSIFIED_LABEL)!;
    expect(div.isDiversified).toBe(true);
    expect(div.sectorEtf).toBeNull();
    expect(alloc.map(a => a.label)).toContain('Communication Services');
  });

  it('never drops a holding from allocation', () => {
    const alloc = computeAllocation(rows);
    const totalValue = rows.reduce((s, r) => s + r.marketValueCAD, 0);
    expect(alloc.reduce((s, a) => s + a.valueCAD, 0)).toBeCloseTo(totalValue, 4);
  });
});

// ── PRIORITY 3: correlation ──────────────────────────────────────────────────

describe('correlation', () => {
  const up = Array.from({ length: 120 }, (_, i) => 100 * (1 + i * 0.001));
  const noisy = (seed: number) => Array.from({ length: 120 }, (_, i) =>
    100 * (1 + i * 0.001) + Math.sin(i * seed) * 2);

  it('returns 1 for a series against itself', () => {
    const r = dailyReturns(up);
    expect(pearson(r, r)).toBeCloseTo(1, 6);
  });

  it('returns −1 for perfectly inverse returns', () => {
    const a = [0.01, -0.02, 0.03, -0.01, 0.02];
    const b = a.map(x => -x);
    expect(pearson(a, b)).toBeCloseTo(-1, 6);
  });

  it('returns null instead of a number when variance is zero', () => {
    expect(pearson([0, 0, 0, 0], [0.01, -0.01, 0.02, 0])).toBeNull();
  });

  it('returns null for pairs without enough overlapping history', () => {
    const m = computeCorrelationMatrix(['AAA', 'BBB'], new Map([
      ['AAA', up],
      ['BBB', [100, 101, 102]],   // only 2 returns
    ]), 90, 20);
    expect(m.get('AAA', 'BBB')).toBeNull();
    expect(m.unavailable).toContain('BBB');
  });

  it('computes a real matrix with self-correlation of 1', () => {
    const m = computeCorrelationMatrix(['AAA', 'BBB'], new Map([
      ['AAA', noisy(0.5)], ['BBB', noisy(1.3)],
    ]));
    expect(m.get('AAA', 'AAA')).toBe(1);
    const r = m.get('AAA', 'BBB');
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThanOrEqual(-1);
    expect(r!).toBeLessThanOrEqual(1);
    expect(m.observations('AAA', 'BBB')).toBeGreaterThanOrEqual(20);
  });

  it('honours the requested lookback window', () => {
    const m30 = computeCorrelationMatrix(['AAA', 'BBB'], new Map([
      ['AAA', noisy(0.5)], ['BBB', noisy(1.3)],
    ]), 30);
    expect(m30.observations('AAA', 'BBB')).toBe(30);
  });

  it('averageCorrelation ignores unavailable pairs', () => {
    const m = computeCorrelationMatrix(['AAA', 'BBB', 'CCC'], new Map([
      ['AAA', noisy(0.5)], ['BBB', noisy(1.3)],
    ]));
    const avg = averageCorrelation(m);
    expect(avg).not.toBeNull();
    expect(Math.abs(avg!)).toBeLessThanOrEqual(1);
  });
});

// ── PRIORITY 4: concentration ────────────────────────────────────────────────

describe('concentration analysis', () => {
  function build(specs: Array<[string, number, boolean]>) {
    const rows = withAllocation(specs.map(([ticker, value], i) =>
      enrich(holding({ id: `h${i}`, ticker, currency: 'CAD', shares: value, avg_cost: 1 }),
        { price: 1, prevClose: 1 },
        { sectorEtf: ticker === 'MSFT' ? 'XLK' : null })
    ));
    return { rows, alloc: computeAllocation(rows) };
  }

  it('does not penalize a large broad-ETF position like a single stock', () => {
    const etfHeavy = build([['XEQT.TO', 60, true], ['MSFT', 10, false], ['META', 10, false], ['ORCL', 10, false], ['NFLX', 10, false]]);
    const stockHeavy = build([['MSFT', 60, false], ['META', 10, false], ['ORCL', 10, false], ['NFLX', 10, false], ['TSLA', 10, false]]);
    const a = computeConcentration(etfHeavy.rows, etfHeavy.alloc);
    const b = computeConcentration(stockHeavy.rows, stockHeavy.alloc);
    const order = ['LOW', 'MODERATE', 'HIGH', 'VERY HIGH'];
    expect(order.indexOf(a.level)).toBeLessThan(order.indexOf(b.level));
  });

  it('separates largest position from largest individual stock', () => {
    const { rows, alloc } = build([['XEQT.TO', 50, true], ['MSFT', 30, false], ['META', 20, false]]);
    const c = computeConcentration(rows, alloc);
    expect(c.largestPosition!.ticker).toBe('XEQT.TO');
    expect(c.largestStock!.ticker).toBe('MSFT');
    expect(c.largestEtf!.ticker).toBe('XEQT.TO');
    expect(c.broadEtfPct).toBeCloseTo(50, 4);
  });

  it('explains its rating with concrete numbers', () => {
    const { rows, alloc } = build([['MSFT', 50, false], ['META', 50, false]]);
    const c = computeConcentration(rows, alloc);
    expect(c.reasons.some(r => r.includes('Largest individual stock'))).toBe(true);
    expect(['HIGH', 'VERY HIGH']).toContain(c.level);
  });

  it('excludes diversified buckets from sector concentration', () => {
    const { rows, alloc } = build([['XEQT.TO', 90, true], ['MSFT', 10, false]]);
    const c = computeConcentration(rows, alloc);
    expect(c.largestSector?.label).not.toBe(DIVERSIFIED_LABEL);
  });
});

// ── PRIORITY 5: rotation exposure ────────────────────────────────────────────

describe('rotation exposure', () => {
  it('weights sector pressure by position size and excludes diversified ETFs', () => {
    const rows = withAllocation([
      enrich(holding({ id: 'a', ticker: 'MSFT', currency: 'CAD', shares: 100, avg_cost: 1 }), { price: 1, prevClose: 1 }, { sectorEtf: 'XLK' }),
      enrich(holding({ id: 'b', ticker: 'XEQT.TO', currency: 'CAD', shares: 900, avg_cost: 1 }), { price: 1, prevClose: 1 }),
    ]);
    const sectors = new Map([['XLK', sector('XLK', { pressure: -17 })]]);
    const e = computeRotationExposure(rows, sectors);
    expect(e.value).toBe(-17);                 // XEQT excluded entirely
    expect(e.classifiedPct).toBeCloseTo(10, 4);
  });

  it('reports unavailable when nothing can be classified', () => {
    const rows = withAllocation([
      enrich(holding({ ticker: 'XEQT.TO', currency: 'CAD', shares: 10, avg_cost: 1 }), { price: 1, prevClose: 1 }),
    ]);
    expect(computeRotationExposure(rows, new Map()).value).toBeNull();
  });
});

// ── PRIORITY 6: sell targets ─────────────────────────────────────────────────

describe('sell target', () => {
  it('computes remaining upside to target', () => {
    const r = enrich(holding({ target_price: 650 }), { price: 483, prevClose: 480 });
    expect(r.targetRemainingPct).toBeCloseTo(34.58, 1);
    expect(r.targetReached).toBe(false);
  });

  it('flags NEAR TARGET within the configured band', () => {
    const r = enrich(holding({ target_price: 500 }), { price: 483, prevClose: 480 });
    expect(r.nearTarget).toBe(true);
  });

  it('marks a wildly exceeded target as stale rather than actionable', () => {
    const r = enrich(holding({ target_price: 45 }), { price: 483, prevClose: 480 });
    expect(r.targetReached).toBe(true);
    expect(r.targetStale).toBe(true);
  });

  it('returns null when no target is set', () => {
    expect(enrich(holding(), { price: 483, prevClose: 480 }).targetRemainingPct).toBeNull();
  });
});

// ── holding status & relative strength ───────────────────────────────────────

describe('holding status', () => {
  const closesUp = Array.from({ length: 80 }, (_, i) => 100 * (1 + i * 0.002));

  it('computes stock vs sector relative strength', () => {
    const r = enrich(holding(), { price: 500, prevClose: 495 },
      { sectorEtf: 'XLK', sector: sector('XLK', { ret: { '1M': 0.027 } }), closes: closesUp });
    expect(r.ret1M).not.toBeNull();
    expect(r.rsVsSector1M).toBeCloseTo(r.ret1M! - 0.027, 6);
  });

  it('never emits a SELL instruction', () => {
    const statuses = new Set<string>();
    for (const p of [-40, 0, 40]) {
      const r = enrich(holding({ target_price: 100 }), { price: 500, prevClose: 495 },
        { sectorEtf: 'XLK', sector: sector('XLK', { pressure: p }), closes: closesUp });
      statuses.add(r.status);
    }
    expect([...statuses].every(s => ['LEADER', 'HOLDING', 'WEAKENING', 'REVIEW'].includes(s))).toBe(true);
  });

  it('flags REVIEW when several negatives stack up', () => {
    const down = Array.from({ length: 80 }, (_, i) => 100 * (1 - i * 0.003));
    const r = enrich(holding({ avg_cost: 1000 }), { price: 500, prevClose: 495 },
      { sectorEtf: 'XLK', sector: sector('XLK', { pressure: -50, ret: { '1M': 0.05 } }), closes: down });
    expect(r.status).toBe('REVIEW');
    expect(r.statusReasons.length).toBeGreaterThanOrEqual(2);
  });
});

// ── reconciliation ───────────────────────────────────────────────────────────

describe('validation', () => {
  const rows = withAllocation([
    enrich(holding({ id: 'a', ticker: 'MSFT', account: 'RRSP' as Account, currency: 'USD', shares: 10, avg_cost: 400 }), { price: 500, prevClose: 495 }),
    enrich(holding({ id: 'b', ticker: 'XEQT.TO', account: 'TSFA' as Account, currency: 'CAD', shares: 100, avg_cost: 30 }), { price: 35, prevClose: 34 }),
  ]);

  it('reports no diagnostics for a consistent portfolio', () => {
    const totals = computeTotals(rows);
    const alloc = computeAllocation(rows);
    expect(validateTotals(rows, totals, alloc, accountTotalsOf(rows))).toEqual([]);
  });

  it('account totals reconcile to portfolio value', () => {
    const totals = computeTotals(rows);
    const accounts = accountTotalsOf(rows);
    const sum = Object.values(accounts).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(totals.marketValueCAD, 6);
  });

  it('detects a mismatch when account totals are wrong', () => {
    const totals = computeTotals(rows);
    const alloc = computeAllocation(rows);
    const bad = { ...accountTotalsOf(rows), RRSP: 1 };
    expect(validateTotals(rows, totals, alloc, bad).length).toBeGreaterThan(0);
  });
});

describe('returnOver', () => {
  it('returns null without enough history rather than zero', () => {
    expect(returnOver([100, 101], 21)).toBeNull();
    expect(returnOver(undefined, 21)).toBeNull();
  });
  it('computes a simple return', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(returnOver(closes, 21)).toBeCloseTo((129 / 108) - 1, 6);
  });
});
