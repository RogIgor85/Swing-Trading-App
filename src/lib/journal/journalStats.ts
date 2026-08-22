// ─────────────────────────────────────────────────────────────────────────────
// Trade Journal statistics. Pure calculations, no fetching, no UI.
//
// Two rules that were previously violated:
//   1. Profit Factor is GROSS wins ÷ GROSS losses. Average win ÷ average loss
//      is the Payoff Ratio — a different metric.
//   2. USD and CAD P&L are never summed raw. Everything reported is CAD.
//
// Only CLOSED trades contribute to realized statistics. Breakeven trades
// (P&L exactly 0) are counted separately and never treated as wins or losses,
// but remain in the rate denominators.
// ─────────────────────────────────────────────────────────────────────────────

import { HOLDING_BUCKETS } from '../../config/journalConfig';
import type { TradeJournalEntry } from '../../types';
import type { JournalMeta } from './journalMeta';

export interface TradeRow {
  t: TradeJournalEntry;
  meta: JournalMeta;
  /** Realized P&L converted to CAD. */
  pnlCAD: number;
  pnlPct: number | null;
  entryDate: string;
  exitDate: string | null;
  daysHeld: number | null;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  rMultiple: number | null;
  /** exit date earlier than entry date — flagged, never auto-corrected */
  invalidDates: boolean;
}

export interface CoreStats {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;          // wins / (wins+losses+breakeven)
  grossWinsCAD: number;
  grossLossesCAD: number;          // negative
  netPnlCAD: number;
  avgWinCAD: number | null;
  avgLossCAD: number | null;       // negative
  avgTradeCAD: number | null;
  profitFactor: number | null;     // gross wins / |gross losses|
  payoffRatio: number | null;      // avg win / |avg loss|
  expectancyCAD: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Calendar days between two ISO dates; null when either is missing/invalid. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Exit must not precede entry. Used for validation and for flagging old rows. */
export function hasInvalidDates(entry: string | null | undefined, exit: string | null | undefined): boolean {
  const d = daysBetween(entry, exit);
  return d != null && d < 0;
}

export function buildRows(
  trades: TradeJournalEntry[],
  metaMap: Record<string, JournalMeta>,
  fxUsdCad: number,
): TradeRow[] {
  return trades.map((t) => {
    const fx = t.currency === 'USD' ? fxUsdCad : 1;
    const pnlNative = t.realized_pnl ?? 0;
    const pnlCAD = pnlNative * fx;
    const exitDate = t.date_of_sale ?? null;
    const daysHeld = daysBetween(t.date_of_buy, exitDate);

    // Breakeven is explicit — never silently a win or a loss
    const outcome: TradeRow['outcome'] =
      t.status !== 'CLOSED' ? 'BREAKEVEN'
      : pnlNative > 0 ? 'WIN'
      : pnlNative < 0 ? 'LOSS'
      : 'BREAKEVEN';

    // R-multiple only when a real stop was recorded
    let rMultiple: number | null = null;
    if (t.stop_loss != null && t.stop_loss > 0 && t.entry_price > 0 && t.qty > 0) {
      const riskPerShare = Math.abs(t.entry_price - t.stop_loss);
      const totalRisk = riskPerShare * t.qty;
      if (totalRisk > 0) rMultiple = round2(pnlNative / totalRisk);
    }

    return {
      t, meta: metaMap[t.id] ?? {},
      pnlCAD, pnlPct: t.realized_pnl_pct ?? null,
      entryDate: t.date_of_buy, exitDate,
      daysHeld: daysHeld != null && daysHeld >= 0 ? daysHeld : null,
      outcome, rMultiple,
      invalidDates: hasInvalidDates(t.date_of_buy, exitDate),
    };
  });
}

/** Core statistics over CLOSED rows only. */
export function computeCoreStats(rows: TradeRow[]): CoreStats {
  const closed = rows.filter(r => r.t.status === 'CLOSED');
  const wins = closed.filter(r => r.outcome === 'WIN');
  const losses = closed.filter(r => r.outcome === 'LOSS');
  const breakeven = closed.filter(r => r.outcome === 'BREAKEVEN');

  const grossWinsCAD = wins.reduce((s, r) => s + r.pnlCAD, 0);
  const grossLossesCAD = losses.reduce((s, r) => s + r.pnlCAD, 0);   // negative
  const netPnlCAD = grossWinsCAD + grossLossesCAD;

  const avgWinCAD = wins.length > 0 ? grossWinsCAD / wins.length : null;
  const avgLossCAD = losses.length > 0 ? grossLossesCAD / losses.length : null;
  const avgTradeCAD = closed.length > 0 ? netPnlCAD / closed.length : null;

  // Profit Factor = gross wins / |gross losses|  (NOT avg win / avg loss)
  const profitFactor = Math.abs(grossLossesCAD) > 0
    ? grossWinsCAD / Math.abs(grossLossesCAD)
    : (grossWinsCAD > 0 ? Infinity : null);

  // Payoff Ratio = avg win / |avg loss|
  const payoffRatio = avgWinCAD != null && avgLossCAD != null && Math.abs(avgLossCAD) > 0
    ? avgWinCAD / Math.abs(avgLossCAD)
    : null;

  const denom = closed.length;
  const winRate = denom > 0 ? (wins.length / denom) * 100 : null;
  const lossRate = denom > 0 ? losses.length / denom : 0;
  const expectancyCAD = denom > 0
    ? ((wins.length / denom) * (avgWinCAD ?? 0)) - (lossRate * Math.abs(avgLossCAD ?? 0))
    : null;

  return {
    trades: closed.length,
    wins: wins.length, losses: losses.length, breakeven: breakeven.length,
    winRate, grossWinsCAD, grossLossesCAD, netPnlCAD,
    avgWinCAD, avgLossCAD, avgTradeCAD,
    profitFactor, payoffRatio, expectancyCAD,
  };
}

// ── segmentation ─────────────────────────────────────────────────────────────

export interface Segment extends CoreStats { key: string }

export function segmentBy(rows: TradeRow[], keyOf: (r: TradeRow) => string | null): Segment[] {
  const groups = new Map<string, TradeRow[]>();
  for (const r of rows.filter(x => x.t.status === 'CLOSED')) {
    const k = keyOf(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, ...computeCoreStats(rs) }))
    .sort((a, b) => b.netPnlCAD - a.netPnlCAD);
}

