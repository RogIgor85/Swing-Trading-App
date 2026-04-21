import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, TrendingUp, TrendingDown, X } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import type { TradeJournalEntry, Account, Currency } from '../../types';

const TABLE = 'trade_journal';
const ACCOUNTS: Account[] = ['Brokerage', 'RRSP', 'LIRA', 'TSFA', 'HSA', 'Other'];
const STRATEGIES = ['Swing 1-15 days', 'Short < 6 months', 'Long 1+ Year', 'Core (Forever)', 'Trend'];
const PERIODS = ['Swing', 'Mid-term', 'Long-term', 'Core'];

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
  RRSP: 'text-emerald-400',
  LIRA: 'text-purple-400',
  TSFA: 'text-amber-400',
  HSA: 'text-cyan-400',
  Other: 'text-zinc-400',
};

export default function TradeJournal() {
  const [trades, setTrades] = useState<TradeJournalEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [filterAccount, setFilterAccount] = useState<string>('ALL');

  const load = useCallback(async () => {
    const data = await storage.getAll<TradeJournalEntry>(TABLE);
    setTrades(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker || !form.qty || !form.entry_price) return;
    setLoading(true);
    try {
      const qty = parseFloat(form.qty);
      const entry = parseFloat(form.entry_price);
      const exitQty = form.date_of_sale && form.exit_price ? qty : null;
      const exitPrice = form.exit_price ? parseFloat(form.exit_price) : null;
      const isClosed = !!(form.date_of_sale && form.exit_price);
      const realizedPnl = isClosed && exitPrice ? (exitPrice - entry) * qty : null;
      const realizedPct = isClosed && entry > 0 && realizedPnl !== null ? realizedPnl / (entry * qty) : null;

      const entry_: TradeJournalEntry = {
        id: newId(),
        sr_no: trades.length + 1,
        date_of_buy: form.date_of_buy,
        account: form.account,
        ticker: form.ticker.toUpperCase(),
        company: form.company,
        industry: form.industry,
        period: form.period,
        strategy: form.strategy,
        currency: form.currency,
        qty,
        entry_price: entry,
        stop_loss: form.stop_loss ? parseFloat(form.stop_loss) : null,
        position_size: entry * qty,
        date_of_sale: form.date_of_sale || null,
        exit_qty: exitQty,
        exit_price: exitPrice,
        net_qty: isClosed ? 0 : qty,
        avg_exit_price: exitPrice,
        realized_pnl: realizedPnl,
        realized_pnl_pct: realizedPct,
        win_loss: realizedPnl != null ? (realizedPnl >= 0 ? 'WIN' : 'LOSS') : null,
        status: isClosed ? 'CLOSED' : 'OPEN',
        notes: form.notes,
        created_at: nowIso(),
      };
      await storage.insert(TABLE, entry_);
      setForm(defaultForm);
      setShowForm(false);
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await storage.remove(TABLE, id);
    await load();
  }

  // Stats
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const open = trades.filter((t) => t.status === 'OPEN');
  const wins = closed.filter((t) => t.win_loss === 'WIN');
  const losses = closed.filter((t) => t.win_loss === 'LOSS');
  const totalRealizedPnl = closed.reduce((s, t) => s + (t.realized_pnl ?? 0), 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.realized_pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.realized_pnl ?? 0), 0) / losses.length : 0;

  const uniqueAccounts = [...new Set(trades.map((t) => t.account))];

  const filtered = trades.filter((t) => {
    if (filterStatus !== 'ALL' && t.status !== filterStatus) return false;
    if (filterAccount !== 'ALL' && t.account !== filterAccount) return false;
    return true;
  }).sort((a, b) => b.date_of_buy.localeCompare(a.date_of_buy));

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total Trades', value: trades.length.toString(), color: '' },
          { label: 'Open', value: open.length.toString(), color: 'text-blue-400' },
          { label: 'Closed', value: closed.length.toString(), color: 'text-zinc-300' },
          { label: 'Win Rate', value: `${fmt(winRate, 1)}%`, color: winRate >= 60 ? 'text-emerald-400' : winRate >= 40 ? 'text-amber-400' : 'text-red-400' },
          { label: 'Total P&L (Realized)', value: `${totalRealizedPnl >= 0 ? '+' : ''}${fmtCurrency(totalRealizedPnl)}`, color: totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
          { label: 'Avg Win / Avg Loss', value: `${fmtCurrency(avgWin)} / ${fmtCurrency(Math.abs(avgLoss))}`, color: '' },
        ].map(({ label, value, color }) => (
          <div key={label} className="card py-3">
            <div className="text-xs text-zinc-500 mb-1">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Win/Loss breakdown */}
      {closed.length > 0 && (
        <div className="card">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <TrendingUp size={16} className="text-emerald-400" />
              <span className="text-sm font-semibold text-emerald-400">{wins.length} Wins</span>
              <span className="text-xs text-zinc-500">+{fmtCurrency(wins.reduce((s, t) => s + (t.realized_pnl ?? 0), 0))}</span>
            </div>
            <div className="flex items-center gap-2">
              <TrendingDown size={16} className="text-red-400" />
              <span className="text-sm font-semibold text-red-400">{losses.length} Losses</span>
              <span className="text-xs text-zinc-500">{fmtCurrency(losses.reduce((s, t) => s + (t.realized_pnl ?? 0), 0))}</span>
            </div>
            {/* Win rate bar */}
            <div className="flex-1 min-w-32">
              <div className="w-full bg-red-900/40 rounded-full h-3 overflow-hidden">
                <div className="bg-emerald-500 h-3 rounded-full" style={{ width: `${winRate}%` }} />
              </div>
              <div className="flex justify-between text-xs text-zinc-600 mt-0.5">
                <span>0%</span><span>Win Rate {fmt(winRate, 1)}%</span><span>100%</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Controls */}
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
        <button onClick={() => setShowForm(!showForm)} className="btn-primary flex items-center gap-2">
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add Trade'}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="card">
          <h2 className="text-base font-semibold text-zinc-100 mb-4">Log New Trade</h2>
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
              <div><label className="label">Date Sold (if closed)</label><input className="input-base" type="date" value={form.date_of_sale} onChange={(e) => setForm({ ...form, date_of_sale: e.target.value })} /></div>
              <div><label className="label">Exit Price</label><input className="input-base" type="number" step="0.0001" value={form.exit_price} onChange={(e) => setForm({ ...form, exit_price: e.target.value })} /></div>
              <div><label className="label">Company</label><input className="input-base" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></div>
              <div><label className="label">Industry</label><input className="input-base" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></div>
            </div>
            <div><label className="label">Notes</label><input className="input-base" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <button type="submit" className="btn-primary flex items-center gap-2" disabled={loading}>
              <Plus size={14} />{loading ? 'Saving...' : 'Save Trade'}
            </button>
          </form>
        </div>
      )}

      {/* Trades table */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">
          Trade History <span className="text-zinc-600 text-sm font-normal">({filtered.length})</span>
        </h2>
        {filtered.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-8">No trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="th">#</th>
                  <th className="th">Date</th>
                  <th className="th">Ticker</th>
                  <th className="th">Account</th>
                  <th className="th">Cur</th>
                  <th className="th">Qty</th>
                  <th className="th">Entry</th>
                  <th className="th">Stop</th>
                  <th className="th">Position $</th>
                  <th className="th">Exit Date</th>
                  <th className="th">Exit Price</th>
                  <th className="th">P&L</th>
                  <th className="th">P&L %</th>
                  <th className="th">Result</th>
                  <th className="th">Strategy</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {filtered.map((t) => (
                  <tr key={t.id} className={`tr-hover ${t.status === 'OPEN' ? 'bg-blue-950/10' : ''}`}>
                    <td className="td text-zinc-600 text-xs">{t.sr_no}</td>
                    <td className="td text-zinc-400 text-xs">{t.date_of_buy}</td>
                    <td className="td">
                      <div className="font-mono font-bold text-blue-400">{t.ticker}</div>
                      {t.company && <div className="text-xs text-zinc-600">{t.company}</div>}
                    </td>
                    <td className="td"><span className={`text-xs font-semibold ${accountColors[t.account]}`}>{t.account}</span></td>
                    <td className="td text-xs text-zinc-500">{t.currency}</td>
                    <td className="td tabular-nums text-xs">{fmt(t.qty, 0)}</td>
                    <td className="td tabular-nums">{fmtCurrency(t.entry_price)}</td>
                    <td className="td tabular-nums text-zinc-500 text-xs">{t.stop_loss ? fmtCurrency(t.stop_loss) : '—'}</td>
                    <td className="td tabular-nums text-xs">{t.position_size ? fmtCurrency(t.position_size) : '—'}</td>
                    <td className="td text-zinc-400 text-xs">{t.date_of_sale ?? '—'}</td>
                    <td className="td tabular-nums">{t.avg_exit_price ? fmtCurrency(t.avg_exit_price) : '—'}</td>
                    <td className={`td tabular-nums font-semibold ${(t.realized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {t.realized_pnl != null ? `${t.realized_pnl >= 0 ? '+' : ''}${fmtCurrency(t.realized_pnl)}` : '—'}
                    </td>
                    <td className={`td tabular-nums text-xs font-medium ${(t.realized_pnl_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {t.realized_pnl_pct != null ? fmtPct(t.realized_pnl_pct * 100) : '—'}
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
                    <td className="td text-xs text-zinc-500 max-w-28 truncate">{t.strategy}</td>
                    <td className="td">
                      <button onClick={() => handleDelete(t.id)} className="btn-danger"><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
