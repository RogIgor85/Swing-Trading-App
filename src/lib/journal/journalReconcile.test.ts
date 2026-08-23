import { describe, it, expect } from 'vitest';
import {
  buildRows, computeCoreStats, segmentBy, computeHoldingStats,
  computeEquityCurve, computeDrawdown, computeMonthly, computeInsights,
  closedTradesForAnalytics, dateValidTrades, dateCoverage, excludedFromCurveCAD,
  buildReconciliation, strategyDurationFlag, UNCLASSIFIED,
} from './journalStats';
import type { JournalMeta } from './journalMeta';
import type { TradeJournalEntry, Account, Currency } from '../../types';

const FX = 1.40;
let sr = 0;

function trade(over: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  sr += 1;
  return {
    id: `r${sr}`, sr_no: sr, date_of_buy: '2025-01-10',
    account: 'TFSA' as Account, ticker: 'AAA', company: '', industry: '',
    period: '', strategy: 'Momentum', currency: 'CAD' as Currency,
    qty: 100, entry_price: 10, stop_loss: null, position_size: 1000,
    date_of_sale: '2025-01-20', exit_qty: 100, exit_price: 12,
    net_qty: 0, avg_exit_price: 12, realized_pnl: 200, realized_pnl_pct: 0.2,
    win_loss: 'WIN', status: 'CLOSED', notes: '', created_at: new Date().toISOString(),
    ...over,
  };
}

const rows = (ts: TradeJournalEntry[], meta: Record<string, JournalMeta> = {}) =>
  buildRows(ts, meta, FX);

/** Mixed currencies, one bad-date row, one unclassified strategy. */
const mixed = () => rows([
  trade({ ticker: 'A', realized_pnl: 1000, currency: 'CAD' as Currency, date_of_buy: '2025-01-01', date_of_sale: '2025-01-20', account: 'TFSA' as Account, strategy: 'Momentum' }),
  trade({ ticker: 'B', realized_pnl: 500,  currency: 'USD' as Currency, date_of_buy: '2025-02-01', date_of_sale: '2025-02-20', account: 'RRSP' as Account, strategy: '' }),
  trade({ ticker: 'C', realized_pnl: -300, currency: 'USD' as Currency, date_of_buy: '2025-03-01', date_of_sale: '2025-03-20', account: 'LIRA' as Account, strategy: 'Lotto', win_loss: 'LOSS' }),
  trade({ ticker: 'D', realized_pnl: 250,  currency: 'CAD' as Currency, date_of_buy: '2025-05-01', date_of_sale: '2025-04-01', account: 'TFSA' as Account, strategy: 'Momentum' }),
]);

describe('canonical dataset', () => {
  it('every analytic derives from the same closed-trade collection', () => {
    const set = mixed();
    expect(closedTradesForAnalytics(set)).toHaveLength(4);
    expect(dateValidTrades(set)).toHaveLength(3);   // D excluded for bad dates
    expect(dateCoverage(set)).toEqual({ used: 3, total: 4, excluded: 1 });
  });

  it('gross wins + gross losses = net realized P&L in CAD', () => {
    const s = computeCoreStats(mixed());
    expect(s.grossWinsCAD + s.grossLossesCAD).toBeCloseTo(s.netPnlCAD, 6);
    expect(s.netPnlCAD).toBeCloseTo(1000 + 500 * FX - 300 * FX + 250, 4);
  });

  it('profit factor equals the displayed gross figures exactly', () => {
    const s = computeCoreStats(mixed());
    expect(s.profitFactor).toBeCloseTo(s.grossWinsCAD / Math.abs(s.grossLossesCAD), 10);
  });

  it('payoff ratio equals the displayed average figures exactly', () => {
    const s = computeCoreStats(mixed());
    expect(s.payoffRatio).toBeCloseTo(s.avgWinCAD! / Math.abs(s.avgLossCAD!), 10);
  });

  it('expectancy reconciles with the visible win/loss counts', () => {
    const s = computeCoreStats(mixed());
    const winRate = s.wins / s.trades;
    const lossRate = s.losses / s.trades;
    expect(s.expectancyCAD).toBeCloseTo(
      winRate * (s.avgWinCAD ?? 0) - lossRate * Math.abs(s.avgLossCAD ?? 0), 6);
  });
});

describe('segment reconciliation', () => {
  it('account totals reconcile to net realized P&L', () => {
    const set = mixed();
    const total = segmentBy(set, r => r.t.account).reduce((x, seg) => x + seg.netPnlCAD, 0);
    expect(total).toBeCloseTo(computeCoreStats(set).netPnlCAD, 6);
  });

  it('strategy totals reconcile once unclassified trades are kept', () => {
    const set = mixed();
    const net = computeCoreStats(set).netPnlCAD;
    const withFallback = segmentBy(set, r => r.t.strategy || null, UNCLASSIFIED);
    expect(withFallback.some(x => x.key === UNCLASSIFIED)).toBe(true);
    expect(withFallback.reduce((x, seg) => x + seg.netPnlCAD, 0)).toBeCloseTo(net, 6);
    // Without the fallback the unclassified trade would silently vanish
    const without = segmentBy(set, r => r.t.strategy || null);
    expect(without.reduce((x, seg) => x + seg.netPnlCAD, 0)).not.toBeCloseTo(net, 2);
  });
});