export function holdingBucketOf(daysHeld: number | null): string | null {
  if (daysHeld == null) return null;
  const b = HOLDING_BUCKETS.find(x => daysHeld >= x.min && daysHeld <= x.max);
  return b?.label ?? null;
}

/** Rotation context from the snapshot stored AT ENTRY. Never reconstructed. */
export function rotationContextOf(r: TradeRow): string | null {
  const s = r.meta.sector_entry;
  if (!s || s.rotationPressure == null) return null;
  return s.rotationPressure > 0 ? 'Positive Pressure at Entry' : 'Negative Pressure at Entry';
}

export function rotationStatusOf(r: TradeRow): string | null {
  return r.meta.sector_entry?.rotationStatus ?? null;
}

// ── holding period ───────────────────────────────────────────────────────────

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

export interface HoldingStats {
  avgAll: number | null;
  avgWinners: number | null;
  avgLosers: number | null;
  medianWinners: number | null;
  medianLosers: number | null;
}

export function computeHoldingStats(rows: TradeRow[]): HoldingStats {
  const closed = rows.filter(r => r.t.status === 'CLOSED' && r.daysHeld != null);
  const d = (rs: TradeRow[]) => rs.map(r => r.daysHeld!) as number[];
  const winners = closed.filter(r => r.outcome === 'WIN');
  const losers = closed.filter(r => r.outcome === 'LOSS');
  return {
    avgAll: mean(d(closed)),
    avgWinners: mean(d(winners)),
    avgLosers: mean(d(losers)),
    medianWinners: median(d(winners)),
    medianLosers: median(d(losers)),
  };
}

// ── best / worst ─────────────────────────────────────────────────────────────

export interface Extremes {
  bestByDollar: TradeRow | null;
  worstByDollar: TradeRow | null;
  bestByPct: TradeRow | null;
  worstByPct: TradeRow | null;
}

