import { describe, it, expect } from 'vitest';
import {
  buildRows, computeCoreStats, segmentBy, computeHoldingStats, computeExtremes,
  computeEquityCurve, computeDrawdown, computeMonthly, validateJournal,
  computeInsights, holdingBucketOf, rotationContextOf, daysBetween, hasInvalidDates,
} from './journalStats';
import type { JournalMeta } from './journalMeta';
import type { TradeJournalEntry, Account, Currency } from '../../types';

const FX = 1.40;
let sr = 0;

function trade(over: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  sr += 1;
  return {
    id: `t${sr}`, sr_no: sr, date_of_buy: '2025-01-10',
    account: 'TFSA' as Account, ticker: 'AAA', company: 'AAA Inc', industry: '',
    period: '', strategy: 'Momentum', currency: 'CAD' as Currency,
    qty: 100, entry_price: 10, stop_loss: null, position_size: 1000,
    date_of_sale: '2025-01-20', exit_qty: 100, exit_price: 12,
    net_qty: 0, avg_exit_price: 12, realized_pnl: 200, realized_pnl_pct: 20,
    win_loss: 'WIN', status: 'CLOSED', notes: '', created_at: new Date().toISOString(),
    ...over,
  };
}

const rows = (ts: TradeJournalEntry[], meta: Record<string, JournalMeta> = {}) =>
  buildRows(ts, meta, FX);

// ── PRIORITY 1: the corrected math ───────────────────────────────────────────

describe('Profit Factor vs Payoff Ratio', () => {
  // Spec's reconciliation case: gross wins 99,744.33 / gross losses 13,200.09
  const spec = [
    trade({ realized_pnl: 55625.00 }),
    trade({ realized_pnl: 30119.33 }),
    trade({ realized_pnl: 14000.00 }),
    trade({ realized_pnl: -9200.09, win_loss: 'LOSS' }),
    trade({ realized_pnl: -4000.00, win_loss: 'LOSS' }),
  ];

  it('uses GROSS wins over GROSS losses, not the average ratio', () => {
    const s = computeCoreStats(rows(spec));
    expect(s.grossWinsCAD).toBeCloseTo(99744.33, 2);
    expect(s.grossLossesCAD).toBeCloseTo(-13200.09, 2);
    expect(s.profitFactor).toBeCloseTo(99744.33 / 13200.09, 4);
    expect(s.profitFactor).toBeCloseTo(7.56, 1);
  });

  it('reports Payoff Ratio separately as avg win / |avg loss|', () => {
    const s = computeCoreStats(rows(spec));
    const expected = (99744.33 / 3) / (13200.09 / 2);
    expect(s.payoffRatio).toBeCloseTo(expected, 4);
    expect(s.payoffRatio).not.toBeCloseTo(s.profitFactor!, 2);   // genuinely different
  });

  it('reconciles gross wins + gross losses to net realized P&L', () => {
    const s = computeCoreStats(rows(spec));
    expect(s.grossWinsCAD + s.grossLossesCAD).toBeCloseTo(s.netPnlCAD, 6);
    expect(s.netPnlCAD).toBeCloseTo(86544.24, 2);
  });

  it('computes expectancy from win rate and average outcomes', () => {
    const s = computeCoreStats(rows(spec));
    const winRate = 3 / 5, lossRate = 2 / 5;
    const expected = winRate * (99744.33 / 3) - lossRate * (13200.09 / 2);
    expect(s.expectancyCAD).toBeCloseTo(expected, 4);
  });

  it('returns null profit factor with no losses rather than dividing by zero', () => {
    const s = computeCoreStats(rows([trade({ realized_pnl: 100 })]));
    expect(s.profitFactor).toBe(Infinity);
    expect(s.payoffRatio).toBeNull();
  });
});

// ── currency ─────────────────────────────────────────────────────────────────

