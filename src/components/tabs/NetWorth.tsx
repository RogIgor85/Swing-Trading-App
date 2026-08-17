import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Check, X, Pencil, RefreshCw, Target, TrendingUp, TrendingDown } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { getUsdCad, getUsdCadCached } from '../../lib/fx';
import type { Holding } from '../../types';

const TABLE = 'net_worth_items';
const HISTORY_KEY = 'swing_nw_history';

const SECTION_COLORS: Record<string, string> = {
  investments:  '#3b82f6',
  realProperty: '#10b981',
  vehicles:     '#f59e0b',
  bankAccounts: '#06b6d4',
  otherAssets:  '#8b5cf6',
};

const GOALS_KEY = 'swing_nw_goals';

interface FinGoal {
  id:      string;
  icon:    string;
  name:    string;
  year:    string;
  target:  number;
  current: number;
}

const GOAL_COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899'];

const TICKER_CHIP_COLORS = [
  'bg-emerald-700', 'bg-blue-700', 'bg-violet-700', 'bg-amber-700',
  'bg-cyan-700', 'bg-pink-700', 'bg-indigo-700', 'bg-teal-700',
];

const RADIAN = Math.PI / 180;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pieLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) {
  if (percent < 0.05) return null;
  const r = (innerRadius + outerRadius) / 2;
  const x = cx + r * Math.cos(-midAngle * RADIAN);
  const y = cy + r * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="#ffffff" fontSize={12} fontWeight={700} textAnchor="middle" dominantBaseline="central">
      {(percent * 100).toFixed(0)}%
    </text>
  );
}

/** Small percentage ring for the hero bar */
function Ring({ pct, color }: { pct: number; color: string }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const filled = (Math.min(Math.max(pct, 0), 100) / 100) * c;
  return (
    <svg width="42" height="42" viewBox="0 0 42 42" className="-rotate-90 shrink-0">
      <circle cx="21" cy="21" r={r} fill="none" stroke="#27272a" strokeWidth="5" />
      <circle cx="21" cy="21" r={r} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={`${filled} ${c}`} strokeLinecap="round" />
    </svg>
  );
}

/** Tiny sparkline from monthly net-worth history */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 96, h = 28, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <polyline points={pts} fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function fmt$(n: number, showDash = true) {
  if (showDash && n === 0) return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
}

interface Row {
  id:          string;
  category:    string;
  description: string;
  value:       number;
  debt:        number;
}

// Shape stored in Supabase (flat, with section field)
interface NwDbRow extends Row {
  section:    string;
  created_at: string;
}

type SectionKey = 'realProperty' | 'vehicles' | 'investments' | 'bankAccounts' | 'otherAssets' | 'liabilities';

interface Store {
  realProperty: Row[];
  vehicles:     Row[];
  bankAccounts: Row[];
  otherAssets:  Row[];
  liabilities:  Row[];
}

interface PortfolioAccount { account: string; description: string; valueCAD: number }

const EMPTY_STORE: Store = {
  realProperty: [],
  vehicles:     [],
  bankAccounts: [],
  otherAssets:  [],
  liabilities:  [],
};

const ACCOUNT_DESCRIPTIONS: Record<string, string> = {
  RRSP:      'Registered Retirement Savings Plan',
  TSFA:      'Tax-Free Savings Account',
  LIRA:      'Locked-In Retirement Account',
  Brokerage: 'Investment Account',
  HSA:       'Health Savings Account',
  Crypto:    'Crypto & Digital Assets',
  Other:     'Other Investments',
};

function rowsToStore(dbRows: NwDbRow[]): Store {
  // getAll returns newest-first; reverse so rows appear in insertion order
  const store: Store = { ...EMPTY_STORE, realProperty: [], vehicles: [], bankAccounts: [], otherAssets: [], liabilities: [] };
  [...dbRows].reverse().forEach(r => {
    const key = r.section as keyof Store;
    if (key in store) store[key].push({ id: r.id, category: r.category, description: r.description, value: r.value, debt: r.debt });
  });
  return store;
}

const SECTIONS: { key: SectionKey; label: string; num: number }[] = [
  { key: 'realProperty',  label: 'Real Property',  num: 1 },
  { key: 'vehicles',      label: 'Vehicles',        num: 2 },
  { key: 'investments',   label: 'Investments',     num: 3 },
  { key: 'bankAccounts',  label: 'Bank Accounts',   num: 4 },
  { key: 'otherAssets',   label: 'Other Assets',    num: 5 },
  { key: 'liabilities',   label: 'Liabilities',     num: 6 },
];

const MANUAL_ASSET_SECTIONS: SectionKey[] = ['realProperty', 'vehicles', 'bankAccounts', 'otherAssets'];