export function computeExtremes(rows: TradeRow[]): Extremes {
  const closed = rows.filter(r => r.t.status === 'CLOSED');
  if (closed.length === 0) {
    return { bestByDollar: null, worstByDollar: null, bestByPct: null, worstByPct: null };
  }
  const withPct = closed.filter(r => r.pnlPct != null);
  const maxBy = <T>(xs: T[], f: (x: T) => number) =>
    xs.length ? xs.reduce((a, b) => (f(b) > f(a) ? b : a)) : null;
  const minBy = <T>(xs: T[], f: (x: T) => number) =>
    xs.length ? xs.reduce((a, b) => (f(b) < f(a) ? b : a)) : null;
  return {
    bestByDollar: maxBy(closed, r => r.pnlCAD),
    worstByDollar: minBy(closed, r => r.pnlCAD),
    bestByPct: maxBy(withPct, r => r.pnlPct!),
    worstByPct: minBy(withPct, r => r.pnlPct!),
  };
}

// ── equity curve and drawdown ────────────────────────────────────────────────

export interface EquityPoint {
  label: string;
  date: string;
  cum: number;
  drawdown: number;   // <= 0
}

/**
 * Cumulative realized P&L ordered by EXIT date (entry date is irrelevant to
 * when profit is realized), with a deterministic tie-break so same-day closes
 * always order identically.
 */
export function computeEquityCurve(rows: TradeRow[]): EquityPoint[] {
  const closed = rows
    .filter(r => r.t.status === 'CLOSED')
    .sort((a, b) => {
      const da = a.exitDate ?? a.entryDate;
      const db = b.exitDate ?? b.entryDate;
      if (da !== db) return da.localeCompare(db);
      if (a.t.sr_no !== b.t.sr_no) return a.t.sr_no - b.t.sr_no;
      return a.t.id.localeCompare(b.t.id);
    });

  let cum = 0, peak = 0;
  return closed.map((r) => {
    cum += r.pnlCAD;
    peak = Math.max(peak, cum);
    return {
      label: `${r.t.ticker} (${r.exitDate ?? r.entryDate})`,
      date: r.exitDate ?? r.entryDate,
      cum: round2(cum),
      drawdown: round2(cum - peak),
    };
  });
}

export interface DrawdownStats {
  maxDrawdownCAD: number;      // <= 0
  peakCAD: number;
  troughCAD: number;
  currentDrawdownCAD: number;
}

export function computeDrawdown(curve: EquityPoint[]): DrawdownStats {
  if (curve.length === 0) {
    return { maxDrawdownCAD: 0, peakCAD: 0, troughCAD: 0, currentDrawdownCAD: 0 };
  }
  let peak = 0, maxDd = 0, peakAtMax = 0, troughAtMax = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.cum);
    const dd = p.cum - peak;
    if (dd < maxDd) { maxDd = dd; peakAtMax = peak; troughAtMax = p.cum; }
  }
  const last = curve[curve.length - 1];
  const finalPeak = curve.reduce((m, p) => Math.max(m, p.cum), 0);
  return {
    maxDrawdownCAD: round2(maxDd),
    peakCAD: round2(peakAtMax),
    troughCAD: round2(troughAtMax),
    currentDrawdownCAD: round2(last.cum - finalPeak),
  };
}

// ── monthly attribution (by EXIT date — when P&L was realized) ───────────────

export interface MonthlyPoint { month: string; pnl: number; wins: number; losses: number }