describe('currency aggregation', () => {
  it('converts USD trades to CAD instead of summing raw', () => {
    const s = computeCoreStats(rows([
      trade({ realized_pnl: 1000, currency: 'CAD' as Currency }),
      trade({ realized_pnl: 1000, currency: 'USD' as Currency }),
    ]));
    expect(s.netPnlCAD).toBeCloseTo(1000 + 1000 * FX, 4);
    expect(s.netPnlCAD).not.toBeCloseTo(2000, 2);
  });
});

// ── breakeven / open trades ──────────────────────────────────────────────────

describe('outcome classification', () => {
  it('counts a zero-P&L trade as breakeven, not a win or loss', () => {
    const s = computeCoreStats(rows([
      trade({ realized_pnl: 100 }),
      trade({ realized_pnl: -50, win_loss: 'LOSS' }),
      trade({ realized_pnl: 0, win_loss: null }),
    ]));
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.breakeven).toBe(1);
    expect(s.trades).toBe(3);
    expect(s.winRate).toBeCloseTo(100 / 3, 4);   // breakeven stays in the denominator
  });

  it('excludes open trades from every realized statistic', () => {
    const withOpen = rows([
      trade({ realized_pnl: 500 }),
      trade({ status: 'OPEN', realized_pnl: null, date_of_sale: null, win_loss: null }),
    ]);
    const s = computeCoreStats(withOpen);
    expect(s.trades).toBe(1);
    expect(s.netPnlCAD).toBeCloseTo(500, 4);
    expect(computeEquityCurve(withOpen)).toHaveLength(1);
    expect(computeMonthly(withOpen)).toHaveLength(1);
  });
});

// ── PRIORITY 2: dates ────────────────────────────────────────────────────────

describe('dates and holding period', () => {
  it('computes days held between entry and exit', () => {
    expect(daysBetween('2025-01-10', '2025-01-27')).toBe(17);
    expect(daysBetween('2025-01-10', null)).toBeNull();
    expect(daysBetween(null, '2025-01-10')).toBeNull();
  });

  it('detects exit-before-entry without altering the record', () => {
    expect(hasInvalidDates('2025-03-01', '2025-02-01')).toBe(true);
    expect(hasInvalidDates('2025-01-01', '2025-01-01')).toBe(false);
    const r = rows([trade({ date_of_buy: '2025-03-01', date_of_sale: '2025-02-01' })])[0];
    expect(r.invalidDates).toBe(true);
    expect(r.daysHeld).toBeNull();               // not a negative hold
    expect(r.t.date_of_buy).toBe('2025-03-01');  // untouched
  });

  it('separates winner and loser holding periods', () => {
    const h = computeHoldingStats(rows([
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-02-01', realized_pnl: 100 }),   // 31d win
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-01-21', realized_pnl: 100 }),   // 20d win
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-01-06', realized_pnl: -50, win_loss: 'LOSS' }), // 5d loss
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-01-04', realized_pnl: -50, win_loss: 'LOSS' }), // 3d loss
    ]));
    expect(h.avgWinners).toBeCloseTo(25.5, 1);
    expect(h.avgLosers).toBeCloseTo(4, 1);
    expect(h.medianWinners).toBeCloseTo(25.5, 1);
  });

  it('buckets holding periods', () => {
    expect(holdingBucketOf(0)).toBe('Same Day');
    expect(holdingBucketOf(3)).toBe('1–5 Days');
    expect(holdingBucketOf(10)).toBe('6–15 Days');
    expect(holdingBucketOf(17)).toBe('16–30 Days');
    expect(holdingBucketOf(45)).toBe('31–60 Days');
    expect(holdingBucketOf(200)).toBe('60+ Days');
    expect(holdingBucketOf(null)).toBeNull();
  });
});

// ── best / worst ─────────────────────────────────────────────────────────────

