import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Edit2, X, Check, Pencil } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import type { Holding, LiquidityRisk, Account, Currency } from '../../types';

const MANUAL_PRICES_KEY = 'swing_manual_prices';

const TABLE = 'portfolio_holdings';

const SECTORS = [
  'Technology', 'Healthcare', 'Financials', 'Consumer Discretionary',
  'Industrials', 'Energy', 'Materials', 'Utilities', 'Real Estate',
  'Communication Services', 'Consumer Staples', 'Other',
];

const ACCOUNTS: Account[] = ['Brokerage', 'RRSP', 'LIRA', 'TSFA', 'HSA', 'Other'];
const CURRENCIES: Currency[] = ['USD', 'CAD'];

const SECTOR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6366f1',
  '#14b8a6', '#a78bfa',
];

const liquidityBg: Record<LiquidityRisk, string> = {
  LOW: 'bg-emerald-900/40 text-emerald-300 border border-emerald-700',
  MEDIUM: 'bg-amber-900/40 text-amber-300 border border-amber-700',
  HIGH: 'bg-red-900/40 text-red-300 border border-red-700',
};

const accountColors: Record<Account, string> = {
  Brokerage: 'text-blue-400',
  RRSP: 'text-emerald-400',
  LIRA: 'text-purple-400',
  TSFA: 'text-amber-400',
  HSA: 'text-cyan-400',
  Other: 'text-zinc-400',
};

const defaultForm = {
  ticker: '',
  shares: '',
  avg_cost: '',
  sector: 'Technology',
  account: 'Brokerage' as Account,
  currency: 'USD' as Currency,
  liquidity_risk: 'LOW' as LiquidityRisk,
  notes: '',
};

interface LivePrice { price: number; changePct: number }

function loadManualPrices(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(MANUAL_PRICES_KEY) ?? '{}'); } catch { return {}; }
}
function saveManualPrices(prices: Record<string, number>) {
  localStorage.setItem(MANUAL_PRICES_KEY, JSON.stringify(prices));
}

