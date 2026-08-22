// Watch List engine tests — status derivation, actionability, entry distance,
// alignment, stale detection and missing-data handling.
import { describe, it, expect } from 'vitest';
import { buildWatchRow, summarize, needsAttention, getMarket, daysSince } from './watchEngine';
import type { WatchMeta } from './watchMeta';
import type { WatchItem, Conviction } from '../../types';
import type { SectorMetrics } from '../sector/sectorEngine';
import { SECTOR_ETFS } from '../../config/sectorConfig';
import { WATCH_THRESHOLDS } from '../../config/watchConfig';

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
}
function daysAhead(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
}

function item(over: Partial<WatchItem> = {}): WatchItem {
  return {
    id: 'w1', ticker: 'AMZN', conviction: 'MEDIUM' as Conviction, notes: '',
    watch_price: 250, watch_date: daysAgo(10),
    analyst_target: null, target_entry: null, created_at: new Date().toISOString(),
    ...over,
  };
}

function sector(over: Partial<SectorMetrics> = {}): SectorMetrics {
  const def = SECTOR_ETFS.find(s => s.etf === 'XLY')!;
  return {
    def, etf: 'XLY', name: 'Consumer Discretionary', price: 100,
    ret: { '1M': 0.02 }, rs: { '1M': 0.01 },
    rsChange1M: 0, accelShort: 0, accelMedium: 0,
    momentum: 'STEADY', volumeRatio: 1, above50: true, above200: true,
    breadth: null, pressure: 27, pressureSeries: [10, 27],
    pressureDelta: { d1: 2, d5: 5, d20: 10 }, trendArrow: 'up',
    score: 60, classification: 'Neutral', signal: null,
    matrix: { '1M': { x: 0, y: 0, trail: [] }, '3M': { x: 0, y: 0, trail: [] }, '6M': { x: 0, y: 0, trail: [] } },
    ...over,
  };
}

function build(args: {
  it?: Partial<WatchItem>; meta?: WatchMeta; price?: number | null;
  sec?: SectorMetrics | null; ret1M?: number | null;
} = {}) {
  return buildWatchRow({
    item: item(args.it),
    meta: args.meta ?? {},
    currentPrice: args.price === undefined ? 258.63 : args.price,
    dayPct: -0.57,
    sector: args.sec === undefined ? sector() : args.sec,
    sectorEtf: args.sec === null ? null : 'XLY',
    stockReturns: args.ret1M === undefined ? null : { ret5D: null, ret1M: args.ret1M, ret3M: null },
  });
}

describe('entry distance & upside', () => {
  it('reports negative distance when price is below entry', () => {
    const r = build({ it: { target_entry: 260 }, price: 258.63 });
    expect(r.entryDistancePct).toBeCloseTo(-0.527, 2);
    expect(r.insideEntry).toBe(true);
    expect(r.status).toBe('ACTIONABLE');
  });

  it('reports positive distance when price is above entry', () => {
    const r = build({ it: { target_entry: 195 }, price: 208.10 });
    expect(r.entryDistancePct).toBeCloseTo(6.72, 1);
    expect(r.insideEntry).toBe(false);
  });

  it('calculates analyst target upside', () => {
    const r = build({ it: { analyst_target: 300 }, price: 258.63 });
    expect(r.targetUpsidePct).toBeCloseTo(16.0, 1);
  });

  it('returns null (not zero) for missing entry and target', () => {
    const r = build({ it: { target_entry: null, analyst_target: null } });
    expect(r.entryDistancePct).toBeNull();
    expect(r.targetUpsidePct).toBeNull();
    expect(r.insideEntry).toBeNull();
  });

  it('handles a missing price without crashing', () => {
    const r = build({ price: null, it: { target_entry: 260 } });
    expect(r.entryDistancePct).toBeNull();
    expect(r.status).toBe('WATCH');
  });
});