describe('best and worst trades', () => {
  it('does not assume the biggest dollar winner is the biggest percentage winner', () => {
    // P&L % is derived from prices, so the fixture sets real entry/exit prices:
    // BIG is the largest dollar winner at +20%; PCT is the largest percent winner.
    const e = computeExtremes(rows([
      trade({ ticker: 'BIG', realized_pnl: 55625, entry_price: 100, avg_exit_price: 120, exit_price: 120 }),
      trade({ ticker: 'PCT', realized_pnl: 900, entry_price: 10, avg_exit_price: 19.095, exit_price: 19.095 }),
      trade({ ticker: 'BAD', realized_pnl: -4000, entry_price: 100, avg_exit_price: 88, exit_price: 88, win_loss: 'LOSS' }),
    ]));
    expect(e.bestByDollar!.t.ticker).toBe('BIG');
    expect(e.bestByPct!.t.ticker).toBe('PCT');
    expect(e.worstByDollar!.t.ticker).toBe('BAD');
  });

  it('returns nulls for an empty journal', () => {
    const e = computeExtremes([]);
    expect(e.bestByDollar).toBeNull();
    expect(e.bestByPct).toBeNull();
  });
});

// ── equity curve, drawdown, monthly ──────────────────────────────────────────

describe('equity curve and drawdown', () => {
  const series = rows([
    trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-01-10', realized_pnl: 1000 }),
    trade({ date_of_buy: '2025-01-05', date_of_sale: '2025-02-10', realized_pnl: -600, win_loss: 'LOSS' }),
    trade({ date_of_buy: '2025-02-01', date_of_sale: '2025-03-10', realized_pnl: 400 }),
  ]);

  it('orders by exit date, not entry date', () => {
    const c = computeEquityCurve(series);
    expect(c.map(p => p.date)).toEqual(['2025-01-10', '2025-02-10', '2025-03-10']);
    expect(c.map(p => p.cum)).toEqual([1000, 400, 800]);
  });

  it('final cumulative value equals net realized P&L', () => {
    const c = computeEquityCurve(series);
    expect(c[c.length - 1].cum).toBeCloseTo(computeCoreStats(series).netPnlCAD, 2);
  });

  it('measures peak-to-trough drawdown', () => {
    const d = computeDrawdown(computeEquityCurve(series));
    expect(d.maxDrawdownCAD).toBeCloseTo(-600, 2);
    expect(d.peakCAD).toBeCloseTo(1000, 2);
    expect(d.troughCAD).toBeCloseTo(400, 2);
    expect(d.currentDrawdownCAD).toBeCloseTo(-200, 2);
  });

  it('attributes monthly P&L to the exit month', () => {
    const m = computeMonthly(series);
    expect(m.map(x => x.month)).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(m[0].pnl).toBeCloseTo(1000, 2);   // entered Jan 1, closed Jan 10
    expect(m[1].pnl).toBeCloseTo(-600, 2);   // entered Jan 5 but closed in Feb
  });

  it('orders same-day exits deterministically', () => {
    const same = rows([
      trade({ sr_no: 2, date_of_sale: '2025-01-10', realized_pnl: 100 }),
      trade({ sr_no: 1, date_of_sale: '2025-01-10', realized_pnl: 200 }),
    ]);
    const a = computeEquityCurve(same).map(p => p.label);
    const b = computeEquityCurve([...same].reverse()).map(p => p.label);
    expect(a).toEqual(b);
  });
});

// ── segmentation ─────────────────────────────────────────────────────────────