export function computeMonthly(rows: TradeRow[]): MonthlyPoint[] {
  const map = new Map<string, MonthlyPoint>();
  for (const r of rows.filter(x => x.t.status === 'CLOSED')) {
    const key = (r.exitDate ?? r.entryDate).slice(0, 7);
    const cur = map.get(key) ?? { month: key, pnl: 0, wins: 0, losses: 0 };
    cur.pnl += r.pnlCAD;
    if (r.outcome === 'WIN') cur.wins++;
    if (r.outcome === 'LOSS') cur.losses++;
    map.set(key, cur);
  }
  return [...map.values()]
    .map(m => ({ ...m, pnl: round2(m.pnl) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ── reconciliation ───────────────────────────────────────────────────────────

export interface JournalDiagnostic { label: string; expected: number; actual: number; diff: number }

export function validateJournal(rows: TradeRow[], stats: CoreStats, curve: EquityPoint[], monthly: MonthlyPoint[]): JournalDiagnostic[] {
  const out: JournalDiagnostic[] = [];
  const push = (label: string, expected: number, actual: number, tol = 0.05) => {
    if (Math.abs(actual - expected) > tol) out.push({ label, expected, actual, diff: actual - expected });
  };
  push('Gross wins + gross losses = net realized P&L', stats.netPnlCAD, stats.grossWinsCAD + stats.grossLossesCAD);
  push('Sum of closed trade P&L = net realized P&L',
    stats.netPnlCAD, rows.filter(r => r.t.status === 'CLOSED').reduce((s, r) => s + r.pnlCAD, 0));
  if (curve.length > 0) push('Cumulative curve final value = net realized P&L', stats.netPnlCAD, curve[curve.length - 1].cum);
  push('Monthly P&L total = net realized P&L', stats.netPnlCAD, monthly.reduce((s, m) => s + m.pnl, 0));
  push('Win + loss + breakeven = closed trades', stats.trades, stats.wins + stats.losses + stats.breakeven, 0);
  return out;
}

// ── deterministic insights ───────────────────────────────────────────────────

export interface Insight { label: string; value: string; detail?: string }

export function computeInsights(rows: TradeRow[], holding: HoldingStats): Insight[] {
  const out: Insight[] = [];
  const MIN_TRADES = 3;   // don't draw conclusions from one or two trades

  const strategies = segmentBy(rows, r => r.t.strategy || null).filter(s => s.trades >= MIN_TRADES);
  if (strategies.length > 0) {
    const best = strategies[0];
    out.push({ label: 'Best performing strategy', value: best.key,
      detail: `${best.trades} trades · ${best.netPnlCAD >= 0 ? '+' : ''}$${Math.round(best.netPnlCAD).toLocaleString()} · ${best.winRate?.toFixed(0)}% win rate` });
    const byExp = [...strategies].sort((a, b) => (b.expectancyCAD ?? -Infinity) - (a.expectancyCAD ?? -Infinity));
    if (byExp[0] && byExp[0].expectancyCAD != null && byExp[0].key !== best.key) {
      out.push({ label: 'Highest expectancy', value: byExp[0].key,
        detail: `${byExp[0].expectancyCAD >= 0 ? '+' : ''}$${Math.round(byExp[0].expectancyCAD).toLocaleString()} per trade` });
    }
    const worst = strategies[strategies.length - 1];
    if (worst.key !== best.key && worst.netPnlCAD < 0) {
      out.push({ label: 'Worst performing strategy', value: worst.key,
        detail: `${worst.trades} trades · $${Math.round(worst.netPnlCAD).toLocaleString()}` });
    }
  }

  if (holding.avgWinners != null && holding.avgLosers != null) {
    out.push({ label: 'Average winner held', value: `${holding.avgWinners.toFixed(0)} days` });
    out.push({ label: 'Average loser held', value: `${holding.avgLosers.toFixed(0)} days` });
    const gap = holding.avgWinners - holding.avgLosers;
    if (Math.abs(gap) >= 3) {
      out.push({
        label: gap > 0 ? 'You hold winners longer' : 'You hold losers longer',
        value: `${Math.abs(gap).toFixed(0)} day difference`,
        detail: gap > 0 ? 'Letting winners run' : 'Cutting winners faster than losers',
      });
    }
  }

  const plan = segmentBy(rows, r => r.meta.followed_plan ?? null).filter(s => s.trades >= MIN_TRADES);
  const followed = plan.find(s => s.key === 'Yes');
  const notFollowed = plan.find(s => s.key === 'No');
  if (followed && notFollowed && followed.expectancyCAD != null && notFollowed.expectancyCAD != null) {
    out.push({
      label: 'Following your plan',
      value: followed.expectancyCAD > notFollowed.expectancyCAD ? 'Improves results' : 'No measured benefit yet',
      detail: `Expectancy $${Math.round(followed.expectancyCAD).toLocaleString()} vs $${Math.round(notFollowed.expectancyCAD).toLocaleString()}`,
    });
  }

  return out;
}

// ── date range filtering (by exit date for closed trades) ────────────────────

export function inDateRange(r: TradeRow, from: Date | null, to: Date | null): boolean {
  const d = new Date(r.exitDate ?? r.entryDate).getTime();
  if (isNaN(d)) return true;
  if (from && d < from.getTime()) return false;
  if (to && d > to.getTime()) return false;
  return true;
}
