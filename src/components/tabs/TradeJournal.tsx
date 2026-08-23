import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, TrendingUp, TrendingDown, X, Edit2, Check, ExternalLink, RefreshCw, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import { toYahooTicker } from '../FundamentalsDrawer';
import { fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import { getUsdCad, getUsdCadCached } from '../../lib/fx';
import FundamentalsDrawer from '../FundamentalsDrawer';
import { loadJournalMeta, setJournalMeta } from '../../lib/journal/journalMeta';
import type { JournalMeta } from '../../lib/journal/journalMeta';
import {
  buildRows, computeCoreStats, computeHoldingStats, computeExtremes,
  computeEquityCurve, computeDrawdown, computeMonthly, segmentBy,
  holdingBucketOf, rotationContextOf, computeInsights, buildReconciliation,
  dateCoverage, strategyDurationFlag, UNCLASSIFIED,
  inDateRange, hasInvalidDates,
} from '../../lib/journal/journalStats';
import type { Segment } from '../../lib/journal/journalStats';
import {
  EXIT_REASONS, MISTAKE_CATEGORIES, FOLLOWED_PLAN_OPTIONS,
  PROFIT_FACTOR_HELP, PAYOFF_RATIO_HELP, EXPECTANCY_HELP, DRAWDOWN_HELP, CURRENCY_HELP,
} from '../../config/journalConfig';
import type { DateRangeKey } from '../../config/journalConfig';
import type { TradeJournalEntry, Account, Currency } from '../../types';

const TABLE = 'trade_journal';
const ACCOUNTS: Account[] = ['Brokerage', 'RRSP', 'LIRA', 'TSFA', 'HSA', 'Other'];
const STRATEGIES = ['Swing 1-15 days', 'Short < 6 months', 'Long 1+ Year', 'Core (Forever)', 'Trend'];

const defaultForm = {
  date_of_buy: new Date().toISOString().split('T')[0],
  account: 'Brokerage' as Account,
  ticker: '',
  company: '',
  industry: '',
  period: 'Swing',
  strategy: 'Swing 1-15 days',
  currency: 'USD' as Currency,
  qty: '',
  entry_price: '',
  stop_loss: '',
  date_of_sale: '',
  exit_price: '',
  notes: '',
};

const accountColors: Record<Account, string> = {
  Brokerage: 'text-blue-400',
  RRSP:      'text-emerald-400',
  LIRA:      'text-purple-400',
  TSFA:      'text-amber-400',
  HSA:       'text-cyan-400',
  Crypto:    'text-orange-400',
  Other:     'text-zinc-400',
};

const TOOLTIP_STYLE = {
  contentStyle: { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 },
  labelStyle:   { color: '#ffffff', fontWeight: 600 },
  itemStyle:    { color: '#ffffff' },
};

type SortKey = 'sr_no' | 'date_of_buy' | 'ticker' | 'account' | 'currency' | 'qty'
  | 'entry_price' | 'date_of_sale' | 'avg_exit_price' | 'realized_pnl' | 'realized_pnl_pct'
  | 'status' | 'strategy' | 'position_size';

const SORT_COLS: { label: string; key: SortKey }[] = [
  { label: '#',          key: 'sr_no'            },
  { label: 'Date',       key: 'date_of_buy'      },
  { label: 'Ticker',     key: 'ticker'           },
  { label: 'Account',    key: 'account'          },
  { label: 'Cur',        key: 'currency'         },
  { label: 'Qty',        key: 'qty'              },
  { label: 'Entry',      key: 'entry_price'      },
  { label: 'Exit Date',  key: 'date_of_sale'     },
  { label: 'Held',       key: 'date_of_sale'     },
  { label: 'Strategy',   key: 'strategy'         },
  { label: 'Exit Price', key: 'avg_exit_price'   },
  { label: 'P&L',        key: 'realized_pnl'     },
  { label: 'P&L %',      key: 'realized_pnl_pct' },
  { label: 'Result',     key: 'status'           },
];

/**
 * Inline date cell. Click to edit, Save/Cancel to commit. Used to repair
 * historical records without opening the full form. Validation happens on save
 * so an already-invalid record can still be opened and corrected.
 */
function EditableDate({
  value, otherDate, kind, invalid, onSave, allowBlank,
}: {
  value: string | null;
  otherDate: string | null;
  kind: 'entry' | 'exit';
  invalid?: boolean;
  allowBlank?: boolean;
  onSave: (next: string | null) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function open() { setDraft(value ?? ''); setErr(null); setEditing(true); }

  async function commit() {
    const next = draft || null;
    if (!next && !allowBlank) { setErr('Date required'); return; }
    // Compare against the trade's other date in the correct direction
    const entry = kind === 'entry' ? next : otherDate;
    const exit  = kind === 'exit'  ? next : otherDate;
    if (entry && exit && hasInvalidDates(entry, exit)) {
      setErr('Exit date cannot be earlier than entry date.');
      return;
    }
    setSaving(true);
    try { await onSave(next); setEditing(false); } finally { setSaving(false); }
  }

  if (!editing) {
    return (
      <button onClick={open}
        title={invalid ? 'Exit date occurs before entry date — click to correct' : 'Click to edit'}
        className={`text-xs hover:underline underline-offset-2 decoration-dotted text-left ${
          invalid ? 'text-amber-400' : 'text-zinc-400 hover:text-zinc-200'}`}>
        {value ?? '—'}{invalid && <span className="ml-1">⚠</span>}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <input type="date" autoFocus value={draft}
        onChange={(e) => { setDraft(e.target.value); setErr(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className="bg-zinc-800 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none" />
      <div className="flex gap-1">
        <button onClick={commit} disabled={saving}
          className="text-xs px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
          {saving ? '…' : 'Save'}
        </button>
        <button onClick={() => setEditing(false)} className="text-xs px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
      </div>
      {err && <span className="text-xs text-red-400 whitespace-nowrap">{err}</span>}
    </div>
  );
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: 'asc' | 'desc' }) {
  if (sortKey !== col) return <ChevronsUpDown size={12} className="text-zinc-500 group-hover:text-zinc-300 transition-colors" />;
  return sortDir === 'asc' ? <ChevronUp size={12} className="text-blue-400" /> : <ChevronDown size={12} className="text-blue-400" />;
}

export default function TradeJournal() {
  const [trades, setTrades]               = useState<TradeJournalEntry[]>([]);
  const [showForm, setShowForm]           = useState(false);
  const [form, setForm]                   = useState(defaultForm);
  const [editId, setEditId]               = useState<string | null>(null);
  const [loading, setLoading]             = useState(false);
  const [filterStatus, setFilterStatus]   = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [filterAccount, setFilterAccount] = useState<string>('ALL');
  const [drawer, setDrawer]               = useState<{ ticker: string; currency: string } | null>(null);

  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [pricesLoading, setPricesLoading] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>('date_of_buy');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [journalMeta, setJMeta]   = useState(loadJournalMeta);
  const [usdCadRate, setUsdCad]   = useState<number>(getUsdCadCached);
  const [dateRange, setDateRange] = useState<DateRangeKey>('ALL');
  const [chartMode, setChartMode] = useState<'pnl' | 'drawdown'>('pnl');
  const [dateError, setDateError] = useState<string | null>(null);
  const [metaForm, setMetaForm]   = useState<JournalMeta>({});
  const [showDateRepair, setShowDateRepair] = useState(false);

  useEffect(() => { getUsdCad().then(setUsdCad).catch(() => { /* keep cached */ }); }, []);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'date_of_buy' || key === 'date_of_sale' ? 'desc' : 'asc'); }
  }

  const load = useCallback(async () => {
    const data = await storage.getAll<TradeJournalEntry>(TABLE);
    setTrades(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function fetchPrice(ticker: string, currency: string): Promise<number | null> {
    try {
      const q = await finnhub.quote(ticker);
      if (q.c && q.c > 0) return q.c;
    } catch { /* try Yahoo */ }
    try {
      const yahooTicker = toYahooTicker(ticker, currency);
      const y = await fetchYahoo(yahooTicker);
      return y.price?.regularMarketPrice ?? null;
    } catch { return null; }
  }

  async function refreshLivePrices() {
    const openTrades = trades.filter((t) => t.status === 'OPEN');
    if (openTrades.length === 0) return;
    setPricesLoading(true);
    const results = await Promise.all(
      openTrades.map(async (t) => {
        const price = await fetchPrice(t.ticker, t.currency);
        return { ticker: t.ticker, price };
      })
    );
    const map: Record<string, number> = {};
    results.forEach(({ ticker, price }) => { if (price) map[ticker] = price; });
    setLivePrices(map);
    setPricesLoading(false);
  }

  useEffect(() => {
    if (trades.length > 0) refreshLivePrices();
  }, [trades]); // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(t: TradeJournalEntry) {
    setEditId(t.id);
    setForm({
      date_of_buy:  t.date_of_buy,
      account:      t.account,
      ticker:       t.ticker,
      company:      t.company ?? '',
      industry:     t.industry ?? '',
      period:       t.period ?? 'Swing',
      strategy:     t.strategy ?? 'Swing 1-15 days',
      currency:     t.currency,
      qty:          t.qty.toString(),
      entry_price:  t.entry_price.toString(),
      stop_loss:    t.stop_loss?.toString() ?? '',
      date_of_sale: t.date_of_sale ?? '',
      exit_price:   t.exit_price?.toString() ?? '',
      notes:        t.notes ?? '',
    });
    setMetaForm(journalMeta[t.id] ?? {});
    setDateError(null);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelForm() {
    setEditId(null);
    setForm(defaultForm);
    setMetaForm({});
    setDateError(null);
    setShowForm(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker || !form.qty || !form.entry_price) return;

    // Exit can never precede entry — block the write rather than store bad data
    if (hasInvalidDates(form.date_of_buy, form.date_of_sale)) {
      setDateError('Exit date cannot be earlier than entry date.');
      return;
    }
    setDateError(null);
    setLoading(true);
    try {
      const qty        = parseFloat(form.qty);
      const entry      = parseFloat(form.entry_price);
      const exitPrice  = form.exit_price ? parseFloat(form.exit_price) : null;
      const isClosed   = !!(form.date_of_sale && form.exit_price);
      const realizedPnl = isClosed && exitPrice ? (exitPrice - entry) * qty : null;
      const realizedPct = isClosed && entry > 0 && realizedPnl !== null
        ? realizedPnl / (entry * qty) : null;

      const record: TradeJournalEntry = {
        id:               editId ?? newId(),
        sr_no:            editId ? (trades.find((t) => t.id === editId)?.sr_no ?? trades.length + 1) : trades.length + 1,
        date_of_buy:      form.date_of_buy,
        account:          form.account,
        ticker:           form.ticker.toUpperCase(),
        company:          form.company,
        industry:         form.industry,
        period:           form.period,
        strategy:         form.strategy,
        currency:         form.currency,
        qty,
        entry_price:      entry,
        stop_loss:        form.stop_loss ? parseFloat(form.stop_loss) : null,
        position_size:    entry * qty,
        date_of_sale:     form.date_of_sale || null,
        exit_qty:         isClosed ? qty : null,
        exit_price:       exitPrice,
        net_qty:          isClosed ? 0 : qty,
        avg_exit_price:   exitPrice,
        realized_pnl:     realizedPnl,
        realized_pnl_pct: realizedPct,
        win_loss:         realizedPnl != null ? (realizedPnl >= 0 ? 'WIN' : 'LOSS') : null,
        status:           isClosed ? 'CLOSED' : 'OPEN',
        notes:            form.notes,
        created_at:       nowIso(),
      };

      if (editId) {
        await storage.update(TABLE, editId, record);
      } else {
        await storage.insert(TABLE, record);
      }

      // Journal metadata sidecar — keyed by trade id, schema untouched
      if (Object.values(metaForm).some(v => v != null && v !== '')) {
        setJMeta(setJournalMeta(record.id, metaForm));
      }

      cancelForm();
      await load();
    } finally {
      setLoading(false);
    }
  }

  /**
   * Update a single date field. Deliberately writes ONLY that column — prices,
   * quantity, P&L, account, strategy and notes are never touched by a date fix.
   */
  async function saveDate(t: TradeJournalEntry, field: 'date_of_buy' | 'date_of_sale', next: string | null) {
    if (field === 'date_of_buy' && !next) return;      // entry date is required
    await storage.update(TABLE, t.id, { [field]: next });
    setTrades(prev => prev.map(x => x.id === t.id ? { ...x, [field]: next } : x));
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this trade?')) return;
    await storage.remove(TABLE, id);
    await load();
  }

  // ─── Stats (all math lives in journalStats) ──────────────────────────────────
  const allRows = useMemo(() => buildRows(trades, journalMeta, usdCadRate), [trades, journalMeta, usdCadRate]);

  // Date-range scoping — closed trades are placed by EXIT date
  const rangeBounds = useMemo(() => {
    const now = new Date();
    if (dateRange === 'YTD') return { from: new Date(now.getFullYear(), 0, 1), to: null };
    if (dateRange === '1Y')  return { from: new Date(now.getTime() - 365 * 86400000), to: null };
    return { from: null, to: null };
  }, [dateRange]);

  const rows = useMemo(
    () => allRows.filter(r => inDateRange(r, rangeBounds.from, rangeBounds.to)),
    [allRows, rangeBounds]);

  const stats         = useMemo(() => computeCoreStats(rows), [rows]);
  const holdingStats  = useMemo(() => computeHoldingStats(rows), [rows]);
  const extremes      = useMemo(() => computeExtremes(rows), [rows]);
  const equityCurve   = useMemo(() => computeEquityCurve(rows), [rows]);
  const drawdown      = useMemo(() => computeDrawdown(equityCurve), [equityCurve]);
  const monthlyData   = useMemo(() => computeMonthly(rows), [rows]);
  // Strategy segments keep unclassified trades so totals reconcile
  const byStrategy    = useMemo(() => segmentBy(rows, r => r.t.strategy || null, UNCLASSIFIED), [rows]);
  const byAccount     = useMemo(() => segmentBy(rows, r => r.t.account), [rows]);
  // Holding buckets are date-dependent — only date-valid trades qualify
  const byHolding     = useMemo(() => segmentBy(rows, r => holdingBucketOf(r.daysHeld)), [rows]);
  const byRotation    = useMemo(() => segmentBy(rows, rotationContextOf), [rows]);
  const coverage      = useMemo(() => dateCoverage(rows), [rows]);
  const insights      = useMemo(() => computeInsights(rows, holdingStats, coverage), [rows, holdingStats, coverage]);
  const reconciliation = useMemo(() => buildReconciliation(rows), [rows]);
  const diagnostics   = reconciliation.diagnostics;
  const excludedPnl   = reconciliation.excludedFromCurveCAD;
  const invalidDateRows = useMemo(() => allRows.filter(r => r.invalidDates), [allRows]);

  // Kept for the existing markup below
  const closed = rows.filter(r => r.t.status === 'CLOSED').map(r => r.t);
  const open   = allRows.filter(r => r.t.status === 'OPEN').map(r => r.t);
  const wins   = rows.filter(r => r.outcome === 'WIN' && r.t.status === 'CLOSED').map(r => r.t);
  const losses = rows.filter(r => r.outcome === 'LOSS' && r.t.status === 'CLOSED').map(r => r.t);
  const totalRealizedPnl = stats.netPnlCAD;
  const winRate = stats.winRate ?? 0;
  const avgWin  = stats.avgWinCAD ?? 0;
  const avgLoss = stats.avgLossCAD ?? 0;
  const profitFactor = stats.profitFactor ?? 0;

  const cumulativeData = equityCurve.map(p => ({ label: p.label, cum: p.cum, dd: p.drawdown }));
  const rowByTradeId = useMemo(() => new Map(allRows.map(r => [r.t.id, r])), [allRows]);

  // Win/Loss donut
  const donutData = [
    { name: 'Wins',      value: stats.wins,      color: '#10b981' },
    { name: 'Losses',    value: stats.losses,    color: '#ef4444' },
    { name: 'Breakeven', value: stats.breakeven, color: '#71717a' },
  ].filter((d) => d.value > 0);

  const uniqueAccounts = [...new Set(trades.map((t) => t.account))];
  const filtered = trades
    .filter((t) => {
      if (filterStatus !== 'ALL' && t.status !== filterStatus) return false;
      if (filterAccount !== 'ALL' && t.account !== filterAccount) return false;
      return true;
    })
    .sort((a, b) => {
      // For P&L on open trades, derive value from live price
      function getSortVal(t: TradeJournalEntry): string | number {
        if (sortKey === 'realized_pnl') {
          if (t.status === 'OPEN') return livePrices[t.ticker] != null ? (livePrices[t.ticker] - t.entry_price) * t.qty : -Infinity;
          return t.realized_pnl ?? -Infinity;
        }
        if (sortKey === 'realized_pnl_pct') {
          if (t.status === 'OPEN') return livePrices[t.ticker] != null ? ((livePrices[t.ticker] - t.entry_price) / t.entry_price) * 100 : -Infinity;
          return (t.realized_pnl_pct ?? -Infinity);
        }
        if (sortKey === 'avg_exit_price') return t.avg_exit_price ?? (livePrices[t.ticker] ?? -Infinity);
        if (sortKey === 'date_of_sale') return t.date_of_sale ?? '';
        const v = t[sortKey as keyof TradeJournalEntry];
        return (v ?? '') as string | number;
      }
      const av = getSortVal(a);
      const bv = getSortVal(b);
      const cmp = typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });

  return (
    <div className="space-y-6">

      {/* ── Date range ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-600">Period:</span>
        {([['YTD', 'YTD'], ['1Y', '1 Year'], ['ALL', 'All Time']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setDateRange(k as DateRangeKey)}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              dateRange === k ? 'bg-blue-900/50 text-blue-300 border-blue-600'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
            {label}
          </button>
        ))}
        <span className="text-xs text-zinc-600 ml-auto" title={CURRENCY_HELP}>
          All figures in CAD ⓘ
        </span>
        {/* Data quality status — informational, never alarmist */}
        <span
          title={[
            reconciliation.verified
              ? 'P&L analytics reconcile: gross wins + gross losses = net realized P&L, and account, strategy, monthly and cumulative totals all tie out.'
              : 'One or more totals do not reconcile — see the detail below.',
            coverage.excluded > 0
              ? `Holding-period analytics use ${coverage.used} of ${coverage.total} closed trades; ${coverage.excluded} excluded for invalid dates.`
              : 'All closed trades have valid dates.',
          ].join('\n\n')}
          className={`text-xs px-2 py-0.5 rounded-full border cursor-help ${
            reconciliation.verified && coverage.excluded === 0
              ? 'bg-emerald-900/30 text-emerald-400 border-emerald-800'
              : reconciliation.verified
                ? 'bg-zinc-800 text-zinc-400 border-zinc-700'
                : 'bg-amber-900/30 text-amber-400 border-amber-800'}`}>
          {reconciliation.verified && coverage.excluded === 0 ? 'DATA VERIFIED'
            : reconciliation.verified ? `P&L VERIFIED · ${coverage.excluded} DATE ISSUE${coverage.excluded > 1 ? 'S' : ''}`
            : 'DATA ISSUES'}
        </span>
      </div>

      {/* ── Stats bar ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        {[
          { label: 'Total Trades',  value: trades.length.toString(), color: '' },
          { label: 'Open',          value: open.length.toString(), color: 'text-blue-400' },
          { label: 'Closed',        value: stats.trades.toString(), color: 'text-zinc-300' },
          { label: 'Win Rate',      value: stats.winRate != null ? `${fmt(stats.winRate, 1)}%` : '—',
            color: winRate >= 60 ? 'text-emerald-400' : winRate >= 40 ? 'text-amber-400' : 'text-red-400',
            hint: `${stats.wins}W / ${stats.losses}L${stats.breakeven > 0 ? ` / ${stats.breakeven}BE` : ''}` },
          { label: 'Realized P&L',  value: `${totalRealizedPnl >= 0 ? '+' : ''}${fmtCurrency(totalRealizedPnl)}`,
            color: totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400', hint: 'CAD' },
          { label: 'Profit Factor', value: stats.profitFactor == null ? '—' : stats.profitFactor === Infinity ? '∞' : `${stats.profitFactor.toFixed(2)}x`,
            color: profitFactor >= 2 ? 'text-emerald-400' : profitFactor >= 1 ? 'text-amber-400' : 'text-red-400',
            help: PROFIT_FACTOR_HELP, hint: 'gross W / gross L' },
          { label: 'Payoff Ratio',  value: stats.payoffRatio != null ? `${stats.payoffRatio.toFixed(2)}x` : '—',
            color: (stats.payoffRatio ?? 0) >= 2 ? 'text-emerald-400' : 'text-zinc-200',
            help: PAYOFF_RATIO_HELP, hint: 'avg W / avg L' },
          { label: 'Expectancy',    value: stats.expectancyCAD != null ? `${stats.expectancyCAD >= 0 ? '+' : ''}${fmtCurrency(stats.expectancyCAD)}` : '—',
            color: (stats.expectancyCAD ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400',
            help: EXPECTANCY_HELP, hint: 'per trade' },
        ].map(({ label, value, color, help, hint }) => (
          <div key={label} className="card py-3" title={help}>
            <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
              {label}{help && <span className="text-zinc-700">ⓘ</span>}
            </div>
            <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
            {hint && <div className="text-xs text-zinc-600 mt-0.5">{hint}</div>}
          </div>
        ))}
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Avg Trade', value: stats.avgTradeCAD != null ? fmtCurrency(stats.avgTradeCAD) : '—',
            color: (stats.avgTradeCAD ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400' },
          { label: 'Max Drawdown', value: drawdown.maxDrawdownCAD < 0 ? fmtCurrency(drawdown.maxDrawdownCAD) : '—',
            color: 'text-red-400', help: DRAWDOWN_HELP,
            hint: drawdown.maxDrawdownCAD < 0 ? `peak ${fmtCurrency(drawdown.peakCAD)}` : undefined },
          { label: 'Avg Hold', value: holdingStats.avgAll != null ? `${holdingStats.avgAll.toFixed(0)}d` : '—', color: 'text-zinc-200' },
          { label: 'Avg Hold — Winners', value: holdingStats.avgWinners != null ? `${holdingStats.avgWinners.toFixed(0)}d` : '—', color: 'text-emerald-400',
            hint: holdingStats.medianWinners != null ? `median ${holdingStats.medianWinners.toFixed(0)}d` : undefined },
          { label: 'Avg Hold — Losers', value: holdingStats.avgLosers != null ? `${holdingStats.avgLosers.toFixed(0)}d` : '—', color: 'text-red-400',
            hint: holdingStats.medianLosers != null ? `median ${holdingStats.medianLosers.toFixed(0)}d` : undefined },
          { label: 'Best / Worst',
            value: extremes.bestByDollar ? `${extremes.bestByDollar.t.ticker} / ${extremes.worstByDollar?.t.ticker ?? '—'}` : '—',
            color: 'text-zinc-200',
            hint: extremes.bestByDollar
              ? `${fmtCurrency(extremes.bestByDollar.pnlCAD)} / ${extremes.worstByDollar ? fmtCurrency(extremes.worstByDollar.pnlCAD) : '—'}`
              : undefined },
        ].map(({ label, value, color, help, hint }) => (
          <div key={label} className="card py-3" title={help}>
            <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
              {label}{help && <span className="text-zinc-700">ⓘ</span>}
            </div>
            <div className={`text-base font-bold tabular-nums ${color}`}>{value}</div>
            {hint && <div className="text-xs text-zinc-600 mt-0.5">{hint}</div>}
          </div>
        ))}
      </div>

      {/* Best / worst — dollar and percent are separate trades */}
      {extremes.bestByDollar && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Best $ Trade',  r: extremes.bestByDollar,  tone: 'text-emerald-400' },
            { label: 'Best % Trade',  r: extremes.bestByPct,     tone: 'text-emerald-400' },
            { label: 'Worst $ Trade', r: extremes.worstByDollar, tone: 'text-red-400' },
            { label: 'Worst % Trade', r: extremes.worstByPct,    tone: 'text-red-400' },
          ].map(({ label, r, tone }) => (
            <div key={label} className="card py-3">
              <div className="text-xs text-zinc-500 mb-1">{label}</div>
              {r ? (
                <>
                  <div className="font-mono text-sm text-blue-400">{r.t.ticker}</div>
                  <div className={`text-base font-bold tabular-nums ${tone}`}>
                    {r.pnlCAD >= 0 ? '+' : ''}{fmtCurrency(r.pnlCAD)}
                  </div>
                  <div className={`text-xs tabular-nums ${r.pnlPct != null && r.pnlPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}
                    title={r.pnlPctSource === 'prices'
                      ? 'Calculated from entry and exit prices'
                      : r.pnlPctSource === 'stored' ? 'From the stored percentage field' : 'No percentage available'}>
                    {r.pnlPct != null ? `${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%` : '—'}
                  </div>
                </>
              ) : <div className="text-zinc-600 text-sm">—</div>}
            </div>
          ))}
        </div>
      )}

      {/* Data integrity */}
      {(diagnostics.length > 0 || invalidDateRows.length > 0) && (
        <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl px-4 py-2.5 text-xs text-amber-400 space-y-1">
          {diagnostics.map((d, i) => (
            <div key={i}>⚠ {d.label}: expected {fmtCurrency(d.expected)}, got {fmtCurrency(d.actual)}</div>
          ))}
          {invalidDateRows.length > 0 && (
            <>
              <div>
                ⚠ {invalidDateRows.length} trade{invalidDateRows.length > 1 ? 's have' : ' has'} an exit date before the entry date
                ({invalidDateRows.map(r => r.t.ticker).join(', ')}) — flagged for review, not modified.
              </div>
              <div className="text-zinc-400">
                These are excluded from holding-period, monthly and cumulative analytics
                {Math.abs(excludedPnl) > 0.01 && <> ({fmtCurrency(excludedPnl)} of realized P&amp;L)</>},
                but still count in Win Rate, P&amp;L, Profit Factor and account/strategy totals.
              </div>
              <button
                onClick={() => setShowDateRepair(v => !v)}
                className="mt-1 text-xs px-2.5 py-1 rounded-lg bg-amber-900/40 hover:bg-amber-900/60 text-amber-200 border border-amber-800/60 transition-colors">
                {showDateRepair ? 'Hide' : 'Fix Invalid Dates'}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Bulk date repair ─────────────────────────────────────────────────── */}
      {showDateRepair && invalidDateRows.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Fix Invalid Dates</h2>
              <p className="text-xs text-zinc-600 mt-0.5">
                Correct each trade manually — dates are never guessed or swapped for you.
                Only the date fields are written; prices, quantity and P&amp;L are untouched.
              </p>
            </div>
            <button onClick={() => setShowDateRepair(false)} className="btn-ghost p-1.5"><X size={14} /></button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/40 text-zinc-500">
                  <th className="th text-left">Ticker</th>
                  <th className="th text-left">Account</th>
                  <th className="th text-left">Entry Date</th>
                  <th className="th text-left">Exit Date</th>
                  <th className="th text-right">P&amp;L</th>
                  <th className="th text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {invalidDateRows.map((r) => (
                  <tr key={r.t.id} className="tr-hover">
                    <td className="td font-mono text-blue-400">{r.t.ticker}</td>
                    <td className="td"><span className={accountColors[r.t.account]}>{r.t.account}</span></td>
                    <td className="td">
                      <EditableDate value={r.t.date_of_buy} otherDate={r.t.date_of_sale} kind="entry" invalid
                        onSave={(next) => saveDate(r.t, 'date_of_buy', next)} />
                    </td>
                    <td className="td">
                      <EditableDate value={r.t.date_of_sale} otherDate={r.t.date_of_buy} kind="exit" allowBlank invalid
                        onSave={(next) => saveDate(r.t, 'date_of_sale', next)} />
                    </td>
                    <td className={`td text-right tabular-nums ${r.pnlCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {r.pnlCAD >= 0 ? '+' : ''}{fmtCurrency(r.pnlCAD)}
                    </td>
                    <td className="td text-amber-400">⚠ Exit before entry</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-600 mt-3">
            Each date saves on its own — fix one field at a time and the warning clears automatically
            once a trade's dates are in order. All holding-period, monthly and cumulative analytics
            recalculate immediately.
          </p>
        </div>
      )}

      {/* Insights */}
      {insights.length > 0 && (
        <div className="card py-3">
          <h2 className="text-sm font-semibold text-zinc-100 mb-2">What's Working</h2>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            {insights.map((i, idx) => (
              <div key={idx}>
                <div className="text-xs text-zinc-500">{i.label}</div>
                <div className="text-sm font-semibold text-zinc-200">{i.value}</div>
                {i.detail && <div className="text-xs text-zinc-600">{i.detail}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Win/Loss charts (only when there are closed trades) ──────────────── */}
      {closed.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Win rate bar + donut */}
          <div className="card flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 mb-3">Win / Loss Split</h2>
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center gap-1.5">
                  <TrendingUp size={14} className="text-emerald-400" />
                  <span className="text-sm font-bold text-emerald-400">{wins.length}</span>
                  <span className="text-xs text-zinc-500">Wins</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <TrendingDown size={14} className="text-red-400" />
                  <span className="text-sm font-bold text-red-400">{losses.length}</span>
                  <span className="text-xs text-zinc-500">Losses</span>
                </div>
              </div>
              {/* Win rate bar */}
              <div className="w-full bg-red-900/40 rounded-full h-4 overflow-hidden mb-1">
                <div className="bg-emerald-500 h-4 rounded-full transition-all" style={{ width: `${winRate}%` }} />
              </div>
              <div className="flex justify-between text-xs text-zinc-600">
                <span>0%</span>
                <span className="text-zinc-400 font-semibold">Win rate {fmt(winRate, 1)}%</span>
                <span>100%</span>
              </div>
            </div>

            {/* Avg win / avg loss */}
            <div className="space-y-1.5 border-t border-zinc-800 pt-3">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Avg Win</span>
                <span className="text-emerald-400 font-semibold tabular-nums">+{fmtCurrency(avgWin)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Avg Loss</span>
                <span className="text-red-400 font-semibold tabular-nums">{fmtCurrency(avgLoss)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Profit Factor</span>
                <span className={`font-semibold tabular-nums ${profitFactor >= 2 ? 'text-emerald-400' : profitFactor >= 1 ? 'text-amber-400' : 'text-red-400'}`}>
                  {profitFactor > 0 ? `${profitFactor.toFixed(2)}x` : '—'}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Total Wins $</span>
                <span className="text-emerald-400 tabular-nums">+{fmtCurrency(stats.grossWinsCAD)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Total Losses $</span>
                <span className="text-red-400 tabular-nums">{fmtCurrency(stats.grossLossesCAD)}</span>
              </div>
            </div>

            {/* Donut */}
            {donutData.length > 0 && (
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={donutData} cx="50%" cy="50%" innerRadius={35} outerRadius={55} dataKey="value" paddingAngle={3}>
                    {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, name: string) => [`${v} trades`, name]} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Monthly P&L bar chart */}
          <div className="card">
            <h2 className="text-sm font-semibold text-zinc-100 mb-4">Monthly P&L</h2>
            {monthlyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthlyData} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#71717a', fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 10 }} tickFormatter={(v) => `$${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} width={48} />
                  <ReferenceLine y={0} stroke="#52525b" />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(v: number) => [fmtCurrency(v), 'P&L']}
                  />
                  <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                    {monthlyData.map((d, i) => (
                      <Cell key={i} fill={d.pnl >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-zinc-600 text-xs text-center py-10">No closed trades yet</p>
            )}
          </div>

          {/* Cumulative P&L / Drawdown */}
          <div className="card">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">
                {chartMode === 'pnl' ? 'Cumulative P&L' : 'Drawdown'}
              </h2>
              <div className="flex gap-1">
                {([['pnl', 'P&L'], ['drawdown', 'Drawdown']] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setChartMode(k)}
                    title={k === 'drawdown' ? DRAWDOWN_HELP : undefined}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      chartMode === k ? 'bg-blue-900/50 text-blue-300 border-blue-600'
                        : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {cumulativeData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={cumulativeData} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
                    <XAxis dataKey="label" tick={false} />
                    <YAxis tick={{ fill: '#71717a', fontSize: 10 }} tickFormatter={(v) => `$${Math.abs(v) >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} width={52} />
                    <ReferenceLine y={0} stroke="#52525b" />
                    <Tooltip
                      {...TOOLTIP_STYLE}
                      formatter={(v: number) => [fmtCurrency(v), chartMode === 'pnl' ? 'Cumulative P&L' : 'Drawdown']}
                    />
                    <Line
                      type="monotone"
                      dataKey={chartMode === 'pnl' ? 'cum' : 'dd'}
                      stroke={chartMode === 'drawdown' ? '#ef4444' : totalRealizedPnl >= 0 ? '#10b981' : '#ef4444'}
                      strokeWidth={2}
                      dot={{ r: 3, fill: chartMode === 'drawdown' ? '#ef4444' : totalRealizedPnl >= 0 ? '#10b981' : '#ef4444' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
                <div className="text-xs text-zinc-600 mt-1">
                  {chartMode === 'pnl'
                    ? 'Ordered by exit date — when the P&L was realized'
                    : `Max drawdown ${fmtCurrency(drawdown.maxDrawdownCAD)} · currently ${fmtCurrency(drawdown.currentDrawdownCAD)} below peak`}
                </div>
              </>
            ) : (
              <p className="text-zinc-600 text-xs text-center py-10">No closed trades yet</p>
            )}
          </div>
        </div>
      )}

      {/* ── Performance breakdowns ───────────────────────────────────────────── */}
      {stats.trades > 0 && (
        <div className="space-y-4">
          {([
            { title: 'Performance by Strategy', rows: byStrategy, empty: 'No strategies recorded yet — set a Strategy on your trades to compare them.' },
            { title: 'Performance by Account',  rows: byAccount,  empty: 'No account data.' },
            { title: 'Performance by Holding Period', rows: byHolding,
              empty: 'Needs entry and exit dates to bucket trades.',
              note: coverage.excluded > 0
                ? `Holding-period coverage: ${coverage.used} / ${coverage.total} trades · ${coverage.excluded} excluded for invalid dates`
                : `Holding-period coverage: ${coverage.used} / ${coverage.total} trades` },
            { title: 'Performance by Rotation Context', rows: byRotation,
              empty: 'No sector snapshots captured yet. New trades store the sector conditions at entry; historical trades show N/A.' },
          ] as Array<{ title: string; rows: Segment[]; empty: string; note?: string }>).map(({ title, rows: segs, empty, note }) => (
            <div key={title} className="card overflow-hidden p-0">
              <div className="px-4 pt-4 pb-3">
                <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
                {note && <div className="text-xs text-zinc-600 mt-0.5">{note}</div>}
              </div>
              {segs.length === 0 ? (
                <p className="text-zinc-600 text-xs px-4 pb-4">{empty}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/40 text-zinc-500">
                        <th className="th text-left">{title.replace('Performance by ', '')}</th>
                        <th className="th text-right">Trades</th>
                        <th className="th text-right">W / L / BE</th>
                        <th className="th text-right">Win Rate</th>
                        <th className="th text-right">P&amp;L</th>
                        <th className="th text-right">Avg Trade</th>
                        <th className="th text-right">Avg Win</th>
                        <th className="th text-right">Avg Loss</th>
                        <th className="th text-right" title={PROFIT_FACTOR_HELP}>Profit Factor</th>
                        <th className="th text-right" title={PAYOFF_RATIO_HELP}>Payoff</th>
                        <th className="th text-right" title={EXPECTANCY_HELP}>Expectancy</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                      {segs.map((s) => (
                        <tr key={s.key} className="tr-hover">
                          <td className="td text-zinc-200 font-medium">{s.key}</td>
                          <td className="td text-right tabular-nums text-zinc-300">{s.trades}</td>
                          <td className="td text-right tabular-nums text-zinc-500">
                            <span className="text-emerald-400">{s.wins}</span> / <span className="text-red-400">{s.losses}</span>
                            {s.breakeven > 0 && <> / {s.breakeven}</>}
                          </td>
                          <td className={`td text-right tabular-nums ${(s.winRate ?? 0) >= 50 ? 'text-emerald-400' : 'text-zinc-300'}`}>
                            {s.winRate != null ? `${s.winRate.toFixed(0)}%` : '—'}
                          </td>
                          <td className={`td text-right tabular-nums font-semibold ${s.netPnlCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {s.netPnlCAD >= 0 ? '+' : ''}{fmtCurrency(s.netPnlCAD)}
                          </td>
                          <td className={`td text-right tabular-nums ${(s.avgTradeCAD ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {s.avgTradeCAD != null ? fmtCurrency(s.avgTradeCAD) : '—'}
                          </td>
                          <td className="td text-right tabular-nums text-emerald-400">{s.avgWinCAD != null ? fmtCurrency(s.avgWinCAD) : '—'}</td>
                          <td className="td text-right tabular-nums text-red-400">{s.avgLossCAD != null ? fmtCurrency(s.avgLossCAD) : '—'}</td>
                          <td className={`td text-right tabular-nums ${(s.profitFactor ?? 0) >= 1 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {s.profitFactor == null ? '—' : s.profitFactor === Infinity ? '∞' : `${s.profitFactor.toFixed(2)}x`}
                          </td>
                          <td className="td text-right tabular-nums text-zinc-300">{s.payoffRatio != null ? `${s.payoffRatio.toFixed(2)}x` : '—'}</td>
                          <td className={`td text-right tabular-nums font-medium ${(s.expectancyCAD ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {s.expectancyCAD != null ? `${s.expectancyCAD >= 0 ? '+' : ''}${fmtCurrency(s.expectancyCAD)}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Controls ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 flex-wrap">
          {(['ALL', 'OPEN', 'CLOSED'] as const).map((s) => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`text-xs px-3 py-1.5 rounded-full border transition ${filterStatus === s ? 'bg-blue-900/50 text-blue-300 border-blue-700' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
              {s}
            </button>
          ))}
          <span className="text-zinc-700 px-1">|</span>
          {['ALL', ...uniqueAccounts].map((a) => (
            <button key={a} onClick={() => setFilterAccount(a)}
              className={`text-xs px-3 py-1.5 rounded-full border transition ${filterAccount === a ? 'bg-blue-900/50 text-blue-300 border-blue-700' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
              {a}
            </button>
          ))}
        </div>
        <button onClick={() => { if (showForm && !editId) { cancelForm(); } else { setEditId(null); setForm(defaultForm); setShowForm(true); } }}
          className="btn-primary flex items-center gap-2">
          {showForm && !editId ? <X size={14} /> : <Plus size={14} />}
          {showForm && !editId ? 'Cancel' : 'Add Trade'}
        </button>
      </div>

      {/* ── Add / Edit form ───────────────────────────────────────────────────── */}
      {showForm && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-zinc-100">{editId ? 'Edit Trade' : 'Log New Trade'}</h2>
            <button onClick={cancelForm} className="btn-ghost flex items-center gap-1 text-xs"><X size={12} /> Cancel</button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="label">Entry Date</label>
                <input className={`input-base ${dateError ? 'border-red-500' : ''}`} type="date"
                  value={form.date_of_buy}
                  onChange={(e) => { setForm({ ...form, date_of_buy: e.target.value }); setDateError(null); }} />
              </div>
              <div><label className="label">Ticker *</label><input className="input-base uppercase" placeholder="NVDA" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} required /></div>
              <div><label className="label">Account</label>
                <select className="select-base" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value as Account })}>
                  {ACCOUNTS.map((a) => <option key={a}>{a}</option>)}
                </select>
              </div>
              <div><label className="label">Currency</label>
                <select className="select-base" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })}>
                  <option value="USD">USD</option><option value="CAD">CAD</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div><label className="label">Qty *</label><input className="input-base" type="number" step="0.001" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} required /></div>
              <div><label className="label">Entry Price *</label><input className="input-base" type="number" step="0.0001" value={form.entry_price} onChange={(e) => setForm({ ...form, entry_price: e.target.value })} required /></div>
              <div><label className="label">Stop Loss</label><input className="input-base" type="number" step="0.01" value={form.stop_loss} onChange={(e) => setForm({ ...form, stop_loss: e.target.value })} /></div>
              <div><label className="label">Strategy</label>
                <select className="select-base" value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
                  {STRATEGIES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="label">Exit Date</label>
                <input className={`input-base ${dateError ? 'border-red-500' : ''}`} type="date"
                  min={form.date_of_buy || undefined}
                  value={form.date_of_sale}
                  onChange={(e) => { setForm({ ...form, date_of_sale: e.target.value }); setDateError(null); }} />
              </div>
              <div><label className="label">Exit Price</label><input className="input-base" type="number" step="0.0001" value={form.exit_price} onChange={(e) => setForm({ ...form, exit_price: e.target.value })} /></div>
              <div><label className="label">Company</label><input className="input-base" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></div>
              <div><label className="label">Industry</label><input className="input-base" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></div>
            </div>
            <div><label className="label">Notes</label><input className="input-base" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            {/* Journal metadata — stored per trade in this browser */}
            <div className="w-full border-t border-zinc-800 pt-3 mt-1">
              <div className="text-xs text-zinc-500 mb-2">
                Trade journal notes <span className="text-zinc-700">— saved in this browser, used for the performance breakdowns</span>
              </div>
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-52">
                  <label className="label">Entry Reason</label>
                  <input className="input-base" placeholder="Why you took the trade"
                    value={metaForm.entry_reason ?? ''}
                    onChange={(e) => setMetaForm({ ...metaForm, entry_reason: e.target.value })} />
                </div>
                <div className="w-44">
                  <label className="label">Exit Reason</label>
                  <select className="select-base" value={metaForm.exit_reason ?? ''}
                    onChange={(e) => setMetaForm({ ...metaForm, exit_reason: (e.target.value || undefined) as typeof metaForm.exit_reason })}>
                    <option value="">—</option>
                    {EXIT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="w-32">
                  <label className="label">Followed Plan?</label>
                  <select className="select-base" value={metaForm.followed_plan ?? ''}
                    onChange={(e) => setMetaForm({ ...metaForm, followed_plan: (e.target.value || undefined) as typeof metaForm.followed_plan })}>
                    <option value="">—</option>
                    {FOLLOWED_PLAN_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className="w-44">
                  <label className="label">Mistake?</label>
                  <select className="select-base" value={metaForm.mistake_category ?? ''}
                    onChange={(e) => setMetaForm({
                      ...metaForm,
                      mistake_category: (e.target.value || undefined) as typeof metaForm.mistake_category,
                      mistake: !!e.target.value,
                    })}>
                    <option value="">No</option>
                    {MISTAKE_CATEGORIES.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {dateError && (
              <p className="w-full text-xs text-red-400 -mt-1">{dateError}</p>
            )}
            <button type="submit" className="btn-primary flex items-center gap-2" disabled={loading}>
              {editId ? <Check size={14} /> : <Plus size={14} />}
              {loading ? 'Saving...' : editId ? 'Update Trade' : 'Save Trade'}
            </button>
          </form>
        </div>
      )}

      {/* ── Trades table ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-100">
            Trade History <span className="text-zinc-600 text-sm font-normal">({filtered.length})</span>
          </h2>
          <button onClick={refreshLivePrices} className="btn-ghost flex items-center gap-1.5 text-xs" title="Refresh live prices">
            <RefreshCw size={12} className={pricesLoading ? 'animate-spin' : ''} />
            Refresh prices
          </button>
        </div>
        {filtered.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-8">No trades yet. Click <span className="text-zinc-400">Add Trade</span> to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800">
                  {SORT_COLS.map(({ label, key }) => (
                    <th key={key} className="th">
                      <button
                        onClick={() => handleSort(key)}
                        className="group flex items-center gap-1 whitespace-nowrap text-zinc-400 hover:text-white transition-colors cursor-pointer"
                      >
                        {label}
                        <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
                      </button>
                    </th>
                  ))}
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {filtered.map((t) => (
                  <tr key={t.id} className={`tr-hover ${t.status === 'OPEN' ? 'bg-blue-950/10' : ''}`}>
                    <td className="td text-zinc-600 text-xs">{t.sr_no}</td>
                    <td className="td text-xs">
                      <EditableDate
                        value={t.date_of_buy}
                        otherDate={t.date_of_sale}
                        kind="entry"
                        invalid={rowByTradeId.get(t.id)?.invalidDates}
                        onSave={(next) => saveDate(t, 'date_of_buy', next)}
                      />
                    </td>
                    <td className="td">
                      <button
                        onClick={() => setDrawer({ ticker: t.ticker, currency: t.currency })}
                        className="group flex items-start gap-1 text-left hover:text-blue-300 transition-colors"
                        title={`View fundamentals for ${t.ticker}`}
                      >
                        <div>
                          <div className="font-mono font-bold text-blue-400 group-hover:text-blue-300 flex items-center gap-1">
                            {t.ticker}
                            <ExternalLink size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                          </div>
                          {t.company && <div className="text-xs text-zinc-600">{t.company}</div>}
                        </div>
                      </button>
                    </td>
                    <td className="td"><span className={`text-xs font-semibold ${accountColors[t.account]}`}>{t.account}</span></td>
                    <td className="td text-xs text-zinc-500">{t.currency}</td>
                    <td className="td tabular-nums text-xs">{fmt(t.qty, 0)}</td>
                    <td className="td tabular-nums">{fmtCurrency(t.entry_price)}</td>
                    <td className="td text-xs">
                      <EditableDate
                        value={t.date_of_sale}
                        otherDate={t.date_of_buy}
                        kind="exit"
                        allowBlank
                        invalid={rowByTradeId.get(t.id)?.invalidDates}
                        onSave={(next) => saveDate(t, 'date_of_sale', next)}
                      />
                    </td>
                    <td className="td text-zinc-400 text-xs tabular-nums">
                      {(() => {
                        const d = rowByTradeId.get(t.id)?.daysHeld;
                        return d != null ? `${d}d` : '—';
                      })()}
                    </td>
                    <td className="td text-zinc-500 text-xs truncate max-w-[110px]" title={t.strategy}>
                      {t.strategy || <span className="text-zinc-700">Unclassified</span>}
                      {(() => {
                        const r = rowByTradeId.get(t.id);
                        const flag = r ? strategyDurationFlag(r) : null;
                        return flag ? <span className="text-amber-500 ml-1" title={flag}>⚑</span> : null;
                      })()}
                    </td>
                    <td className="td tabular-nums">
                      {t.avg_exit_price ? fmtCurrency(t.avg_exit_price) : (
                        t.status === 'OPEN' && livePrices[t.ticker]
                          ? <span className="text-blue-300">{fmtCurrency(livePrices[t.ticker])}</span>
                          : '—'
                      )}
                    </td>
                    <td className={`td tabular-nums font-semibold ${
                      t.status === 'OPEN'
                        ? livePrices[t.ticker]
                          ? (livePrices[t.ticker] - t.entry_price) * t.qty >= 0 ? 'text-emerald-400' : 'text-red-400'
                          : 'text-zinc-500'
                        : (t.realized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {t.status === 'OPEN'
                        ? livePrices[t.ticker]
                          ? (() => { const unreal = (livePrices[t.ticker] - t.entry_price) * t.qty; return `${unreal >= 0 ? '+' : ''}${fmtCurrency(unreal)}`; })()
                          : <span className="text-zinc-600 text-xs">live…</span>
                        : t.realized_pnl != null ? `${t.realized_pnl >= 0 ? '+' : ''}${fmtCurrency(t.realized_pnl)}` : '—'
                      }
                    </td>
                    <td className={`td tabular-nums text-xs font-medium ${
                      t.status === 'OPEN'
                        ? livePrices[t.ticker]
                          ? (livePrices[t.ticker] - t.entry_price) / t.entry_price >= 0 ? 'text-emerald-400' : 'text-red-400'
                          : 'text-zinc-500'
                        : (t.realized_pnl_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {t.status === 'OPEN'
                        ? livePrices[t.ticker]
                          ? fmtPct(((livePrices[t.ticker] - t.entry_price) / t.entry_price) * 100)
                          : '—'
                        : t.realized_pnl_pct != null ? fmtPct(t.realized_pnl_pct * 100) : '—'
                      }
                    </td>
                    <td className="td">
                      {t.status === 'OPEN' ? (
                        <span className="text-xs bg-blue-900/40 text-blue-300 border border-blue-700 px-2 py-0.5 rounded-full">OPEN</span>
                      ) : t.win_loss === 'WIN' ? (
                        <span className="text-xs bg-emerald-900/40 text-emerald-300 border border-emerald-700 px-2 py-0.5 rounded-full">WIN</span>
                      ) : (
                        <span className="text-xs bg-red-900/40 text-red-300 border border-red-700 px-2 py-0.5 rounded-full">LOSS</span>
                      )}
                    </td>
                    <td className="td">
                      <div className="flex gap-1">
                        <button onClick={() => startEdit(t)} className="btn-ghost p-1" title="Edit trade"><Edit2 size={12} /></button>
                        <button onClick={() => handleDelete(t.id)} className="btn-danger" title="Delete"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fundamentals drawer */}
      {drawer && (
        <FundamentalsDrawer ticker={drawer.ticker} currency={drawer.currency} onClose={() => setDrawer(null)} />
      )}
    </div>
  );
}