describe('segmentation', () => {
  const set = rows([
    trade({ strategy: 'Sector Rotation', account: 'TFSA' as Account, realized_pnl: 3000 }),
    trade({ strategy: 'Sector Rotation', account: 'TFSA' as Account, realized_pnl: 2000 }),
    trade({ strategy: 'Lotto', account: 'RRSP' as Account, realized_pnl: -1500, win_loss: 'LOSS' }),
    trade({ strategy: 'Lotto', account: 'RRSP' as Account, realized_pnl: -500, win_loss: 'LOSS' }),
  ]);

  it('computes full stats per strategy', () => {
    const s = segmentBy(set, r => r.t.strategy || null);
    const rot = s.find(x => x.key === 'Sector Rotation')!;
    expect(rot.trades).toBe(2);
    expect(rot.winRate).toBe(100);
    expect(rot.netPnlCAD).toBeCloseTo(5000, 2);
    expect(rot.expectancyCAD).toBeCloseTo(2500, 2);
    const lotto = s.find(x => x.key === 'Lotto')!;
    expect(lotto.netPnlCAD).toBeCloseTo(-2000, 2);
    expect(lotto.profitFactor).toBe(0);
  });

  it('computes stats per account', () => {
    const s = segmentBy(set, r => r.t.account);
    expect(s.find(x => x.key === 'TFSA')!.netPnlCAD).toBeCloseTo(5000, 2);
    expect(s.find(x => x.key === 'RRSP')!.netPnlCAD).toBeCloseTo(-2000, 2);
  });

  it('skips rows with no value for the segment key', () => {
    const s = segmentBy(rows([trade({ strategy: '' })]), r => r.t.strategy || null);
    expect(s).toHaveLength(0);
  });
});

// ── rotation snapshots ───────────────────────────────────────────────────────

describe('rotation context', () => {
  it('uses only the stored entry snapshot', () => {
    const t = trade();
    const meta = {
      [t.id]: {
        sector_entry: {
          capturedAt: '2025-01-10T00:00:00Z', sectorLabel: 'Healthcare', sectorEtf: 'XLV',
          rotationPressure: 42, rotationStatus: 'Improving', pressureDelta5D: 12, stockVsSector1M: 0.05,
        },
      } as JournalMeta,
    };
    const r = rows([t], meta)[0];
    expect(rotationContextOf(r)).toBe('Positive Pressure at Entry');
  });

  it('returns null — never a reconstructed value — when no snapshot exists', () => {
    expect(rotationContextOf(rows([trade()])[0])).toBeNull();
  });
});

// ── R-multiple ───────────────────────────────────────────────────────────────

describe('R-multiple', () => {
  it('is computed only when a stop was recorded', () => {
    const withStop = rows([trade({ entry_price: 10, stop_loss: 9, qty: 100, realized_pnl: 200 })])[0];
    expect(withStop.rMultiple).toBeCloseTo(2, 4);   // risked $100, made $200
    expect(rows([trade({ stop_loss: null })])[0].rMultiple).toBeNull();
  });
});

// ── reconciliation ───────────────────────────────────────────────────────────

describe('reconciliation', () => {
  it('reports no diagnostics for consistent data', () => {
    const set = rows([
      trade({ realized_pnl: 1000, date_of_sale: '2025-01-10' }),
      trade({ realized_pnl: -400, win_loss: 'LOSS', date_of_sale: '2025-02-10' }),
    ]);
    const stats = computeCoreStats(set);
    const curve = computeEquityCurve(set);
    const monthly = computeMonthly(set);
    expect(validateJournal(set, stats, curve, monthly)).toEqual([]);
  });
});

// ── insights ─────────────────────────────────────────────────────────────────

describe('insights', () => {
  it('only reports strategies with enough trades to matter', () => {
    const set = rows([
      trade({ strategy: 'Sector Rotation', realized_pnl: 3000 }),
      trade({ strategy: 'Sector Rotation', realized_pnl: 2000 }),
      trade({ strategy: 'Sector Rotation', realized_pnl: 1000 }),
      trade({ strategy: 'OneOff', realized_pnl: 99999 }),
    ]);
    const ins = computeInsights(set, computeHoldingStats(set));
    const best = ins.find(i => i.label === 'Best performing strategy');
    expect(best?.value).toBe('Sector Rotation');   // not the single 99999 trade
  });

  it('surfaces the winner/loser holding gap', () => {
    const set = rows([
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-02-01', realized_pnl: 100 }),
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-01-04', realized_pnl: -50, win_loss: 'LOSS' }),
    ]);
    const ins = computeInsights(set, computeHoldingStats(set));
    expect(ins.some(i => /hold winners longer/i.test(i.label))).toBe(true);
  });

  it('returns nothing for an empty journal rather than filler', () => {
    expect(computeInsights([], computeHoldingStats([]))).toEqual([]);
  });
});
