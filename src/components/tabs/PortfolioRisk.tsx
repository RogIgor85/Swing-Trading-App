import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit2, X, Check } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import type { Holding, LiquidityRisk } from '../../types';

const TABLE = 'portfolio_holdings';

const SECTORS = [
  'Technology', 'Healthcare', 'Financials', 'Consumer Discretionary',
  'Industrials', 'Energy', 'Materials', 'Utilities', 'Real Estate',
  'Communication Services', 'Consumer Staples', 'Other',
];

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

const defaultForm = {
  ticker: '',
  shares: '',
  avg_cost: '',
  sector: 'Technology',
  liquidity_risk: 'LOW' as LiquidityRisk,
  notes: '',
};

interface LivePrice {
  price: number;
  changePct: number;
}

export default function PortfolioRisk() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, LivePrice>>({});
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

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
      liquidity_risk: h.liquidity_risk,
      notes: h.notes,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDelete(id: string) {
    await storage.remove(TABLE, id);
    await load();
  }

  // Derived metrics
  const enriched = holdings.map((h) => {
    const lp = livePrices[h.ticker];
    const currentPrice = lp?.price ?? h.avg_cost;
    const marketValue = h.shares * currentPrice;
    const costBasis = h.shares * h.avg_cost;
    const pnl = marketValue - costBasis;
    const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    return { ...h, currentPrice, marketValue, costBasis, pnl, pnlPct, changePct: lp?.changePct ?? 0 };
  });

  const totalValue = enriched.reduce((s, h) => s + h.marketValue, 0);

  const withAlloc = enriched.map((h) => ({
    ...h,
    allocationPct: totalValue > 0 ? (h.marketValue / totalValue) * 100 : 0,
  }));

  // Sector breakdown for pie chart
  const sectorMap: Record<string, number> = {};
  withAlloc.forEach((h) => {
    sectorMap[h.sector] = (sectorMap[h.sector] ?? 0) + h.allocationPct;
  });
  const pieData = Object.entries(sectorMap).map(([name, value]) => ({ name, value: +value.toFixed(1) }));

  // Concentration risk
  const maxAlloc = withAlloc.reduce((m, h) => Math.max(m, h.allocationPct), 0);
  const concentrationRisk = maxAlloc > 30 ? 'HIGH' : maxAlloc > 20 ? 'MEDIUM' : 'LOW';

  // Correlation heatmap (sector-based approximation)
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

  return (
    <div className="space-y-6">
      {/* Add holding form */}
      <div className="card">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-zinc-100">
            {editId ? 'Edit Holding' : 'Add Holding'}
          </h2>
          {editId && (
            <button onClick={() => { setEditId(null); setForm(defaultForm); }} className="btn-ghost flex items-center gap-1.5">
              <X size={13} /> Cancel
            </button>
          )}
        </div>
        <form onSubmit={handleSubmit} className="flex flex-wrap gap-3 items-end">
          <div className="w-24">
            <label className="label">Ticker *</label>
            <input className="input-base uppercase" placeholder="AAPL" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} required />
          </div>
          <div className="w-24">
            <label className="label">Shares *</label>
            <input className="input-base" type="number" step="0.001" placeholder="100" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} required />
          </div>
          <div className="w-28">
            <label className="label">Avg Cost *</label>
            <input className="input-base" type="number" step="0.01" placeholder="150.00" value={form.avg_cost} onChange={(e) => setForm({ ...form, avg_cost: e.target.value })} required />
          </div>
          <div className="w-44">
            <label className="label">Sector</label>
            <select className="select-base" value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}>
              {SECTORS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="w-32">
            <label className="label">Liquidity Risk</label>
            <select className="select-base" value={form.liquidity_risk} onChange={(e) => setForm({ ...form, liquidity_risk: e.target.value as LiquidityRisk })}>
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
            </select>
          </div>
          <div className="flex-1 min-w-32">
            <label className="label">Notes</label>
            <input className="input-base" placeholder="Entry rationale..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button type="submit" className="btn-primary flex items-center gap-2" disabled={loading}>
            {editId ? <Check size={14} /> : <Plus size={14} />}
            {loading ? 'Saving...' : editId ? 'Update' : 'Add'}
          </button>
        </form>
      </div>

      {/* Holdings table */}
      {withAlloc.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-zinc-100">Holdings</h2>
            <div className="text-sm text-zinc-400">
              Portfolio Value: <span className="text-zinc-100 font-semibold">{fmtCurrency(totalValue)}</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="th">Ticker</th>
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
                {withAlloc.map((h) => (
                  <tr key={h.id} className="tr-hover">
                    <td className="td font-mono font-bold text-blue-400">{h.ticker}</td>
                    <td className="td tabular-nums">{fmt(h.shares, 3)}</td>
                    <td className="td tabular-nums">{fmtCurrency(h.avg_cost)}</td>
                    <td className="td tabular-nums">{fmtCurrency(h.currentPrice)}</td>
                    <td className={`td tabular-nums font-medium ${h.changePct > 0 ? 'text-emerald-400' : h.changePct < 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                      {fmtPct(h.changePct)}
                    </td>
                    <td className="td tabular-nums font-medium">{fmtCurrency(h.marketValue)}</td>
                    <td className={`td tabular-nums font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmtCurrency(h.pnl)}<br />
                      <span className="text-xs">{fmtPct(h.pnlPct)}</span>
                    </td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-zinc-700 rounded-full h-1.5 w-16">
                          <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(h.allocationPct, 100)}%` }} />
                        </div>
                        <span className="tabular-nums text-xs">{fmt(h.allocationPct, 1)}%</span>
                      </div>
                    </td>
                    <td className="td text-xs text-zinc-400">{h.sector}</td>
                    <td className="td">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${liquidityBg[h.liquidity_risk]}`}>
                        {h.liquidity_risk}
                      </span>
                    </td>
                    <td className="td">
                      <div className="flex gap-1">
                        <button onClick={() => startEdit(h)} className="btn-ghost p-1"><Edit2 size={12} /></button>
                        <button onClick={() => handleDelete(h.id)} className="btn-danger"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Charts row */}
      {pieData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Sector pie */}
          <div className="card">
            <h2 className="text-base font-semibold text-zinc-100 mb-4">Sector Allocation</h2>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  dataKey="value"
                  label={({ name, value }) => `${value.toFixed(1)}%`}
                  labelLine={false}
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: number) => [`${v.toFixed(1)}%`, 'Allocation']}
                  contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
                  labelStyle={{ color: '#a1a1aa' }}
                />
                <Legend
                  formatter={(value) => <span className="text-xs text-zinc-400">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Concentration & Liquidity */}
          <div className="space-y-4">
            <div className="card">
              <h2 className="text-sm font-semibold text-zinc-100 mb-3">Concentration Analysis</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Max single position</span>
                  <span className="font-medium">{fmt(maxAlloc, 1)}%</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Concentration Risk</span>
                  <span className={`font-semibold px-2 py-0.5 rounded text-xs ${liquidityBg[concentrationRisk]}`}>
                    {concentrationRisk}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Holdings count</span>
                  <span className="font-medium">{holdings.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Sectors</span>
                  <span className="font-medium">{Object.keys(sectorMap).length}</span>
                </div>
              </div>

              {/* Position bar chart */}
              <div className="mt-4 space-y-1.5">
                {withAlloc.sort((a, b) => b.allocationPct - a.allocationPct).map((h) => (
                  <div key={h.id} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-blue-400 w-12 flex-shrink-0">{h.ticker}</span>
                    <div className="flex-1 bg-zinc-700 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${h.allocationPct > 30 ? 'bg-red-500' : h.allocationPct > 20 ? 'bg-amber-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(h.allocationPct, 100)}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-zinc-400 w-10 text-right">{fmt(h.allocationPct, 1)}%</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Liquidity breakdown */}
            <div className="card">
              <h2 className="text-sm font-semibold text-zinc-100 mb-3">Liquidity Risk Breakdown</h2>
              {(['LOW', 'MEDIUM', 'HIGH'] as LiquidityRisk[]).map((level) => {
                const count = holdings.filter((h) => h.liquidity_risk === level).length;
                return (
                  <div key={level} className="flex items-center gap-2 text-xs mb-2">
                    <span className={`px-2 py-0.5 rounded-full font-medium w-20 text-center ${liquidityBg[level]}`}>{level}</span>
                    <div className="flex-1 bg-zinc-700 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${level === 'LOW' ? 'bg-emerald-500' : level === 'MEDIUM' ? 'bg-amber-500' : 'bg-red-500'}`}
                        style={{ width: holdings.length > 0 ? `${(count / holdings.length) * 100}%` : '0%' }}
                      />
                    </div>
                    <span className="text-zinc-400 tabular-nums w-16 text-right">{count} holdings</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Correlation heatmap */}
      {tickers.length > 1 && (
        <div className="card">
          <h2 className="text-base font-semibold text-zinc-100 mb-1">Correlation Heatmap</h2>
          <p className="text-xs text-zinc-600 mb-4">Sector-based correlation approximation. High values (red) indicate concentrated risk.</p>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="w-16" />
                  {tickers.map((t) => (
                    <th key={t} className="text-center font-mono text-zinc-400 pb-2 px-1 min-w-12">{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tickers.map((rowT) => (
                  <tr key={rowT}>
                    <td className="font-mono text-zinc-400 pr-2 py-0.5">{rowT}</td>
                    {tickers.map((colT) => {
                      const v = sectorCorr(rowT, colT);
                      return (
                        <td key={colT} className="p-0.5">
                          <div className={`w-10 h-10 rounded flex items-center justify-center font-semibold text-white/80 ${corrColor(v)}`}>
                            {fmt(v, 2)}
                          </div>
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

      {holdings.length === 0 && (
        <div className="card text-center py-12 text-zinc-600">
          Add your holdings above to see portfolio analytics.
        </div>
      )}
    </div>
  );
}