describe('status derivation', () => {
  it('NEAR ENTRY within the configured band', () => {
    const r = build({ it: { target_entry: 250 }, price: 255 }); // +2%
    expect(r.status).toBe('NEAR ENTRY');
  });

  it('EXTENDED beyond the configured band', () => {
    const r = build({ it: { target_entry: 200 }, price: 260 }); // +30%
    expect(r.status).toBe('EXTENDED');
  });

  it('WATCH between near-entry and extended', () => {
    const r = build({ it: { target_entry: 240 }, price: 255 }); // +6.25%
    expect(r.status).toBe('WATCH');
  });

  it('WAIT FOR CATALYST when a trigger and future catalyst exist', () => {
    const r = build({
      it: { target_entry: 240 }, price: 255,
      meta: { trigger: 'post-earnings weakness', catalyst_date: daysAhead(20) },
    });
    expect(r.status).toBe('WAIT FOR CATALYST');
  });

  it('never infers THESIS BROKEN from price alone', () => {
    const r = build({ it: { target_entry: 500 }, price: 100 }); // −80%
    expect(r.status).not.toBe('THESIS BROKEN');
  });

  it('THESIS BROKEN only when the user marks it', () => {
    const r = build({ meta: { thesis_broken: true } });
    expect(r.status).toBe('THESIS BROKEN');
    expect(r.actionability).toBeLessThanOrEqual(5);
  });

  it('REVIEW when stale, but ACTIONABLE still wins if price is at entry', () => {
    const stale = { watch_date: daysAgo(WATCH_THRESHOLDS.staleDays + 30), target_entry: 200 };
    expect(build({ it: stale, price: 260 }).status).toBe('REVIEW');
    expect(build({ it: stale, price: 190 }).status).toBe('ACTIONABLE');
  });
});

describe('stale-watch detection', () => {
  it('flags a passed catalyst', () => {
    const r = build({ meta: { catalyst_date: daysAgo(5), catalyst: 'Earnings' } });
    expect(r.reviewReasons.some(x => x.includes('Catalyst passed'))).toBe(true);
    expect(r.catalystDaysAway).toBeLessThan(0);
  });

  it('flags a long-unreviewed entry as review due', () => {
    const r = build({ meta: { last_reviewed: daysAgo(WATCH_THRESHOLDS.reviewDueDays + 5) } });
    expect(r.reviewDue).toBe(true);
  });

  it('mark-reviewed resets review-due without touching watch age', () => {
    const oldWatch = { watch_date: daysAgo(200) };
    const stale = build({ it: oldWatch });
    const reviewed = build({ it: oldWatch, meta: { last_reviewed: daysAgo(1) } });
    expect(stale.reviewDue).toBe(true);
    expect(reviewed.reviewDue).toBe(false);
    expect(reviewed.watchAgeDays).toBe(stale.watchAgeDays);
  });

  it('flags a materially deteriorating sector', () => {
    const shifted = sector({ pressureDelta: { d1: -5, d5: -40, d20: -50 } });
    const r = build({ sec: shifted });
    expect(r.sectorShift).toBe(-40);
    expect(r.reviewReasons.some(x => x.includes('Sector rotation deteriorating'))).toBe(true);
  });

  it('ignores small sector moves as noise', () => {
    expect(build({ sec: sector({ pressureDelta: { d1: 1, d5: 4, d20: 6 } }) }).sectorShift).toBeNull();
  });
});

describe('relative strength & alignment', () => {
  it('computes stock RS vs its sector ETF', () => {
    const r = build({ sec: sector({ ret: { '1M': 0.065 } }), ret1M: 0.12 });
    expect(r.rsVsSector1M).toBeCloseTo(0.055, 3);
  });

  it('STRONG ALIGNMENT when sector improving and stock outperforming', () => {
    expect(build({ sec: sector({ pressure: 30 }), ret1M: 0.10 }).alignment).toBe('STRONG ALIGNMENT');
  });

  it('STOCK LEADER when sector weak but stock strongly outperforming', () => {
    const r = build({ sec: sector({ pressure: -30, ret: { '1M': 0.0 } }), ret1M: 0.09 });
    expect(r.alignment).toBe('STOCK LEADER');
  });

  it('WEAK ALIGNMENT when sector weak and stock lagging', () => {
    const r = build({ sec: sector({ pressure: -30, ret: { '1M': 0.0 } }), ret1M: -0.05 });
    expect(r.alignment).toBe('WEAK ALIGNMENT');
  });

  it('returns null RS (not −100) when sector data is unavailable', () => {
    const r = build({ sec: null, ret1M: 0.1 });
    expect(r.rsVsSector1M).toBeNull();
    expect(r.sector).toBeNull();
  });
});

