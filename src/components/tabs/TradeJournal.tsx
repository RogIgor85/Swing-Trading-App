import { useState, useEffect, useCallback } from 'react';
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
import FundamentalsDrawer from '../FundamentalsDrawer';
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
  { label: 'Exit Price', key: 'avg_exit_price'   },
  { label: 'P&L',        key: 'realized_pnl'     },
  { label: 'P&L %',      key: 'realized_pnl_pct' },
  { label: 'Result',     key: 'status'           },
];

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
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelForm() {
    setEditId(null);
    setForm(defaultForm);
    setShowForm(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker || !form.qty || !form.entry_price) return;
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

      cancelForm();
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this trade?')) return;
    await storage.remove(TABLE, id);
    await load();
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const open   = trades.filter((t) => t.status === 'OPEN');
  const wins   = closed.filter((t) => t.win_loss === 'WIN');
  const losses = closed.filter((t) => t.win_loss === 'LOSS');
  const totalRealizedPnl = closed.reduce((s, t) => s + (t.realized_pnl ?? 0), 0);
  const winRate  = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const avgWin   = wins.length   > 0 ? wins.reduce((s, t)   => s + (t.realized_pnl ?? 0), 0) / wins.length   : 0;
  const avgLoss  = losses.length > 0 ? losses.reduce((s, t) => s + (t.realized_pnl ?? 0), 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0 ? Math.abs(avgWin / avgLoss) : 0;

  // ─── Chart data ──────────────────────────────────────────────────────────────
  // Monthly P&L bar chart
  const monthlyMap: Record<string, { month: string; pnl: number; wins: number; losses: number }> = {};
  closed.forEach((t) => {
    const key = (t.date_of_sale ?? t.date_of_buy).slice(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, pnl: 0, wins: 0, losses: 0 };
    monthlyMap[key].pnl += t.realized_pnl ?? 0;
    if (t.win_loss === 'WIN')  monthlyMap[key].wins++;
    if (t.win_loss === 'LOSS') monthlyMap[key].losses++;
  });
  const monthlyData = Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month));

  // Cumulative P&L line chart
  const sortedClosed = [...closed].sort((a, b) => {
    const da = a.date_of_sale ?? a.date_of_buy;
    const db = b.date_of_sale ?? b.date_of_buy;
    return da.localeCompare(db);
  });
  let cumPnl = 0;
  const cumulativeData = sortedClosed.map((t) => {
    cumPnl += t.realized_pnl ?? 0;
    return { label: `${t.ticker} (${t.date_of_sale ?? t.date_of_buy})`, cum: +cumPnl.toFixed(2) };
  });

  // Win/Loss donut
  const donutData = [
    { name: 'Wins',   value: wins.length,   color: '#10b981' },
    { name: 'Losses', value: losses.length, color: '#ef4444' },
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

      {/* ── Stats bar ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total Trades',         value: trades.length.toString(),                                           color: '' },
          { label: 'Open',                 value: open.length.toString(),                                             color: 'text-blue-400' },
          { label: 'Closed',               value: closed.length.toString(),                                           color: 'text-zinc-300' },
          { label: 'Win Rate',             value: `${fmt(winRate, 1)}%`,                                              color: winRate >= 60 ? 'text-emerald-400' : winRate >= 40 ? 'text-amber-400' : 'text-red-400' },
          { label: 'Realized P&L',         value: `${totalRealizedPnl >= 0 ? '+' : ''}${fmtCurrency(totalRealizedPnl)}`, color: totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
          { label: 'Profit Factor',        value: profitFactor > 0 ? `${profitFactor.toFixed(2)}x` : '—',            color: profitFactor >= 2 ? 'text-emerald-400' : profitFactor >= 1 ? 'text-amber-400' : 'text-red-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="card py-3">
            <div className="text-xs text-zinc-500 mb-1">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
          </div>
        ))}
      </div>

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
                <span className="text-emerald-400 tabular-nums">+{fmtCurrency(wins.reduce((s, t) => s + (t.realized_pnl ?? 0), 0))}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Total Losses $</span>
                <span className="text-red-400 tabular-nums">{fmtCurrency(losses.reduce((s, t) => s + (t.realized_pnl ?? 0), 0))}</span>
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

          {/* Cumulative P&L line */}
          <div className="card">
            <h2 className="text-sm font-semibold text-zinc-100 mb-4">Cumulative P&L</h2>
            {cumulativeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={cumulativeData} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
                  <XAxis dataKey="label" tick={false} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 10 }} tickFormatter={(v) => `$${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v >= 0 ? v : v}`} width={52} />
                  <ReferenceLine y={0} stroke="#52525b" />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(v: number) => [fmtCurrency(v), 'Cumulative P&L']}
                  />
                  <Line
                    type="monotone"
                    dataKey="cum"
                    stroke={cumPnl >= 0 ? '#10b981' : '#ef4444'}
                    strokeWidth={2}
                    dot={{ r: 3, fill: cumPnl >= 0 ? '#10b981' : '#ef4444' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-zinc-600 text-xs text-center py-10">No closed trades yet</p>
            )}
          </div>
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
              <div><label className="label">Date Bought</label><input className="input-base" type="date" value={form.date_of_buy} onChange={(e) => setForm({ ...form, date_of_buy: e.target.value })} /></div>
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
              <div><label className="label">Date Sold</label><input className="input-base" type="date" value={form.date_of_sale} onChange={(e) => setForm({ ...form, date_of_sale: e.target.value })} /></div>
              <div><label className="label">Exit Price</label><input className="input-base" type="number" step="0.0001" value={form.exit_price} onChange={(e) => setForm({ ...form, exit_price: e.target.value })} /></div>
              <div><label className="label">Company</label><input className="input-base" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></div>
              <div><label className="label">Industry</label><input className="input-base" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></div>
            </div>
            <div><label className="label">Notes</label><input className="input-base" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
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
                    <td className="td text-zinc-400 text-xs">{t.date_of_buy}</td>
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
                    <td className="td text-zinc-400 text-xs">{t.date_of_sale ?? '—'}</td>
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