export default function PortfolioRisk() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, LivePrice>>({});
  const [manualPrices, setManualPrices] = useState<Record<string, number>>(loadManualPrices);
  const [editingPrice, setEditingPrice] = useState<string | null>(null); // ticker being edited
  const [priceInput, setPriceInput] = useState('');
  const priceInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [filterAccount, setFilterAccount] = useState<string>('ALL');

  const load = useCallback(async () => {
    const data = await storage.getAll<Holding>(TABLE);
    setHoldings(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    holdings.forEach((h) => {
      if (!livePrices[h.ticker]) {
        finnhub.quote(h.ticker)
          .then((q) => setLivePrices((prev) => ({ ...prev, [h.ticker]: { price: q.c, changePct: q.dp } })))
          .catch(() => {});
      }
    });
  }, [holdings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the price input when it appears
  useEffect(() => {
    if (editingPrice) priceInputRef.current?.focus();
  }, [editingPrice]);

  function startEditPrice(ticker: string, currentVal: number) {
    setEditingPrice(ticker);
    setPriceInput(currentVal > 0 ? currentVal.toFixed(4) : '');
  }

  function commitPrice(ticker: string) {
    const val = parseFloat(priceInput);
    if (!isNaN(val) && val > 0) {
      const updated = { ...manualPrices, [ticker]: val };
      setManualPrices(updated);
      saveManualPrices(updated);
    }
    setEditingPrice(null);
  }

  function clearManualPrice(ticker: string) {
    const updated = { ...manualPrices };
    delete updated[ticker];
    setManualPrices(updated);
    saveManualPrices(updated);
    setEditingPrice(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker || !form.shares || !form.avg_cost) return;
    setLoading(true);
    try {
      const holding: Holding = {
        id: editId ?? newId(),
        ticker: form.ticker.toUpperCase(),
        shares: parseFloat(form.shares),
        avg_cost: parseFloat(form.avg_cost),
        sector: form.sector,
        account: form.account,
        currency: form.currency,
        liquidity_risk: form.liquidity_risk,
        notes: form.notes,
        created_at: nowIso(),
      };
      if (editId) {
        await storage.update(TABLE, editId, holding);
        setEditId(null);
      } else {
        await storage.insert(TABLE, holding);
      }
      setForm(defaultForm);
      await load();
    } finally {
      setLoading(false);
    }
  }

  function startEdit(h: Holding) {
    setEditId(h.id);
    setForm({
      ticker: h.ticker,
      shares: h.shares.toString(),
      avg_cost: h.avg_cost.toString(),
      sector: h.sector,
      account: h.account,
      currency: h.currency,
      liquidity_risk: h.liquidity_risk,
      notes: h.notes,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDelete(id: string) {
    await storage.remove(TABLE, id);
    await load();
  }

  const enriched = holdings.map((h) => {
    const lp = livePrices[h.ticker];
    const finnhubPrice = lp?.price && lp.price > 0 ? lp.price : null;
    // Manual price overrides Finnhub; fall back to avg_cost only as last resort
    const currentPrice = manualPrices[h.ticker] ?? finnhubPrice ?? h.avg_cost;
    const priceSource: 'manual' | 'live' | 'cost' =
      manualPrices[h.ticker] ? 'manual' : finnhubPrice ? 'live' : 'cost';
    const marketValue = h.shares * currentPrice;
    const costBasis = h.shares * h.avg_cost;
    const pnl = marketValue - costBasis;
    const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    return { ...h, currentPrice, priceSource, marketValue, costBasis, pnl, pnlPct, changePct: lp?.changePct ?? 0 };
  });

  const totalValue = enriched.reduce((s, h) => s + h.marketValue, 0);
  const totalCost = enriched.reduce((s, h) => s + h.costBasis, 0);
  const totalPnL = totalValue - totalCost;

  const withAlloc = enriched.map((h) => ({
    ...h,
    allocationPct: totalValue > 0 ? (h.marketValue / totalValue) * 100 : 0,
  }));

  // Filter by account
  const filtered = filterAccount === 'ALL' ? withAlloc : withAlloc.filter((h) => h.account === filterAccount);

  // Account breakdown for display
  const accountMap: Record<string, number> = {};
  withAlloc.forEach((h) => {
    accountMap[h.account] = (accountMap[h.account] ?? 0) + h.marketValue;
  });

  // Sector breakdown for pie chart
  const sectorMap: Record<string, number> = {};
  withAlloc.forEach((h) => {
    sectorMap[h.sector] = (sectorMap[h.sector] ?? 0) + h.allocationPct;
  });
  const pieData = Object.entries(sectorMap).map(([name, value]) => ({ name, value: +value.toFixed(1) }));

  const maxAlloc = withAlloc.reduce((m, h) => Math.max(m, h.allocationPct), 0);
  const concentrationRisk = maxAlloc > 30 ? 'HIGH' : maxAlloc > 20 ? 'MEDIUM' : 'LOW';

  const tickers = withAlloc.map((h) => h.ticker);
  function sectorCorr(a: string, b: string): number {
    if (a === b) return 1;
    const sa = withAlloc.find((h) => h.ticker === a)?.sector;
    const sb = withAlloc.find((h) => h.ticker === b)?.sector;
    if (sa === sb) return 0.75;
    const techGroup = ['Technology', 'Communication Services'];
    if (techGroup.includes(sa ?? '') && techGroup.includes(sb ?? '')) return 0.6;
    return 0.2;
  }
  function corrColor(v: number): string {
    if (v >= 0.9) return 'bg-red-700';
    if (v >= 0.7) return 'bg-red-600/60';
    if (v >= 0.5) return 'bg-amber-600/60';
    if (v >= 0.3) return 'bg-zinc-600';
    return 'bg-zinc-700/50';
  }

  const uniqueAccounts = [...new Set(holdings.map((h) => h.account))];

  return (
    <div className="space-y-6">
      {/* Add holding form */}
      <div className="card">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-zinc-100">{editId ? 'Edit Holding' : 'Add Holding'}</h2>
          {editId && (
            <button onClick={() => { setEditId(null); setForm(defaultForm); }} className="btn-ghost flex items-center gap-1.5">
              <X size={13} /> Cancel
            </button>
          )}
        </div>
        <form onSubmit={handleSubmit} className="flex flex-wrap gap-3 items-end">
          <div className="w-20"><label className="label">Ticker *</label><input className="input-base uppercase" placeholder="AAPL" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} required /></div>
          <div className="w-24"><label className="label">Shares *</label><input className="input-base" type="number" step="0.001" placeholder="100" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} required /></div>
          <div className="w-28"><label className="label">Avg Cost *</label><input className="input-base" type="number" step="0.0001" placeholder="150.00" value={form.avg_cost} onChange={(e) => setForm({ ...form, avg_cost: e.target.value })} required /></div>
          <div className="w-28">
            <label className="label">Account</label>
            <select className="select-base" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value as Account })}>
              {ACCOUNTS.map((a) => <option key={a}>{a}</option>)}
            </select>
          </div>
          <div className="w-20">
            <label className="label">Currency</label>
            <select className="select-base" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="w-40">
            <label className="label">Sector</label>
            <select className="select-base" value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}>
              {SECTORS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="w-28">
            <label className="label">Liquidity Risk</label>
            <select className="select-base" value={form.liquidity_risk} onChange={(e) => setForm({ ...form, liquidity_risk: e.target.value as LiquidityRisk })}>
              <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
            </select>
          </div>
          <div className="flex-1 min-w-28"><label className="label">Notes</label><input className="input-base" placeholder="Notes..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <button type="submit" className="btn-primary flex items-center gap-2" disabled={loading}>
            {editId ? <Check size={14} /> : <Plus size={14} />}
            {loading ? 'Saving...' : editId ? 'Update' : 'Add'}
          </button>
        </form>
      </div>

      {withAlloc.length > 0 && (
        <>
          {/* Summary bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="card py-3">
              <div className="text-xs text-zinc-500 mb-1">Portfolio Value</div>
              <div className="text-xl font-bold">{fmtCurrency(totalValue)}</div>
            </div>
            <div className="card py-3">
              <div className="text-xs text-zinc-500 mb-1">Total Cost Basis</div>
              <div className="text-xl font-bold">{fmtCurrency(totalCost)}</div>
            </div>
            <div className={`card py-3 ${totalPnL >= 0 ? 'border-emerald-900' : 'border-red-900'}`}>
              <div className="text-xs text-zinc-500 mb-1">Unrealized P&L</div>
              <div className={`text-xl font-bold ${totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {totalPnL >= 0 ? '+' : ''}{fmtCurrency(totalPnL)}
              </div>
            </div>
            <div className="card py-3">
              <div className="text-xs text-zinc-500 mb-1">Holdings</div>
              <div className="text-xl font-bold">{holdings.length} <span className="text-sm text-zinc-500 font-normal">across {uniqueAccounts.length} accounts</span></div>
            </div>
          </div>

          {/* Account breakdown */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-zinc-100">Holdings by Account</h2>
              <div className="flex gap-1">
                {['ALL', ...uniqueAccounts].map((a) => (
                  <button key={a} onClick={() => setFilterAccount(a)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition ${filterAccount === a ? 'bg-blue-900/50 text-blue-300 border-blue-700' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-xs text-zinc-600 mb-3">
              Click any price in the <span className="text-zinc-400">Current</span> column to enter it manually.
              <span className="text-amber-500 font-semibold ml-2">M</span> = manual override · orange <X size={10} className="inline" /> in actions clears it.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="th">Ticker</th>
                    <th className="th">Account</th>
                    <th className="th">Cur</th>
                    <th className="th">Shares</th>
                    <th className="th">Avg Cost</th>
                    <th className="th">Current</th>
                    <th className="th">Day %</th>
                    <th className="th">Market Value</th>
                    <th className="th">P&L</th>
                    <th className="th">Alloc %</th>
                    <th className="th">Sector</th>
                    <th className="th">Liquidity</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {filtered.map((h) => (
                    <tr key={h.id} className="tr-hover">
                      <td className="td font-mono font-bold text-blue-400">{h.ticker}</td>
                      <td className="td"><span className={`text-xs font-semibold ${accountColors[h.account]}`}>{h.account}</span></td>
                      <td className="td text-xs text-zinc-500">{h.currency}</td>
                      <td className="td tabular-nums text-xs">{fmt(h.shares, 3)}</td>
                      <td className="td tabular-nums">{fmtCurrency(h.avg_cost)}</td>
                      <td className="td tabular-nums">
                        {editingPrice === h.ticker ? (
                          <div className="flex items-center gap-1">
                            <input
                              ref={priceInputRef}
                              type="number"
                              step="0.0001"
                              className="w-24 bg-zinc-700 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-zinc-100 tabular-nums focus:outline-none"
                              value={priceInput}
                              onChange={(e) => setPriceInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitPrice(h.ticker);
                                if (e.key === 'Escape') setEditingPrice(null);
                              }}
                            />
                            <button onClick={() => commitPrice(h.ticker)} className="text-emerald-400 hover:text-emerald-300 p-0.5"><Check size={12} /></button>
                            <button onClick={() => setEditingPrice(null)} className="text-zinc-500 hover:text-zinc-300 p-0.5"><X size={12} /></button>
                          </div>
                        ) : (
                          <button
                            onClick={() => startEditPrice(h.ticker, h.currentPrice)}
                            className="group flex items-center gap-1.5 hover:text-blue-300 transition-colors"
                            title={h.priceSource === 'manual' ? 'Manual price — click to edit' : h.priceSource === 'cost' ? 'No live price — click to enter manually' : 'Live price — click to override'}
                          >
                            <span className={h.priceSource === 'cost' ? 'text-zinc-600' : ''}>{fmtCurrency(h.currentPrice)}</span>
                            {h.priceSource === 'manual' && <span className="text-xs text-amber-500 font-semibold">M</span>}
                            {h.priceSource === 'cost' && <span className="text-xs text-zinc-600">—</span>}
                            <Pencil size={10} className="opacity-0 group-hover:opacity-60 text-zinc-400 transition-opacity" />
                          </button>
                        )}
                      </td>
                      <td className={`td tabular-nums text-xs font-medium ${h.changePct > 0 ? 'text-emerald-400' : h.changePct < 0 ? 'text-red-400' : 'text-zinc-400'}`}>{h.priceSource === 'manual' ? <span className="text-zinc-600">—</span> : fmtPct(h.changePct)}</td>
                      <td className="td tabular-nums font-medium">{fmtCurrency(h.marketValue)}</td>
                      <td className={`td tabular-nums font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmtCurrency(h.pnl)}<br /><span className="text-xs">{fmtPct(h.pnlPct)}</span>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-zinc-700 rounded-full h-1.5 w-12">
                            <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(h.allocationPct, 100)}%` }} />
                          </div>
                          <span className="tabular-nums text-xs">{fmt(h.allocationPct, 1)}%</span>
                        </div>
                      </td>
                      <td className="td text-xs text-zinc-400">{h.sector}</td>
                      <td className="td"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${liquidityBg[h.liquidity_risk]}`}>{h.liquidity_risk}</span></td>
                      <td className="td">
                        <div className="flex gap-1">
                          <button onClick={() => startEdit(h)} className="btn-ghost p-1" title="Edit holding"><Edit2 size={12} /></button>
                          {h.priceSource === 'manual' && (
                            <button onClick={() => clearManualPrice(h.ticker)} className="btn-ghost p-1 text-amber-500 hover:text-amber-300" title="Clear manual price">
                              <X size={12} />
                            </button>
                          )}
                          <button onClick={() => handleDelete(h.id)} className="btn-danger" title="Delete holding"><Trash2 size={12} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h2 className="text-base font-semibold text-zinc-100 mb-4">Sector Allocation</h2>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={({ value }) => `${value.toFixed(1)}%`} labelLine={false}>
                    {pieData.map((_, i) => <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => [`${v.toFixed(1)}%`, 'Allocation']} contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} labelStyle={{ color: '#a1a1aa' }} />
                  <Legend formatter={(value) => <span className="text-xs text-zinc-400">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-4">
              {/* Account breakdown */}
              <div className="card">
                <h2 className="text-sm font-semibold text-zinc-100 mb-3">Account Breakdown</h2>
                {Object.entries(accountMap).sort((a, b) => b[1] - a[1]).map(([acct, val]) => (
                  <div key={acct} className="flex items-center gap-2 text-xs mb-2">
                    <span className={`w-20 font-semibold ${accountColors[acct as Account]}`}>{acct}</span>
                    <div className="flex-1 bg-zinc-700 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${totalValue > 0 ? (val / totalValue) * 100 : 0}%` }} />
                    </div>
                    <span className="text-zinc-400 w-24 text-right">{fmtCurrency(val)}</span>
                    <span className="text-zinc-600 w-10 text-right">{totalValue > 0 ? fmt((val / totalValue) * 100, 1) : '0'}%</span>
                  </div>
                ))}
              </div>

              {/* Concentration */}
              <div className="card">
                <h2 className="text-sm font-semibold text-zinc-100 mb-3">Concentration Analysis</h2>
                <div className="space-y-1.5">
                  {[
                    { label: 'Max single position', value: `${fmt(maxAlloc, 1)}%` },
                    { label: 'Concentration Risk', value: concentrationRisk, colored: true },
                    { label: 'Holdings', value: `${holdings.length}` },
                    { label: 'Sectors', value: `${Object.keys(sectorMap).length}` },
                  ].map(({ label, value, colored }) => (
                    <div key={label} className="flex justify-between text-sm">
                      <span className="text-zinc-400">{label}</span>
                      {colored ? (
                        <span className={`font-semibold px-2 py-0.5 rounded text-xs ${liquidityBg[value as LiquidityRisk]}`}>{value}</span>
                      ) : (
                        <span className="font-medium">{value}</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-3 space-y-1">
                  {withAlloc.sort((a, b) => b.allocationPct - a.allocationPct).slice(0, 8).map((h) => (
                    <div key={h.id} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-blue-400 w-14 flex-shrink-0">{h.ticker}</span>
                      <div className="flex-1 bg-zinc-700 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full ${h.allocationPct > 30 ? 'bg-red-500' : h.allocationPct > 15 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(h.allocationPct, 100)}%` }} />
                      </div>
                      <span className="tabular-nums text-zinc-400 w-8 text-right">{fmt(h.allocationPct, 1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Correlation heatmap */}
          {tickers.length > 1 && tickers.length <= 20 && (
            <div className="card">
              <h2 className="text-base font-semibold text-zinc-100 mb-1">Correlation Heatmap</h2>
              <p className="text-xs text-zinc-600 mb-4">Sector-based approximation. Red = high correlation = concentrated risk.</p>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead>
                    <tr>
                      <th className="w-16" />
                      {tickers.map((t) => <th key={t} className="text-center font-mono text-zinc-400 pb-2 px-0.5 min-w-10">{t.slice(0,4)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {tickers.map((rowT) => (
                      <tr key={rowT}>
                        <td className="font-mono text-zinc-400 pr-2 py-0.5 text-xs">{rowT.slice(0,6)}</td>
                        {tickers.map((colT) => {
                          const v = sectorCorr(rowT, colT);
                          return (
                            <td key={colT} className="p-0.5">
                              <div className={`w-8 h-8 rounded flex items-center justify-center font-semibold text-white/80 text-xs ${corrColor(v)}`}>{fmt(v, 1)}</div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {holdings.length === 0 && (
        <div className="card text-center py-12 text-zinc-600 text-sm">Add holdings above or import your portfolio data from the header.</div>
      )}
    </div>
  );
}