describe('actionability score', () => {
  it('stays within 0–100 and rewards being at entry', () => {
    const atEntry = build({ it: { target_entry: 260, conviction: 'HIGH' }, price: 255 });
    const extended = build({ it: { target_entry: 200, conviction: 'HIGH' }, price: 280 });
    expect(atEntry.actionability).toBeGreaterThanOrEqual(0);
    expect(atEntry.actionability).toBeLessThanOrEqual(100);
    expect(atEntry.actionability).toBeGreaterThan(extended.actionability);
  });

  it('ranks higher conviction above lower, all else equal', () => {
    const args = { target_entry: 250 };
    const hi = build({ it: { ...args, conviction: 'HIGH' }, price: 255 });
    const lo = build({ it: { ...args, conviction: 'LOW' }, price: 255 });
    expect(hi.actionability).toBeGreaterThan(lo.actionability);
  });

  it('does not collapse to zero when sector and RS data are missing', () => {
    const r = build({ it: { target_entry: 260, conviction: 'HIGH' }, price: 255, sec: null, ret1M: null });
    expect(r.actionability).toBeGreaterThan(50);
  });

  it('boosts an imminent catalyst over a distant one', () => {
    const soon = build({ it: { target_entry: 240 }, price: 250, meta: { catalyst_date: daysAhead(3) } });
    const far  = build({ it: { target_entry: 240 }, price: 250, meta: { catalyst_date: daysAhead(120) } });
    expect(soon.actionability).toBeGreaterThan(far.actionability);
  });
});

describe('needsAttention & summary', () => {
  it('includes actionable, near-entry, review and imminent catalysts', () => {
    expect(needsAttention(build({ it: { target_entry: 260 }, price: 255 }))).toBe(true);
    expect(needsAttention(build({ it: { target_entry: 250 }, price: 255 }))).toBe(true);
    expect(needsAttention(build({ meta: { thesis_broken: true } }))).toBe(true);
    expect(needsAttention(build({ it: { target_entry: 240 }, price: 250, meta: { catalyst_date: daysAhead(2) } }))).toBe(true);
  });

  it('excludes a quiet mid-range watch', () => {
    const quiet = build({ it: { target_entry: 240 }, price: 252, sec: sector({ pressureDelta: { d1: 0, d5: 1, d20: 2 } }) });
    expect(needsAttention(quiet)).toBe(false);
  });

  it('summarizes counts across statuses', () => {
    const rows = [
      build({ it: { id: 'a', target_entry: 260 }, price: 255 }),   // ACTIONABLE
      build({ it: { id: 'b', target_entry: 250 }, price: 255 }),   // NEAR ENTRY
      build({ it: { id: 'c', target_entry: 200 }, price: 260 }),   // EXTENDED
    ];
    const s = summarize(rows);
    expect(s.total).toBe(3);
    expect(s.actionable).toBe(1);
    expect(s.nearEntry).toBe(1);
    expect(s.extended).toBe(1);
    expect(s.sectorsImproving).toBe(1); // all share XLY with positive pressure
  });
});

describe('helpers', () => {
  it('detects TSX vs US tickers', () => {
    expect(getMarket('SHOP.TO')).toBe('TSX');
    expect(getMarket('AMZN')).toBe('US');
  });

  it('daysSince handles null and invalid dates', () => {
    expect(daysSince(null)).toBeNull();
    expect(daysSince('not-a-date')).toBeNull();
    expect(daysSince(daysAgo(7))).toBe(7);
  });
});
