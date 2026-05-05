import { useState, useEffect } from 'react';
import { Plus, Trash2, Check, X, Pencil, RefreshCw } from 'lucide-react';
import { storage } from '../../lib/storage';
import type { Holding } from '../../types';

const STORAGE_KEY = 'swing_networth_v1';

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

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

type SectionKey = 'realProperty' | 'vehicles' | 'investments' | 'bankAccounts' | 'otherAssets' | 'liabilities';

interface Store {
  realProperty: Row[];
  vehicles:     Row[];
  bankAccounts: Row[];
  otherAssets:  Row[];
  liabilities:  Row[];
}

interface PortfolioAccount { account: string; description: string; valueCAD: number }

const DEFAULT: Store = {
  realProperty: [
    { id: uid(), category: 'Primary Residence',   description: '6911 106st, Edmonton AB',    value: 650000, debt: 500000 },
    { id: uid(), category: 'Other Real Property',  description: 'e.g. Rental / Cabin / Land', value: 0,      debt: 0 },
  ],
  vehicles: [
    { id: uid(), category: 'Vehicle 1', description: '2019 Ford Ranger FX4',          value: 35000, debt: 9000 },
    { id: uid(), category: 'Vehicle 2', description: '2013 Victory Highball',          value: 12000, debt: 0 },
    { id: uid(), category: 'Vehicle 3', description: '2021 Honda Rebel',               value: 15000, debt: 0 },
    { id: uid(), category: 'Vehicle 4', description: '2020 Harley Davidson Livewire',  value: 15000, debt: 0 },
  ],
  bankAccounts: [
    { id: uid(), category: 'Chequing Account', description: 'Primary chequing',          value: 6500,  debt: 0 },
    { id: uid(), category: 'Savings Account',  description: 'Savings / Emergency Fund',  value: 18250, debt: 0 },
  ],
  otherAssets: [
    { id: uid(), category: 'Personal Property',  description: 'Tools, equipment, electronics, etc.', value: 50000, debt: 0 },
    { id: uid(), category: 'Business Interests', description: 'Any ownership / partnership stake',   value: 0,     debt: 0 },
    { id: uid(), category: 'Other',              description: '',                                     value: 0,     debt: 0 },
  ],
  liabilities: [
    { id: uid(), category: 'Credit Cards',            description: 'Total outstanding balance', value: 0, debt: 8600 },
    { id: uid(), category: 'Vehicle Loan',            description: 'If applicable',             value: 0, debt: 0 },
    { id: uid(), category: 'Line of Credit / Other',  description: '',                          value: 0, debt: 0 },
  ],
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

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : DEFAULT;
  } catch { return DEFAULT; }
}
function saveStore(s: Store) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

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
  const [store, setStore]       = useState<Store>(loadStore);
  const [editId, setEditId]     = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Row>>({});
  const [portfolioAccounts, setPortfolioAccounts] = useState<PortfolioAccount[]>([]);
  const [usdCadRate, setUsdCadRate] = useState(1.38);
  const [syncing, setSyncing]   = useState(false);

  async function syncPortfolio() {
    setSyncing(true);
    try {
      const holdings = await storage.getAll<Holding>('holdings');
      const map: Record<string, number> = {};
      holdings.forEach(h => {
        const valueCAD = h.shares * h.avg_cost * (h.currency === 'USD' ? usdCadRate : 1);
        map[h.account] = (map[h.account] ?? 0) + valueCAD;
      });
      const accounts: PortfolioAccount[] = Object.entries(map)
        .filter(([, v]) => v > 0)
        .map(([account, valueCAD]) => ({
          account,
          description: ACCOUNT_DESCRIPTIONS[account] ?? account,
          valueCAD,
        }))
        .sort((a, b) => b.valueCAD - a.valueCAD);
      setPortfolioAccounts(accounts);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => { syncPortfolio(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function mutate(section: SectionKey, rows: Row[]) {
    const next = { ...store, [section]: rows };
    setStore(next);
    saveStore(next);
  }

  function startEdit(row: Row) { setEditId(row.id); setEditForm({ ...row }); }
  function cancelEdit() { setEditId(null); setEditForm({}); }

  function commitEdit(section: SectionKey) {
    mutate(section, (store[section as keyof Store] as Row[]).map(r =>
      r.id === editId
        ? { ...r, ...editForm, value: Number(editForm.value ?? 0), debt: Number(editForm.debt ?? 0) }
        : r
    ));
    setEditId(null); setEditForm({});
  }

  function addRow(section: SectionKey) {
    mutate(section, [...(store[section as keyof Store] as Row[]), { id: uid(), category: '', description: '', value: 0, debt: 0 }]);
  }

  function deleteRow(section: SectionKey, id: string) {
    if (!window.confirm('Delete this row?')) return;
    mutate(section, (store[section as keyof Store] as Row[]).filter(r => r.id !== id));
  }

  // Totals — investments come from portfolio sync, rest from manual store
  const investmentTotal = portfolioAccounts.reduce((s, a) => s + a.valueCAD, 0);
  const totalAssets = MANUAL_ASSET_SECTIONS.flatMap(s => (store[s as keyof Store] as Row[])).reduce((s, r) => s + r.value, 0) + investmentTotal;
  const totalDebt   = [...MANUAL_ASSET_SECTIONS, 'liabilities' as SectionKey].flatMap(s => (store[s as keyof Store] as Row[])).reduce((s, r) => s + r.debt, 0);
  const netWorth    = totalAssets - totalDebt;

  function sub(section: SectionKey) {
    if (section === 'investments') return { value: investmentTotal, debt: 0 };
    const rows = store[section as keyof Store] as Row[];
    return { value: rows.reduce((s, r) => s + r.value, 0), debt: rows.reduce((s, r) => s + r.debt, 0) };
  }

  return (
    <div className="space-y-5">

      {/* ── Summary cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card py-3">
          <div className="text-xs text-zinc-500 mb-1">Total Assets</div>
          <div className="text-xl font-bold text-zinc-100">{fmt$(totalAssets, false)}</div>
        </div>
        <div className="card py-3">
          <div className="text-xs text-zinc-500 mb-1">Total Debt</div>
          <div className="text-xl font-bold text-red-400">{fmt$(totalDebt, false)}</div>
        </div>
        <div className={`card py-3 col-span-2 ${netWorth >= 0 ? 'border-emerald-800' : 'border-red-800'}`}>
          <div className="text-xs text-zinc-500 mb-1">Net Worth</div>
          <div className={`text-2xl font-bold ${netWorth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmt$(netWorth, false)}
          </div>
          <div className="text-xs text-zinc-600 mt-0.5">{fmt$(totalAssets, false)} assets − {fmt$(totalDebt, false)} debt</div>
        </div>
      </div>

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
                        <td className="td text-xs text-zinc-700 text-right">cost basis</td>
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

        {/* Asset breakdown bar */}
        <div className="mt-4 space-y-2">
          {SECTIONS.filter(s => s.key !== 'liabilities').map(({ key, label }) => {
            const v = key === 'investments' ? investmentTotal : sub(key).value;
            const pct = totalAssets > 0 ? (v / totalAssets) * 100 : 0;
            if (v === 0) return null;
            return (
              <div key={key} className="flex items-center gap-3 text-xs">
                <span className="text-zinc-400 w-28 flex-shrink-0">{label}</span>
                <div className="flex-1 bg-zinc-800 rounded-full h-2">
                  <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-zinc-300 tabular-nums w-24 text-right">{fmt$(v, false)}</span>
                <span className="text-zinc-600 w-10 text-right">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