describe('time-series reconciliation', () => {
  it('curve and monthly totals tie to the date-valid subset', () => {
    const set = mixed();
    const net = computeCoreStats(set).netPnlCAD;
    const expected = net - excludedFromCurveCAD(set);
    const curve = computeEquityCurve(set);
    expect(curve[curve.length - 1].cum).toBeCloseTo(expected, 2);
    expect(computeMonthly(set).reduce((x, m) => x + m.pnl, 0)).toBeCloseTo(expected, 2);
  });

  it('bad-date trades count in P&L but never appear on the timeline', () => {
    const set = mixed();
    expect(computeCoreStats(set).trades).toBe(4);
    expect(computeEquityCurve(set)).toHaveLength(3);
    expect(excludedFromCurveCAD(set)).toBeCloseTo(250, 4);
  });

  it('max drawdown comes from the same reconciled curve', () => {
    const curve = computeEquityCurve(mixed());
    const dd = computeDrawdown(curve);
    let peak = 0, worst = 0;
    for (const p of curve) { peak = Math.max(peak, p.cum); worst = Math.min(worst, p.cum - peak); }
    expect(dd.maxDrawdownCAD).toBeCloseTo(worst, 2);
  });

  it('reports no diagnostics for a consistent dataset', () => {
    const rec = buildReconciliation(mixed());
    expect(rec.diagnostics).toEqual([]);
    expect(rec.verified).toBe(true);
    expect(rec.dateCoverage.excluded).toBe(1);
  });
});

describe('P&L percentage', () => {
  it('derives from prices rather than a wrong stored field', () => {
    const r = rows([trade({ entry_price: 10, avg_exit_price: 19.095, exit_price: 19.095, realized_pnl_pct: -0.0091 })])[0];
    expect(r.pnlPctSource).toBe('prices');
    expect(r.pnlPct).toBeCloseTo(90.95, 2);
  });

  it('normalises a stored decimal when prices are unavailable', () => {
    const r = rows([trade({ entry_price: 10, avg_exit_price: null, exit_price: null, realized_pnl_pct: 0.9095 })])[0];
    expect(r.pnlPctSource).toBe('stored');
    expect(r.pnlPct).toBeCloseTo(90.95, 2);
  });

  it('leaves an already-percent stored value alone', () => {
    const r = rows([trade({ entry_price: 10, avg_exit_price: null, exit_price: null, realized_pnl_pct: 90.95 })])[0];
    expect(r.pnlPct).toBeCloseTo(90.95, 2);
  });

  it('returns null when neither prices nor a stored value exist', () => {
    const r = rows([trade({ entry_price: 10, avg_exit_price: null, exit_price: null, realized_pnl_pct: null })])[0];
    expect(r.pnlPct).toBeNull();
    expect(r.pnlPctSource).toBe('none');
  });
});

describe('strategy duration flag', () => {
  it('flags a hold outside the strategy window without rewriting the tag', () => {
    const r = rows([trade({ strategy: 'Swing 1-15 days', date_of_buy: '2025-01-01', date_of_sale: '2025-02-17' })])[0];
    expect(strategyDurationFlag(r)).toMatch(/outside/i);
    expect(r.t.strategy).toBe('Swing 1-15 days');
  });

  it('does not flag a hold inside the window', () => {
    const r = rows([trade({ strategy: 'Swing 1-15 days', date_of_buy: '2025-01-01', date_of_sale: '2025-01-08' })])[0];
    expect(strategyDurationFlag(r)).toBeNull();
  });

  it('does not flag when dates are invalid', () => {
    const r = rows([trade({ strategy: 'Swing 1-15 days', date_of_buy: '2025-03-01', date_of_sale: '2025-02-01' })])[0];
    expect(strategyDurationFlag(r)).toBeNull();
  });
});

describe('coverage-aware insights', () => {
  it('labels holding conclusions with the date-valid count', () => {
    const set = rows([
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-02-01', realized_pnl: 100 }),
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-02-05', realized_pnl: 100 }),
      trade({ date_of_buy: '2025-01-01', date_of_sale: '2025-01-04', realized_pnl: -50, win_loss: 'LOSS' }),
      trade({ date_of_buy: '2025-05-01', date_of_sale: '2025-04-01', realized_pnl: 10 }),
    ]);
    const ins = computeInsights(set, computeHoldingStats(set), dateCoverage(set));
    const gap = ins.find(i => /hold winners longer/i.test(i.label));
    expect(gap?.detail).toMatch(/3 date-valid trades/);
  });

  it('suppresses holding conclusions when too few date-valid trades exist', () => {
    const set = rows([
      trade({ date_of_buy: '2025-05-01', date_of_sale: '2025-04-01', realized_pnl: 100 }),
      trade({ date_of_buy: '2025-06-01', date_of_sale: '2025-05-01', realized_pnl: -50, win_loss: 'LOSS' }),
    ]);
    const ins = computeInsights(set, computeHoldingStats(set), dateCoverage(set));
    expect(ins.some(i => /held/i.test(i.label))).toBe(false);
  });
});