export default function NetWorth() {
  const [store, setStore]       = useState<Store>(EMPTY_STORE);
  const [loading, setLoading]   = useState(true);
  const [editId, setEditId]     = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Row>>({});
  const [portfolioAccounts, setPortfolioAccounts] = useState<PortfolioAccount[]>([]);
  const [topHoldings, setTopHoldings] = useState<Array<{ ticker: string; sector: string; valueCAD: number; pnlPct: number | null }>>([]);
  const [usdCadRate, setUsdCadRate] = useState<number>(getUsdCadCached);
  const [syncing, setSyncing]   = useState(false);

  // ── Financial goals (localStorage) ──────────────────────────────────────
  const [finGoals, setFinGoals] = useState<FinGoal[]>(() => {
    try { return JSON.parse(localStorage.getItem(GOALS_KEY) ?? '[]'); } catch { return []; }
  });
  const [editGoalId, setEditGoalId]   = useState<string | null>(null);
  const [goalForm, setGoalForm]       = useState<Partial<FinGoal>>({});

  function saveGoals(next: FinGoal[]) {
    setFinGoals(next);
    localStorage.setItem(GOALS_KEY, JSON.stringify(next));
  }
  function addGoal() {
    const g: FinGoal = { id: newId(), icon: '🎯', name: '', year: '', target: 0, current: 0 };
    saveGoals([...finGoals, g]);
    setEditGoalId(g.id);
    setGoalForm({ ...g });
  }
  function commitGoal2() {
    if (!editGoalId) return;
    saveGoals(finGoals.map(g => g.id === editGoalId ? {
      ...g,
      icon:    (goalForm.icon ?? '🎯').slice(0, 4) || '🎯',
      name:    goalForm.name ?? '',
      year:    goalForm.year ?? '',
      target:  Number(goalForm.target ?? 0),
      current: Number(goalForm.current ?? 0),
    } : g));
    setEditGoalId(null); setGoalForm({});
  }
  function deleteGoal(id: string) {
    if (!window.confirm('Delete this goal?')) return;
    saveGoals(finGoals.filter(g => g.id !== id));
  }

  // Live USD/CAD rate on mount (still user-editable afterwards)
  useEffect(() => {
    getUsdCad().then(r => { if (r > 0) setUsdCadRate(r); }).catch(() => { /* keep cached */ });
  }, []);

  // ── Net Worth Goal ──────────────────────────────────────────────────────
  const [goal, setGoal]           = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('swing_nw_goal') ?? '0') || 0; } catch { return 0; }
  });
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput]     = useState('');
  const goalInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editingGoal) goalInputRef.current?.focus(); }, [editingGoal]);

  function commitGoal() {
    const v = parseFloat(goalInput.replace(/,/g, ''));
    if (!isNaN(v) && v >= 0) {
      setGoal(v);
      localStorage.setItem('swing_nw_goal', String(v));
    }
    setEditingGoal(false);
  }

  // ── Load from Supabase on mount ─────────────────────────────────────────
  useEffect(() => {
    storage.getAll<NwDbRow>(TABLE)
      .then(rows => setStore(rowsToStore(rows)))
      .finally(() => setLoading(false));
    syncPortfolio();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Portfolio sync ──────────────────────────────────────────────────────
  async function syncPortfolio() {
    setSyncing(true);
    try {
      const holdings = await storage.getAll<Holding>('holdings');
      const manualPrices: Record<string, number> = (() => {
        try { return JSON.parse(localStorage.getItem('swing_manual_prices') ?? '{}'); } catch { return {}; }
      })();
      const livePrices: Record<string, { price: number }> = (() => {
        try { return JSON.parse(localStorage.getItem('swing_live_prices') ?? '{}'); } catch { return {}; }
      })();
      const map: Record<string, number> = {};
      const byTicker: Record<string, { sector: string; valueCAD: number; costCAD: number }> = {};
      holdings.forEach(h => {
        // Same priority as Portfolio tab: manual → live → avg_cost
        const price    = manualPrices[h.ticker] ?? livePrices[h.ticker]?.price ?? h.avg_cost;
        const fx       = h.currency === 'USD' ? usdCadRate : 1;
        const valueCAD = h.shares * price * fx;
        map[h.account] = (map[h.account] ?? 0) + valueCAD;

        const t = byTicker[h.ticker] ?? { sector: h.sector, valueCAD: 0, costCAD: 0 };
        t.valueCAD += valueCAD;
        t.costCAD  += h.shares * h.avg_cost * fx;
        byTicker[h.ticker] = t;
      });
      setPortfolioAccounts(
        Object.entries(map)
          .filter(([, v]) => v > 0)
          .map(([account, valueCAD]) => ({ account, description: ACCOUNT_DESCRIPTIONS[account] ?? account, valueCAD }))
          .sort((a, b) => b.valueCAD - a.valueCAD)
      );
      setTopHoldings(
        Object.entries(byTicker)
          .filter(([, t]) => t.valueCAD > 0)
          .map(([ticker, t]) => ({
            ticker,
            sector: t.sector || '—',
            valueCAD: t.valueCAD,
            pnlPct: t.costCAD > 0 ? ((t.valueCAD - t.costCAD) / t.costCAD) * 100 : null,
          }))
          .sort((a, b) => b.valueCAD - a.valueCAD)
      );
    } finally { setSyncing(false); }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────
  function startEdit(row: Row) { setEditId(row.id); setEditForm({ ...row }); }
  function cancelEdit()        { setEditId(null);   setEditForm({}); }

  async function commitEdit(section: SectionKey) {
    if (!editId) return;
    const patch = {
      category:    editForm.category    ?? '',
      description: editForm.description ?? '',
      value:       Number(editForm.value ?? 0),
      debt:        Number(editForm.debt  ?? 0),
    };
    await storage.update(TABLE, editId, patch);
    setStore(prev => ({
      ...prev,
      [section]: (prev[section as keyof Store] as Row[]).map(r => r.id === editId ? { ...r, ...patch } : r),
    }));
    setEditId(null); setEditForm({});
  }

  async function addRow(section: SectionKey) {
    const row: NwDbRow = { id: newId(), section, category: '', description: '', value: 0, debt: 0, created_at: nowIso() };
    await storage.insert(TABLE, row);
    setStore(prev => ({ ...prev, [section]: [...(prev[section as keyof Store] as Row[]), { id: row.id, category: '', description: '', value: 0, debt: 0 }] }));
  }

  async function deleteRow(section: SectionKey, id: string) {
    if (!window.confirm('Delete this row?')) return;
    await storage.remove(TABLE, id);
    setStore(prev => ({ ...prev, [section]: (prev[section as keyof Store] as Row[]).filter(r => r.id !== id) }));
  }

  // Totals — investments come from portfolio sync, rest from manual store
  const investmentTotal = portfolioAccounts.reduce((s, a) => s + a.valueCAD, 0);
  const totalAssets = MANUAL_ASSET_SECTIONS.flatMap(s => (store[s as keyof Store] as Row[])).reduce((s, r) => s + r.value, 0) + investmentTotal;
  const totalDebt   = [...MANUAL_ASSET_SECTIONS, 'liabilities' as SectionKey].flatMap(s => (store[s as keyof Store] as Row[])).reduce((s, r) => s + r.debt, 0);
  const netWorth    = totalAssets - totalDebt;

  // ── Monthly history (localStorage) — powers Monthly Change + sparkline ──
  const [history, setHistory] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => {
    if (loading || netWorth === 0) return;
    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
    setHistory(prev => {
      if (prev[monthKey] === netWorth) return prev;
      const next = { ...prev, [monthKey]: netWorth };
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [netWorth, loading]);

  const histMonths  = Object.keys(history).sort();
  const histValues  = histMonths.slice(-12).map(m => history[m]);
  const prevMonthNW = histMonths.length >= 2 ? history[histMonths[histMonths.length - 2]] : null;
  const monthDelta  = prevMonthNW != null ? netWorth - prevMonthNW : null;
  const monthPct    = prevMonthNW != null && prevMonthNW !== 0 ? ((netWorth - prevMonthNW) / Math.abs(prevMonthNW)) * 100 : null;

  const cashTotal = (store.bankAccounts as Row[]).reduce((s, r) => s + r.value, 0);
  const pctOfNW   = (v: number) => netWorth > 0 ? (v / netWorth) * 100 : 0;

  function sub(section: SectionKey) {
    if (section === 'investments') return { value: investmentTotal, debt: 0 };
    const rows = store[section as keyof Store] as Row[];
    return { value: rows.reduce((s, r) => s + r.value, 0), debt: rows.reduce((s, r) => s + r.debt, 0) };
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20 text-zinc-500 text-sm gap-2">
      <RefreshCw size={14} className="animate-spin" /> Loading Net Worth…
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── Hero summary bar ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-blue-900/60 bg-gradient-to-br from-zinc-900 via-zinc-900 to-blue-950/50 px-5 py-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-x-6 gap-y-4 lg:divide-x lg:divide-zinc-800">

          {/* Total net worth */}
          <div className="col-span-2 lg:col-span-1 lg:pr-2">
            <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest mb-1">Total Net Worth</div>
            <div className={`text-3xl font-extrabold tabular-nums ${netWorth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {fmt$(netWorth, false)}
            </div>
            {monthDelta != null && (
              <div className={`flex items-center gap-1 text-xs mt-1 tabular-nums ${monthDelta >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                {monthDelta >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {monthDelta >= 0 ? '+' : '−'}{fmt$(Math.abs(monthDelta), false)}
                {monthPct != null && ` (${Math.abs(monthPct).toFixed(1)}%)`}
                <span className="text-zinc-600 ml-1">vs. last month</span>
              </div>
            )}
          </div>

          {/* Investments */}
          <div className="lg:px-4">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Investments</div>
            <div className="text-xl font-bold text-zinc-100 tabular-nums">{fmt$(investmentTotal, false)}</div>
            <div className="flex items-center gap-2 mt-1.5">
              <Ring pct={pctOfNW(investmentTotal)} color="#3b82f6" />
              <div className="text-xs text-zinc-500 leading-tight">
                <span className="text-blue-400 font-semibold">{pctOfNW(investmentTotal).toFixed(0)}%</span><br />of net worth
              </div>
            </div>
          </div>

          {/* Cash */}
          <div className="lg:px-4">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Cash</div>
            <div className="text-xl font-bold text-zinc-100 tabular-nums">{fmt$(cashTotal, false)}</div>
            <div className="flex items-center gap-2 mt-1.5">
              <Ring pct={pctOfNW(cashTotal)} color="#06b6d4" />
              <div className="text-xs text-zinc-500 leading-tight">
                <span className="text-cyan-400 font-semibold">{pctOfNW(cashTotal).toFixed(0)}%</span><br />of net worth
              </div>
            </div>
          </div>

          {/* Debt */}
          <div className="lg:px-4">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Debt</div>
            <div className="text-xl font-bold text-red-400 tabular-nums">{fmt$(totalDebt, false)}</div>
            <div className="flex items-center gap-2 mt-1.5">
              <Ring pct={pctOfNW(totalDebt)} color="#f87171" />
              <div className="text-xs text-zinc-500 leading-tight">
                <span className="text-red-400 font-semibold">{pctOfNW(totalDebt).toFixed(0)}%</span><br />of net worth
              </div>
            </div>
          </div>

          {/* Monthly change */}
          <div className="lg:pl-4">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Monthly Change</div>
            {monthDelta != null ? (
              <>
                <div className={`text-xl font-bold tabular-nums ${monthDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {monthDelta >= 0 ? '▲ +' : '▼ −'}{fmt$(Math.abs(monthDelta), false)}
                </div>
                {monthPct != null && (
                  <div className={`text-xs tabular-nums ${monthDelta >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                    {Math.abs(monthPct).toFixed(2)}%
                  </div>
                )}
                <div className="mt-1.5"><Spark values={histValues} /></div>
              </>
            ) : (
              <div className="text-xs text-zinc-600 mt-1 leading-snug">
                Tracking starts this month — check back next month for your change.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Goal progress banner ───────────────────────────────────────────── */}
      {goal > 0 && (() => {
        const pct     = Math.min((netWorth / goal) * 100, 100);
        const reached = netWorth >= goal;
        return (
          <div className={`card py-3 border ${reached ? 'border-emerald-700 bg-emerald-950/30' : 'border-amber-800/60 bg-amber-950/20'}`}>
            <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
              <div className="flex items-center gap-2">
                <Target size={14} className={reached ? 'text-emerald-400' : 'text-amber-400'} />
                <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Net Worth Goal</span>
                <button
                  onClick={() => { setGoalInput(String(goal)); setEditingGoal(true); }}
                  className="text-zinc-600 hover:text-zinc-400 transition-colors"
                  title="Edit goal"
                >
                  <Pencil size={10} />
                </button>
              </div>
              <div className="flex items-center gap-3 text-xs tabular-nums">
                <span className={`font-bold text-lg ${reached ? 'text-emerald-400' : 'text-amber-400'}`}>{pct.toFixed(1)}%</span>
                <span className="text-zinc-500">{fmt$(netWorth, false)} / {fmt$(goal, false)}</span>
              </div>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-3 overflow-hidden">
              <div
                className={`h-3 rounded-full transition-all duration-700 ${reached ? 'bg-emerald-400' : 'bg-amber-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-1.5 text-xs text-right tabular-nums">
              {reached
                ? <span className="text-emerald-400 font-semibold">🎉 Goal reached! +{fmt$(netWorth - goal, false)} over target</span>
                : <span className="text-zinc-500">{fmt$(goal - netWorth, false)} remaining</span>
              }
            </div>
          </div>
        );
      })()}

      {/* ── Allocation donut + Financial Goals (side by side) ──────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">

        {/* Asset allocation */}
        {totalAssets > 0 && (() => {
          const slices = SECTIONS
            .filter(s => s.key !== 'liabilities')
            .map(({ key, label }) => ({
              key, label,
              value: key === 'investments' ? investmentTotal : sub(key).value,
              color: SECTION_COLORS[key] ?? '#71717a',
            }))
            .filter(s => s.value > 0);
          return (
            <div className="card">
              <div className="text-sm font-bold text-zinc-100 uppercase tracking-wide mb-0.5">Portfolio Allocation</div>
              <div className="text-xs text-zinc-600 mb-3">By asset class</div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={slices}
                      dataKey="value"
                      nameKey="label"
                      innerRadius="50%"
                      outerRadius="88%"
                      paddingAngle={2}
                      stroke="none"
                      label={pieLabel}
                      labelLine={false}
                    >
                      {slices.map(s => <Cell key={s.key} fill={s.color} />)}
                    </Pie>
                    <Tooltip
                      formatter={(v: number) => fmt$(v, false)}
                      contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }}
                      itemStyle={{ color: '#e4e4e7' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* Legend */}
              <div className="mt-3 space-y-2">
                {slices.map(({ key, label, value, color }) => {
                  const pct = totalAssets > 0 ? (value / totalAssets) * 100 : 0;
                  return (
                    <div key={key} className="flex items-center gap-2.5 text-xs">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                      <span className="text-zinc-300 font-medium flex-1">{label}</span>
                      <span className="text-zinc-200 tabular-nums font-medium">{fmt$(value, false)}</span>
                      <span className="text-zinc-500 tabular-nums w-11 text-right font-semibold">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 bg-emerald-950/30 border border-emerald-900/40 rounded-lg px-3 py-2.5 flex items-start gap-2">
                <Target size={13} className="text-emerald-500 mt-0.5 shrink-0" />
                <span className="text-xs text-emerald-300/80">Stay diversified. Good portfolios balance risk and reward over time.</span>
              </div>
            </div>
          );
        })()}

        {/* Financial goals */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm font-bold text-zinc-100 uppercase tracking-wide mb-0.5">Financial Goals</div>
              <div className="text-xs text-zinc-600">Goal · target · progress</div>
            </div>
            <button onClick={addGoal} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-emerald-400 transition-colors px-2 py-1 rounded-lg hover:bg-zinc-800">
              <Plus size={12} /> Add goal
            </button>
          </div>

          {finGoals.length === 0 ? (
            <div className="text-xs text-zinc-600 py-6 text-center">
              No goals yet — add Retirement, House Down Payment, Emergency Fund…
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/60">
              {finGoals.map((g, i) => {
                const color = GOAL_COLORS[i % GOAL_COLORS.length];
                const pct   = g.target > 0 ? Math.min((g.current / g.target) * 100, 100) : 0;
                const editing = editGoalId === g.id;
                if (editing) return (
                  <div key={g.id} className="py-3 space-y-2">
                    <div className="flex gap-2">
                      <input className="input-base text-xs w-12 text-center" value={goalForm.icon ?? ''} maxLength={4}
                        onChange={e => setGoalForm(f => ({ ...f, icon: e.target.value }))} placeholder="🎯" title="Emoji" />
                      <input className="input-base text-xs flex-1" value={goalForm.name ?? ''}
                        onChange={e => setGoalForm(f => ({ ...f, name: e.target.value }))} placeholder="Goal name (e.g. Retirement)" />
                      <input className="input-base text-xs w-20" value={goalForm.year ?? ''}
                        onChange={e => setGoalForm(f => ({ ...f, year: e.target.value }))} placeholder="Year" />
                    </div>
                    <div className="flex gap-2 items-center">
                      <label className="text-xs text-zinc-500 w-14">Target $</label>
                      <input type="number" className="input-base text-xs flex-1 tabular-nums" value={goalForm.target ?? 0}
                        onChange={e => setGoalForm(f => ({ ...f, target: parseFloat(e.target.value) || 0 }))} />
                      <label className="text-xs text-zinc-500 w-14">Saved $</label>
                      <input type="number" className="input-base text-xs flex-1 tabular-nums" value={goalForm.current ?? 0}
                        onChange={e => setGoalForm(f => ({ ...f, current: parseFloat(e.target.value) || 0 }))} />
                      <button onClick={commitGoal2} className="text-emerald-400 hover:text-emerald-300 p-1"><Check size={14} /></button>
                      <button onClick={() => { setEditGoalId(null); setGoalForm({}); }} className="text-zinc-500 hover:text-zinc-300 p-1"><X size={14} /></button>
                    </div>
                  </div>
                );
                return (
                  <div key={g.id} className="py-3 flex items-center gap-3 group">
                    <span className="text-lg w-8 text-center shrink-0">{g.icon || '🎯'}</span>
                    <div className="w-32 shrink-0">
                      <div className="text-xs font-semibold text-zinc-200 leading-tight">{g.name || <span className="text-zinc-600 italic">Unnamed</span>}</div>
                      <div className="text-xs text-zinc-600">{g.year || 'Ongoing'}</div>
                    </div>
                    <div className="text-xs text-zinc-400 tabular-nums w-24 shrink-0 text-right">{fmt$(g.target, false)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs tabular-nums mb-1" style={{ color }}>{fmt$(g.current, false)}</div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                          <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
                        </div>
                        <span className="text-xs tabular-nums text-zinc-400 w-9 text-right font-semibold">{pct.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button onClick={() => { setEditGoalId(g.id); setGoalForm({ ...g }); }} className="btn-ghost p-1" title="Edit"><Pencil size={11} /></button>
                      <button onClick={() => deleteGoal(g.id)} className="btn-danger" title="Delete"><Trash2 size={11} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-3 bg-blue-950/30 border border-blue-900/40 rounded-lg px-3 py-2.5 flex items-start gap-2">
            <Target size={13} className="text-blue-400 mt-0.5 shrink-0" />
            <span className="text-xs text-blue-300/80">A goal without a plan is just a wish. Stay consistent and keep building.</span>
          </div>
        </div>
      </div>

      {/* ── Top Holdings ───────────────────────────────────────────────────── */}
      {topHoldings.length > 0 && (
        <div className="card">
          <div className="text-sm font-bold text-zinc-100 uppercase tracking-wide mb-0.5">Top Holdings</div>
          <div className="text-xs text-zinc-600 mb-3">By percentage of investments</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left pb-2 font-medium">Ticker</th>
                  <th className="text-left pb-2 font-medium">Sector</th>
                  <th className="text-right pb-2 font-medium">% of Portfolio</th>
                  <th className="text-right pb-2 font-medium">Value</th>
                  <th className="text-right pb-2 font-medium">P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {topHoldings.slice(0, 8).map((h, i) => {
                  const pct = investmentTotal > 0 ? (h.valueCAD / investmentTotal) * 100 : 0;
                  return (
                    <tr key={h.ticker} className="tr-hover">
                      <td className="py-2">
                        <span className={`inline-block ${TICKER_CHIP_COLORS[i % TICKER_CHIP_COLORS.length]} text-white font-mono font-bold px-2 py-0.5 rounded text-xs`}>
                          {h.ticker}
                        </span>
                      </td>
                      <td className="py-2 text-zinc-400">{h.sector}</td>
                      <td className="py-2 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-20 bg-zinc-800 rounded-full h-1.5 hidden sm:block">
                            <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                          <span className="text-zinc-200 font-semibold w-12">{pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums text-zinc-100 font-medium">{fmt$(h.valueCAD, false)}</td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${h.pnlPct == null ? 'text-zinc-600' : h.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {h.pnlPct == null ? '—' : `${h.pnlPct >= 0 ? '▲ +' : '▼ −'}${Math.abs(h.pnlPct).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
                {topHoldings.length > 8 && (
                  <tr>
                    <td className="py-2">
                      <span className="inline-block bg-zinc-700 text-zinc-300 font-mono font-bold px-2 py-0.5 rounded text-xs">
                        +{topHoldings.length - 8} more
                      </span>
                    </td>
                    <td className="py-2 text-zinc-500">Other holdings</td>
                    <td className="py-2 text-right tabular-nums text-zinc-400 font-semibold pr-0">
                      {((topHoldings.slice(8).reduce((s, h) => s + h.valueCAD, 0) / (investmentTotal || 1)) * 100).toFixed(1)}%
                    </td>
                    <td className="py-2 text-right tabular-nums text-zinc-300">{fmt$(topHoldings.slice(8).reduce((s, h) => s + h.valueCAD, 0), false)}</td>
                    <td className="py-2 text-right text-zinc-600">—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 text-xs text-zinc-600 flex items-center gap-1.5">
            ☆ Holdings will change over time. Review your portfolio regularly.
          </div>
        </div>
      )}

      {/* ── Sections ───────────────────────────────────────────────────────── */}
      {SECTIONS.map(({ key, label, num }) => {
        const isInvestments = key === 'investments';
        const rows = isInvestments ? [] : (store[key as keyof Store] as Row[]);
        const s    = sub(key);
        const net  = s.value - s.debt;
        const isLiability = key === 'liabilities';

        return (
          <div key={key} className="card overflow-hidden p-0">

            {/* Section header */}
            <div className="bg-blue-950/70 border-b border-blue-900 px-4 py-2.5 flex items-center justify-between">
              <h2 className="text-xs font-bold text-blue-300 uppercase tracking-widest">
                {num}. {label}
              </h2>
              {isInvestments && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">Synced from Portfolio · USD/CAD</span>
                  <input
                    type="number" step="0.0001"
                    value={usdCadRate}
                    onChange={e => setUsdCadRate(parseFloat(e.target.value) || 1.38)}
                    onBlur={() => syncPortfolio()}
                    className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-300 text-center focus:outline-none focus:border-blue-500"
                  />
                  <button onClick={syncPortfolio} className="text-zinc-500 hover:text-zinc-300 transition-colors" title="Refresh from Portfolio">
                    <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                  </button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/40 text-xs text-zinc-500">
                    <th className="th text-left w-40">Category</th>
                    <th className="th text-left">Description</th>
                    <th className="th text-right w-36">Current Value</th>
                    <th className="th text-right w-36">Outstanding Debt</th>
                    <th className="th text-right w-36">Net Equity</th>
                    <th className="th w-16" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {/* Portfolio-synced investment rows (read-only) */}
                  {isInvestments && (
                    portfolioAccounts.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="td text-center text-zinc-600 text-xs py-4">
                          {syncing ? 'Syncing from Portfolio…' : 'No holdings in Portfolio yet.'}
                        </td>
                      </tr>
                    ) : portfolioAccounts.map(pa => (
                      <tr key={pa.account} className="bg-zinc-900/20">
                        <td className="td text-sm text-zinc-300 font-medium">{pa.account}</td>
                        <td className="td text-xs text-zinc-500">{pa.description}</td>
                        <td className="td tabular-nums text-right text-sm text-zinc-100">{fmt$(pa.valueCAD)}</td>
                        <td className="td text-right text-zinc-600">—</td>
                        <td className="td tabular-nums text-right text-sm font-medium text-emerald-400">{fmt$(pa.valueCAD)}</td>
                        <td className="td text-xs text-zinc-700 text-right">mkt value</td>
                      </tr>
                    ))
                  )}
                  {rows.map(row => (
                    editId === row.id ? (
                      /* ── Edit row ── */
                      <tr key={row.id} className="bg-zinc-800/60">
                        <td className="td py-1.5">
                          <input
                            className="input-base text-xs w-full"
                            value={editForm.category ?? ''}
                            onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                            placeholder="Category"
                          />
                        </td>
                        <td className="td py-1.5">
                          <input
                            className="input-base text-xs w-full"
                            value={editForm.description ?? ''}
                            onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                            placeholder="Description"
                          />
                        </td>
                        <td className="td py-1.5">
                          <input
                            type="number" min="0" step="100"
                            className="input-base text-xs w-32 text-right tabular-nums"
                            value={editForm.value ?? 0}
                            onChange={e => setEditForm(f => ({ ...f, value: parseFloat(e.target.value) || 0 }))}
                          />
                        </td>
                        <td className="td py-1.5">
                          <input
                            type="number" min="0" step="100"
                            className="input-base text-xs w-32 text-right tabular-nums"
                            value={editForm.debt ?? 0}
                            onChange={e => setEditForm(f => ({ ...f, debt: parseFloat(e.target.value) || 0 }))}
                          />
                        </td>
                        <td className={`td text-right tabular-nums text-sm font-medium ${
                          (Number(editForm.value ?? 0) - Number(editForm.debt ?? 0)) >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}>
                          {fmt$(Number(editForm.value ?? 0) - Number(editForm.debt ?? 0))}
                        </td>
                        <td className="td py-1.5">
                          <div className="flex gap-1">
                            <button onClick={() => commitEdit(key)} className="text-emerald-400 hover:text-emerald-300 p-1"><Check size={13} /></button>
                            <button onClick={cancelEdit} className="text-zinc-500 hover:text-zinc-300 p-1"><X size={13} /></button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      /* ── Display row ── */
                      <tr key={row.id} className="tr-hover">
                        <td className="td text-sm text-zinc-300 font-medium">{row.category || <span className="text-zinc-600 italic">—</span>}</td>
                        <td className="td text-xs text-zinc-500">{row.description || <span className="text-zinc-700 italic">—</span>}</td>
                        <td className={`td tabular-nums text-right text-sm ${row.value > 0 ? 'text-zinc-100' : 'text-zinc-600'}`}>
                          {fmt$(row.value)}
                        </td>
                        <td className={`td tabular-nums text-right text-sm ${row.debt > 0 ? 'text-red-400' : 'text-zinc-600'}`}>
                          {row.debt > 0 ? fmt$(row.debt) : '—'}
                        </td>
                        <td className={`td tabular-nums text-right text-sm font-medium ${
                          row.value === 0 && row.debt === 0 ? 'text-zinc-600' :
                          (row.value - row.debt) >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}>
                          {row.value === 0 && row.debt === 0 ? '—' : fmt$(row.value - row.debt)}
                        </td>
                        <td className="td">
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => startEdit(row)} className="btn-ghost p-1" title="Edit"><Pencil size={11} /></button>
                            <button onClick={() => deleteRow(key, row.id)} className="btn-danger" title="Delete"><Trash2 size={11} /></button>
                          </div>
                        </td>
                      </tr>
                    )
                  ))}
                </tbody>

                {/* Subtotal row */}
                <tfoot>
                  <tr className="border-t-2 border-zinc-700 bg-zinc-900/50">
                    <td className="td font-bold text-sm text-zinc-200" colSpan={2}>
                      {label} Subtotal
                    </td>
                    <td className={`td tabular-nums text-right font-bold ${s.value > 0 ? 'text-zinc-100' : 'text-zinc-600'}`}>
                      {s.value > 0 ? fmt$(s.value) : '—'}
                    </td>
                    <td className={`td tabular-nums text-right font-bold ${s.debt > 0 ? 'text-red-400' : 'text-zinc-600'}`}>
                      {s.debt > 0 ? fmt$(s.debt) : '—'}
                    </td>
                    <td className={`td tabular-nums text-right font-bold text-base ${
                      isLiability ? 'text-red-400' : net >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {net === 0 ? '—' : (isLiability && net < 0 ? `(${fmt$(Math.abs(net), false)})` : fmt$(net))}
                    </td>
                    <td className="td" />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Add row — hidden for investments (auto-synced from Portfolio) */}
            {!isInvestments && (
              <div className="px-4 py-2 border-t border-zinc-800/60">
                <button
                  onClick={() => addRow(key)}
                  className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-300 transition-colors"
                >
                  <Plus size={11} /> Add row
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* ── Total Net Worth banner ─────────────────────────────────────────── */}
      <div className="card bg-blue-950/50 border-blue-800">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-xs text-blue-400 uppercase tracking-widest font-bold mb-1">Total Net Worth</div>
            <div className="text-xs text-zinc-500">All assets minus all debts</div>
          </div>
          <div className="text-right">
            <div className={`text-3xl font-bold tabular-nums ${netWorth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {fmt$(netWorth, false)}
            </div>
            <div className="text-xs text-zinc-500 mt-1 tabular-nums">
              {fmt$(totalAssets, false)} − {fmt$(totalDebt, false)}
            </div>
          </div>
        </div>

        {/* ── Goal tracker ── */}
        <div className="mt-5 pt-4 border-t border-blue-900/60">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Target size={13} className="text-amber-400" />
              <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Net Worth Goal</span>
            </div>
            {editingGoal ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-zinc-500">$</span>
                <input
                  ref={goalInputRef}
                  type="number"
                  step="10000"
                  placeholder="1000000"
                  className="w-36 bg-zinc-800 border border-amber-500 rounded px-2 py-0.5 text-xs text-zinc-100 tabular-nums focus:outline-none"
                  value={goalInput}
                  onChange={e => setGoalInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitGoal(); if (e.key === 'Escape') setEditingGoal(false); }}
                />
                <button onClick={commitGoal} className="text-emerald-400 p-0.5"><Check size={13} /></button>
                <button onClick={() => setEditingGoal(false)} className="text-zinc-500 p-0.5"><X size={13} /></button>
              </div>
            ) : (
              <button
                onClick={() => { setGoalInput(goal > 0 ? String(goal) : ''); setEditingGoal(true); }}
                className="group flex items-center gap-1.5 text-xs text-zinc-400 hover:text-amber-300 transition-colors"
              >
                <span className="tabular-nums font-semibold">{goal > 0 ? fmt$(goal, false) : 'Set a goal…'}</span>
                <Pencil size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
              </button>
            )}
          </div>
          {goal > 0 && (() => {
            const pct     = Math.min((netWorth / goal) * 100, 100);
            const reached = netWorth >= goal;
            const remaining = goal - netWorth;
            return (
              <div className="space-y-1.5">
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-zinc-800 rounded-full h-3 overflow-hidden">
                    <div
                      className={`h-3 rounded-full transition-all duration-500 ${reached ? 'bg-emerald-400' : 'bg-amber-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className={`tabular-nums font-bold text-sm w-14 text-right ${reached ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between text-xs text-zinc-500 tabular-nums">
                  <span>
                    {reached
                      ? <span className="text-emerald-400 font-semibold">🎉 Goal reached! +{fmt$(netWorth - goal, false)} over target</span>
                      : <span>{fmt$(remaining, false)} remaining to goal</span>
                    }
                  </span>
                  <span className="text-zinc-600">{fmt$(netWorth, false)} / {fmt$(goal, false)}</span>
                </div>
              </div>
            );
          })()}
        </div>

      </div>
    </div>
  );
}
