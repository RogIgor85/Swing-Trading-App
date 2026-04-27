import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Edit2, X, Check, Pencil, RefreshCw, AlertTriangle, ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import { toYahooTicker } from '../FundamentalsDrawer';
import { fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import FundamentalsDrawer from '../FundamentalsDrawer';
import type { Holding, LiquidityRisk, Account, Currency } from '../../types';

const MANUAL_PRICES_KEY  = 'swing_manual_prices';
const DAILY_CHANGE_KEY   = 'swing_daily_change';

interface DailyChangeSnapshot {
  pct:       number;
  cad:       number;
  updatedAt: string; // ISO string
}

function loadDailyChange(): DailyChangeSnapshot | null {
  try { return JSON.parse(localStorage.getItem(DAILY_CHANGE_KEY) ?? 'null'); } catch { return null; }
}
function saveDailyChange(s: DailyChangeSnapshot) {
  localStorage.setItem(DAILY_CHANGE_KEY, JSON.stringify(s));
}
const TABLE = 'holdings';
const DEFAULT_RATE = 1.38;

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

function fmtCAD(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n);
}


export default function PortfolioRisk() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, LivePrice>>({});
  const [manualPrices, setManualPrices] = useState<Record<string, number>>(loadManualPrices);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState('');
  const priceInputRef = useRef<HTMLInputElement>(null);
  const [selectedTicker, setSelectedTicker] = useState<{ ticker: string; currency: string } | null>(null);

  // USD/CAD exchange rate
  const [usdCadRate, setUsdCadRate] = useState<number>(DEFAULT_RATE);
  const [rateLoading, setRateLoading] = useState(false);
  const [editingRate, setEditingRate] = useState(false);
  const [rateInput, setRateInput] = useState('');
  const rateInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [filterAccount, setFilterAccount] = useState<string>('ALL');
  const [sellId, setSellId] = useState<string | null>(null);
  const [sellForm, setSellForm] = useState({ exitPrice: '', qtySold: '', dateSold: new Date().toISOString().split('T')[0] });
  const [sellLoading, setSellLoading] = useState(false);

  const [dailySnapshot, setDailySnapshot] = useState<DailyChangeSnapshot | null>(loadDailyChange);
  const [editingDaily, setEditingDaily]   = useState(false);
  const [dailyPctInput, setDailyPctInput] = useState('');
  const [dailyCadInput, setDailyCadInput] = useState('');

  function saveDailySnapshot() {
    const pct = parseFloat(dailyPctInput);
    const cad = parseFloat(dailyCadInput);
    if (isNaN(pct)) return;
    const snap: DailyChangeSnapshot = {
      pct,
      cad: isNaN(cad) ? 0 : cad,
      updatedAt: new Date().toISOString(),
    };
    saveDailyChange(snap);
    setDailySnapshot(snap);
    setEditingDaily(false);
  }

  type SortKey = 'ticker' | 'account' | 'currency' | 'shares' | 'avg_cost' | 'currentPrice' | 'changePct' | 'costBasis' | 'marketValue' | 'pnl' | 'allocationPct' | 'sector';
  const [sortKey, setSortKey]   = useState<SortKey | null>(null);
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('asc');

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const load = useCallback(async () => {
    const data = await storage.getAll<Holding>(TABLE);
    setHoldings(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Fetch live USD/CAD rate on mount
  async function fetchRate() {
    setRateLoading(true);
    try {
      const q = await finnhub.quote('OANDA:USD_CAD');
      if (q.c && q.c > 0) setUsdCadRate(q.c);
    } catch { /* keep default */ } finally {
      setRateLoading(false);
    }
  }
  useEffect(() => { fetchRate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (editingRate) rateInputRef.current?.focus();
  }, [editingRate]);

  function commitRate() {
    const v = parseFloat(rateInput);
    if (!isNaN(v) && v > 0) setUsdCadRate(v);
    setEditingRate(false);
  }

  // Fetch stock prices — Finnhub first, Yahoo Finance fallback for tickers Finnhub can't resolve
  useEffect(() => {
    holdings.forEach(async (h) => {
      if (livePrices[h.ticker]) return; // already have it
      try {
        const q = await finnhub.quote(h.ticker);
        if (q.c && q.c > 0) {
          setLivePrices((prev) => ({ ...prev, [h.ticker]: { price: q.c, changePct: q.dp } }));
          return;
        }
      } catch { /* fall through to Yahoo */ }

      // Finnhub returned 0 or failed — try Yahoo Finance (handles TSX .TO tickers)
      try {
        const yahooTicker = toYahooTicker(h.ticker, h.currency);
        const y = await fetchYahoo(yahooTicker);
        const price = y.price?.regularMarketPrice ?? null;
        if (price && price > 0) {
          const prev2 = y.price?.regularMarketPreviousClose ?? price;
          const changePct = prev2 > 0 ? ((price - prev2) / prev2) * 100 : 0;
          setLivePrices((prev) => ({ ...prev, [h.ticker]: { price, changePct } }));
        }
      } catch { /* give up */ }
    });
  }, [holdings]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const newTicker  = form.ticker.toUpperCase();
      const newShares  = parseFloat(form.shares);
      const newCost    = parseFloat(form.avg_cost);

      if (editId) {
        // Straight edit — just overwrite
        const holding: Holding = {
          id: editId,
          ticker: newTicker,
          shares: newShares,
          avg_cost: newCost,
          sector: form.sector,
          account: form.account,
          currency: form.currency,
          liquidity_risk: form.liquidity_risk,
          notes: form.notes,
          created_at: nowIso(),
        };
        await storage.update(TABLE, editId, holding);
        setEditId(null);
      } else {
        // Check if this ticker + account already exists → average in
        const existing = holdings.find(
          (h) => h.ticker === newTicker && h.account === form.account && h.currency === form.currency
        );
        if (existing) {
          // Weighted average cost
          const totalShares  = existing.shares + newShares;
          const newAvgCost   = (existing.shares * existing.avg_cost + newShares * newCost) / totalShares;
          await storage.update(TABLE, existing.id, {
            shares:   totalShares,
            avg_cost: parseFloat(newAvgCost.toFixed(6)),
          });
        } else {
          const holding: Holding = {
            id: newId(),
            ticker: newTicker,
            shares: newShares,
            avg_cost: newCost,
            sector: form.sector,
            account: form.account,
            currency: form.currency,
            liquidity_risk: form.liquidity_risk,
            notes: form.notes,
            created_at: nowIso(),
          };
          await storage.insert(TABLE, holding);
        }
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

  async function handleSell(h: typeof withAlloc[0]) {
    setSellLoading(true);
    try {
      const exitPrice = parseFloat(sellForm.exitPrice);
      const qtySold = parseFloat(sellForm.qtySold) || h.shares;
      if (!exitPrice || exitPrice <= 0) return;

      const realizedPnl = (exitPrice - h.avg_cost) * qtySold;
      const realizedPct = h.avg_cost > 0 ? realizedPnl / (h.avg_cost * qtySold) : 0;

      // Create Trade Journal closed entry
      const journalEntry = {
        id: newId(),
        sr_no: 0,
        date_of_buy: h.created_at?.split('T')[0] ?? sellForm.dateSold,
        account: h.account,
        ticker: h.ticker,
        company: '',
        industry: h.sector,
        period: 'Swing',
        strategy: 'Swing 1-15 days',
        currency: h.currency,
        qty: qtySold,
        entry_price: h.avg_cost,
        stop_loss: null,
        position_size: h.avg_cost * qtySold,
        date_of_sale: sellForm.dateSold,
        exit_qty: qtySold,
        exit_price: exitPrice,
        net_qty: 0,
        avg_exit_price: exitPrice,
        realized_pnl: realizedPnl,
        realized_pnl_pct: realizedPct,
        win_loss: realizedPnl >= 0 ? 'WIN' as const : 'LOSS' as const,
        status: 'CLOSED' as const,
        notes: `Sold from Portfolio`,
        created_at: nowIso(),
      };
      await storage.insert('trade_journal', journalEntry);

      // Update or remove holding
      const remainingShares = h.shares - qtySold;
      if (remainingShares <= 0.001) {
        await storage.remove(TABLE, h.id);
      } else {
        await storage.update(TABLE, h.id, { shares: remainingShares });
      }

      setSellId(null);
      setSellForm({ exitPrice: '', qtySold: '', dateSold: new Date().toISOString().split('T')[0] });
      await load();
    } finally {
      setSellLoading(false);
    }
  }

  async function handleClearAll() {
    if (!window.confirm(`Delete all ${holdings.length} holdings? This cannot be undone.`)) return;
    await Promise.all(holdings.map((h) => storage.remove(TABLE, h.id)));
    setLivePrices({});
    await load();
  }

  // Enrich each holding — native currency values + CAD equivalents
  const toCAD = (val: number, cur: Currency) => cur === 'USD' ? val * usdCadRate : val;

  const enriched = holdings.map((h) => {
    const lp = livePrices[h.ticker];
    const finnhubPrice = lp?.price && lp.price > 0 ? lp.price : null;
    const currentPrice = manualPrices[h.ticker] ?? finnhubPrice ?? h.avg_cost;
    const priceSource: 'manual' | 'live' | 'cost' =
      manualPrices[h.ticker] ? 'manual' : finnhubPrice ? 'live' : 'cost';

    const marketValue = h.shares * currentPrice;           // native currency
    const costBasis   = h.shares * h.avg_cost;             // native currency
    const pnl         = marketValue - costBasis;            // native currency
    const pnlPct      = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

    const cadMarketValue = toCAD(marketValue, h.currency);
    const cadCostBasis   = toCAD(costBasis, h.currency);
    const cadPnl         = cadMarketValue - cadCostBasis;

    return {
      ...h, currentPrice, priceSource,
      marketValue, costBasis, pnl, pnlPct,
      cadMarketValue, cadCostBasis, cadPnl,
      changePct: lp?.changePct ?? 0,
    };
  });

  // Allocation % relative to TOTAL portfolio in CAD (all accounts)
  const totalPortfolioCAD = enriched.reduce((s, h) => s + h.cadMarketValue, 0);

  const withAlloc = enriched.map((h) => ({
    ...h,
    allocationPct: totalPortfolioCAD > 0 ? (h.cadMarketValue / totalPortfolioCAD) * 100 : 0,
  }));

  // Filter by account
  const baseFiltered = filterAccount === 'ALL' ? withAlloc : withAlloc.filter((h) => h.account === filterAccount);

  // Sort
  const filtered = sortKey
    ? [...baseFiltered].sort((a, b) => {
        const aVal = a[sortKey as keyof typeof a];
        const bVal = b[sortKey as keyof typeof b];
        let cmp = 0;
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          cmp = aVal.localeCompare(bVal);
        } else {
          cmp = (aVal as number) - (bVal as number);
        }
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : baseFiltered;

  // Summary stats scoped to the filtered (account) view — always in CAD
  const summaryValueCAD = filtered.reduce((s, h) => s + h.cadMarketValue, 0);
  const summaryCostCAD  = filtered.reduce((s, h) => s + h.cadCostBasis, 0);
  const summaryPnLCAD   = summaryValueCAD - summaryCostCAD;
  const summaryPnLPct   = summaryCostCAD > 0 ? (summaryPnLCAD / summaryCostCAD) * 100 : 0;


  // Account breakdown (all accounts, CAD)
  const accountMap: Record<string, number> = {};
  withAlloc.forEach((h) => {
    accountMap[h.account] = (accountMap[h.account] ?? 0) + h.cadMarketValue;
  });

  // Sector pie uses filtered view in CAD
  const sectorMap: Record<string, number> = {};
  filtered.forEach((h) => {
    sectorMap[h.sector] = (sectorMap[h.sector] ?? 0) + h.cadMarketValue;
  });
  const sectorTotal = Object.values(sectorMap).reduce((s, v) => s + v, 0);
  const pieData = Object.entries(sectorMap)
    .map(([name, val]) => ({ name, value: +(sectorTotal > 0 ? (val / sectorTotal) * 100 : 0).toFixed(1) }));

  const maxAlloc = filtered.reduce((m, h) => Math.max(m, h.allocationPct), 0);
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
  const accountLabel = filterAccount === 'ALL' ? 'All Accounts' : filterAccount;

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
          {/* Exchange rate strip */}
          <div className="flex items-center gap-3 px-1">
            <span className="text-xs text-zinc-500">USD/CAD rate:</span>
            {editingRate ? (
              <div className="flex items-center gap-1">
                <input
                  ref={rateInputRef}
                  type="number"
                  step="0.0001"
                  className="w-20 bg-zinc-800 border border-blue-500 rounded px-2 py-0.5 text-xs text-zinc-100 focus:outline-none"
                  value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRate(); if (e.key === 'Escape') setEditingRate(false); }}
                />
                <button onClick={commitRate} className="text-emerald-400 p-0.5"><Check size={12} /></button>
                <button onClick={() => setEditingRate(false)} className="text-zinc-500 p-0.5"><X size={12} /></button>
              </div>
            ) : (
              <button
                onClick={() => { setRateInput(usdCadRate.toFixed(4)); setEditingRate(true); }}
                className="group flex items-center gap-1.5 text-xs text-zinc-300 hover:text-blue-300 transition-colors"
              >
                <span className="font-mono font-semibold">{usdCadRate.toFixed(4)}</span>
                <Pencil size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
              </button>
            )}
            <button
              onClick={fetchRate}
              disabled={rateLoading}
              className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
              title="Refresh live rate from Finnhub"
            >
              <RefreshCw size={11} className={rateLoading ? 'animate-spin' : ''} />
              {rateLoading ? 'Fetching…' : 'Refresh'}
            </button>
            <span className="text-xs text-zinc-700">· All portfolio totals shown in CAD</span>
          </div>

          {/* Summary bar — scoped to selected account, always CAD */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="card py-3">
              <div className="text-xs text-zinc-500 mb-1">
                Portfolio Value
                {filterAccount !== 'ALL' && <span className={`ml-1 font-semibold ${accountColors[filterAccount as Account]}`}>· {filterAccount}</span>}
              </div>
              <div className="text-xl font-bold">{fmtCAD(summaryValueCAD)}</div>
              <div className="text-xs text-zinc-600 mt-0.5">{accountLabel}</div>
            </div>
            <div className="card py-3">
              <div className="text-xs text-zinc-500 mb-1">Total Cost Basis</div>
              <div className="text-xl font-bold">{fmtCAD(summaryCostCAD)}</div>
              <div className="text-xs text-zinc-600 mt-0.5">{accountLabel}</div>
            </div>
            <div className={`card py-3 ${summaryPnLCAD >= 0 ? 'border-emerald-900' : 'border-red-900'}`}>
              <div className="text-xs text-zinc-500 mb-1">Unrealized P&L</div>
              <div className={`text-xl font-bold ${summaryPnLCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {summaryPnLCAD >= 0 ? '+' : ''}{fmtCAD(summaryPnLCAD)}
              </div>
              <div className={`text-xs mt-0.5 ${summaryPnLCAD >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {summaryPnLPct >= 0 ? '+' : ''}{summaryPnLPct.toFixed(2)}%
              </div>
            </div>
            <div className={`card py-3 ${dailySnapshot ? (dailySnapshot.pct >= 0 ? 'border-emerald-900' : 'border-red-900') : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs text-zinc-500">Today's Change</div>
                <button
                  onClick={() => {
                    setDailyPctInput(dailySnapshot?.pct.toString() ?? '');
                    setDailyCadInput(dailySnapshot?.cad.toString() ?? '');
                    setEditingDaily(true);
                  }}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors"
                  title="Update today's change"
                >
                  <Pencil size={11} />
                </button>
              </div>

              {editingDaily ? (
                <div className="space-y-1.5 mt-1">
                  <div className="flex items-center gap-1">
                    <input
                      type="number" step="0.01" placeholder="% e.g. -1.2"
                      value={dailyPctInput}
                      onChange={(e) => setDailyPctInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveDailySnapshot(); if (e.key === 'Escape') setEditingDaily(false); }}
                      className="w-24 bg-zinc-700 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none"
                      autoFocus
                    />
                    <span className="text-zinc-600 text-xs">%</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      type="number" step="0.01" placeholder="$ CAD (opt)"
                      value={dailyCadInput}
                      onChange={(e) => setDailyCadInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveDailySnapshot(); if (e.key === 'Escape') setEditingDaily(false); }}
                      className="w-24 bg-zinc-700 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none"
                    />
                    <span className="text-zinc-600 text-xs">CAD</span>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={saveDailySnapshot} className="text-emerald-400 hover:text-emerald-300 p-0.5"><Check size={12} /></button>
                    <button onClick={() => setEditingDaily(false)} className="text-zinc-500 hover:text-zinc-300 p-0.5"><X size={12} /></button>
                  </div>
                </div>
              ) : dailySnapshot ? (
                <>
                  <div className={`text-xl font-bold ${dailySnapshot.pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {dailySnapshot.pct >= 0 ? '+' : ''}{dailySnapshot.pct.toFixed(2)}%
                  </div>
                  {dailySnapshot.cad !== 0 && (
                    <div className={`text-xs tabular-nums mt-0.5 ${dailySnapshot.cad >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {dailySnapshot.cad >= 0 ? '+' : ''}{fmtCAD(dailySnapshot.cad)}
                    </div>
                  )}
                  <div className="text-xs text-zinc-700 mt-1">
                    EOD {new Date(dailySnapshot.updatedAt).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </>
              ) : (
                <div className="text-sm text-zinc-600 mt-1">Click ✏️ to update</div>
              )}
            </div>
            <div className="card py-3">
              <div className="text-xs text-zinc-500 mb-1">Holdings</div>
              <div className="text-xl font-bold">
                {filtered.length}
                <span className="text-sm text-zinc-500 font-normal"> / {holdings.length} total</span>
              </div>
              <div className="text-xs text-zinc-600 mt-0.5">{uniqueAccounts.length} accounts</div>
            </div>
          </div>

          {/* Holdings table */}
          <div className="card">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h2 className="text-base font-semibold text-zinc-100">
                Holdings by Account
                <span className="text-zinc-600 text-sm font-normal ml-2">({holdings.length})</span>
              </h2>
              <div className="flex gap-1 flex-wrap items-center">
                {['ALL', ...uniqueAccounts].map((a) => (
                  <button key={a} onClick={() => setFilterAccount(a)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition ${filterAccount === a ? 'bg-blue-900/50 text-blue-300 border-blue-700' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
                    {a}
                  </button>
                ))}
                <button
                  onClick={handleClearAll}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-red-900 text-red-500 hover:bg-red-950/40 transition ml-2"
                  title="Delete all holdings"
                >
                  <AlertTriangle size={10} /> Clear all
                </button>
              </div>
            </div>

            <p className="text-xs text-zinc-600 mb-3">
              Click any price in the <span className="text-zinc-400">Current</span> column to enter it manually.
              <span className="text-amber-500 font-semibold ml-2">M ×</span> = manual override — click it to restore auto pricing.
              Market Value and P&L shown in native currency; totals converted to CAD above.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800">
                    {([
                      { label: 'Ticker',       key: 'ticker'        },
                      { label: 'Account',      key: 'account'       },
                      { label: 'Cur',          key: 'currency'      },
                      { label: 'Shares',       key: 'shares'        },
                      { label: 'Avg Cost',     key: 'avg_cost'      },
                      { label: 'Current',      key: 'currentPrice'  },
                      { label: 'Day %',        key: 'changePct'     },
                      { label: 'Book Value',   key: 'costBasis'     },
                      { label: 'Mkt Value',    key: 'marketValue'   },
                      { label: 'P&L (native)', key: 'pnl'           },
                      { label: 'Alloc %',      key: 'allocationPct' },
                      { label: 'Sector',       key: 'sector'        },
                    ] as { label: string; key: SortKey }[]).map(({ label, key }) => (
                      <th key={key} className="th">
                        <button
                          onClick={() => handleSort(key)}
                          className="flex items-center gap-1 hover:text-zinc-100 transition-colors group whitespace-nowrap"
                        >
                          {label}
                          <span className="text-zinc-600 group-hover:text-zinc-400 transition-colors">
                            {sortKey === key
                              ? sortDir === 'asc'
                                ? <ChevronUp size={11} className="text-blue-400" />
                                : <ChevronDown size={11} className="text-blue-400" />
                              : <ChevronsUpDown size={11} />}
                          </span>
                        </button>
                      </th>
                    ))}
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {filtered.map((h) => (
                    <tr key={h.id} className="tr-hover">
                      <td className="td">
                        <button
                          onClick={() => setSelectedTicker({ ticker: h.ticker, currency: h.currency })}
                          className="font-mono font-bold text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 transition-colors flex items-center gap-1 group"
                          title={`View fundamentals for ${h.ticker}`}
                        >
                          {h.ticker}
                          <ExternalLink size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                        </button>
                      </td>
                      <td className="td"><span className={`text-xs font-semibold ${accountColors[h.account]}`}>{h.account}</span></td>
                      <td className="td text-xs text-zinc-500">{h.currency}</td>
                      <td className="td tabular-nums text-xs">{fmt(h.shares, 3)}</td>
                      <td className="td tabular-nums">{fmtCurrency(h.avg_cost)}</td>

                      {/* Manual-editable current price */}
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
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => startEditPrice(h.ticker, h.currentPrice)}
                              className="group flex items-center gap-1 hover:text-blue-300 transition-colors"
                              title={h.priceSource === 'cost' ? 'No live price — click to enter manually' : 'Click to override price'}
                            >
                              <span className={h.priceSource === 'cost' ? 'text-zinc-600' : ''}>{fmtCurrency(h.currentPrice)}</span>
                              {h.priceSource === 'cost' && <span className="text-xs text-zinc-600">—</span>}
                              <Pencil size={10} className="opacity-0 group-hover:opacity-60 text-zinc-400 transition-opacity" />
                            </button>
                            {h.priceSource === 'manual' && (
                              <button
                                onClick={() => clearManualPrice(h.ticker)}
                                className="text-xs font-bold text-amber-500 hover:text-white hover:bg-amber-600 px-1 rounded transition-colors leading-none py-0.5"
                                title="Manual override — click to restore auto price"
                              >
                                M ×
                              </button>
                            )}
                          </div>
                        )}
                      </td>

                      <td className={`td tabular-nums text-xs font-medium ${h.changePct > 0 ? 'text-emerald-400' : h.changePct < 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                        {h.priceSource === 'manual' ? <span className="text-zinc-600">—</span> : fmtPct(h.changePct)}
                      </td>

                      {/* Book Value = cost basis, native currency */}
                      <td className="td tabular-nums text-sm">
                        {fmtCurrency(h.costBasis)}
                        <span className="text-xs text-zinc-600 ml-1">{h.currency}</span>
                      </td>

                      {/* Market value — native currency */}
                      <td className="td tabular-nums font-medium text-sm">
                        {fmtCurrency(h.marketValue)}
                        <span className="text-xs text-zinc-600 ml-1">{h.currency}</span>
                      </td>

                      {/* P&L native */}
                      <td className={`td tabular-nums font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {h.pnl >= 0 ? '+' : ''}{fmtCurrency(h.pnl)}
                        <br /><span className="text-xs">{fmtPct(h.pnlPct)}</span>
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
                      <td className="td">
                        {sellId === h.id ? (
                          <div className="flex items-center gap-1 flex-wrap">
                            <input type="number" step="0.0001" placeholder="Exit $" value={sellForm.exitPrice}
                              onChange={(e) => setSellForm({ ...sellForm, exitPrice: e.target.value })}
                              className="w-20 bg-zinc-700 border border-amber-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none" />
                            <input type="number" step="0.001" placeholder={`Qty (${h.shares})`} value={sellForm.qtySold}
                              onChange={(e) => setSellForm({ ...sellForm, qtySold: e.target.value })}
                              className="w-20 bg-zinc-700 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none" />
                            <input type="date" value={sellForm.dateSold}
                              onChange={(e) => setSellForm({ ...sellForm, dateSold: e.target.value })}
                              className="w-28 bg-zinc-700 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none" />
                            <button onClick={() => handleSell(h)} disabled={sellLoading}
                              className="btn-primary text-xs px-2 py-1 flex items-center gap-1">
                              <Check size={11} />{sellLoading ? '...' : 'Sell'}
                            </button>
                            <button onClick={() => setSellId(null)} className="btn-ghost p-1"><X size={11} /></button>
                          </div>
                        ) : (
                          <div className="flex gap-1">
                            <button onClick={() => { setSellId(h.id); setSellForm({ exitPrice: h.currentPrice.toFixed(2), qtySold: h.shares.toString(), dateSold: new Date().toISOString().split('T')[0] }); }}
                              className="text-xs px-2 py-1 rounded border border-amber-700 text-amber-400 hover:bg-amber-900/30 transition-colors font-medium">
                              Sell
                            </button>
                            <button onClick={() => startEdit(h)} className="btn-ghost p-1" title="Edit holding"><Edit2 size={12} /></button>
                            <button onClick={() => handleDelete(h.id)} className="btn-danger" title="Delete"><Trash2 size={12} /></button>
                          </div>
                        )}
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
              <h2 className="text-base font-semibold text-zinc-100 mb-1">Sector Allocation</h2>
              <p className="text-xs text-zinc-600 mb-3">{accountLabel} · % of CAD value</p>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={({ value }) => `${value.toFixed(1)}%`} labelLine={false}>
                    {pieData.map((_, i) => <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />)}
                  </Pie>
                  <Tooltip
                    formatter={(v: number) => [`${v.toFixed(1)}%`, 'Allocation']}
                    contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
                    labelStyle={{ color: '#ffffff', fontWeight: 600 }}
                    itemStyle={{ color: '#ffffff' }}
                  />
                  <Legend formatter={(value) => <span className="text-xs text-zinc-400">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-4">
              {/* Account breakdown in CAD */}
              <div className="card">
                <h2 className="text-sm font-semibold text-zinc-100 mb-1">Account Breakdown</h2>
                <p className="text-xs text-zinc-600 mb-3">All accounts · CAD</p>
                {Object.entries(accountMap).sort((a, b) => b[1] - a[1]).map(([acct, val]) => (
                  <div key={acct} className="flex items-center gap-2 text-xs mb-2">
                    <span className={`w-20 font-semibold ${accountColors[acct as Account]}`}>{acct}</span>
                    <div className="flex-1 bg-zinc-700 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${totalPortfolioCAD > 0 ? (val / totalPortfolioCAD) * 100 : 0}%` }} />
                    </div>
                    <span className="text-zinc-400 w-28 text-right tabular-nums">{fmtCAD(val)}</span>
                    <span className="text-zinc-600 w-10 text-right">{totalPortfolioCAD > 0 ? fmt((val / totalPortfolioCAD) * 100, 1) : '0'}%</span>
                  </div>
                ))}
                <div className="border-t border-zinc-800 mt-2 pt-2 flex justify-between text-xs">
                  <span className="text-zinc-500">Total portfolio</span>
                  <span className="font-bold tabular-nums">{fmtCAD(totalPortfolioCAD)}</span>
                </div>
              </div>

              {/* Concentration */}
              <div className="card">
                <h2 className="text-sm font-semibold text-zinc-100 mb-3">Concentration Analysis</h2>
                <div className="space-y-1.5">
                  {[
                    { label: 'Max single position', value: `${fmt(maxAlloc, 1)}%` },
                    { label: 'Concentration Risk', value: concentrationRisk, colored: true },
                    { label: 'Holdings shown', value: `${filtered.length}` },
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
                  {[...filtered].sort((a, b) => b.allocationPct - a.allocationPct).slice(0, 8).map((h) => (
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
              <div className="flex items-start justify-between mb-1 flex-wrap gap-2">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">Correlation Heatmap</h2>
                  <p className="text-xs text-zinc-600 mt-0.5">
                    Sector-based estimate — not real price correlation.
                    Higher values = stocks likely move together = less diversification benefit.
                  </p>
                </div>
                {/* Legend */}
                <div className="flex items-center gap-2 flex-wrap">
                  {[
                    { bg: 'bg-red-700',      label: '0.9–1.0', tip: 'Same stock or near-identical sector' },
                    { bg: 'bg-red-600/60',   label: '0.7–0.9', tip: 'Same sector' },
                    { bg: 'bg-amber-600/60', label: '0.5–0.7', tip: 'Related sectors (e.g. Tech + Comm)' },
                    { bg: 'bg-zinc-600',     label: '0.3–0.5', tip: 'Moderate' },
                    { bg: 'bg-zinc-700/50',  label: '0.0–0.3', tip: 'Low / unrelated sectors' },
                  ].map(({ bg, label, tip }) => (
                    <div key={label} className="flex items-center gap-1" title={tip}>
                      <div className={`w-4 h-4 rounded ${bg}`} />
                      <span className="text-xs text-zinc-500">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 p-3 bg-zinc-900/50 rounded-lg border border-zinc-800 text-xs text-zinc-500 mb-4 space-y-1">
                <div><span className="text-zinc-300 font-medium">How to read it:</span> Each cell shows how closely two stocks are expected to move together (0 = no relationship, 1 = move in lockstep).</div>
                <div>Two Technology stocks get <span className="text-red-400 font-mono">0.75</span> — they tend to fall together in sell-offs. A Technology + Energy pair gets <span className="text-zinc-300 font-mono">0.20</span> — much better diversification.</div>
                <div className="text-zinc-600">⚠ This uses sector rules, not actual 1-year price history. Use as a rough guide only.</div>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead>
                    <tr>
                      <th className="w-16" />
                      {tickers.map((t) => <th key={t} className="text-center font-mono text-zinc-400 pb-2 px-0.5 min-w-10">{t.slice(0, 5)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {tickers.map((rowT) => (
                      <tr key={rowT}>
                        <td className="font-mono text-zinc-400 pr-2 py-0.5 text-xs">{rowT.slice(0, 7)}</td>
                        {tickers.map((colT) => {
                          const v = sectorCorr(rowT, colT);
                          return (
                            <td key={colT} className="p-0.5">
                              <div
                                className={`w-9 h-9 rounded flex items-center justify-center font-semibold text-white/80 text-xs ${corrColor(v)}`}
                                title={`${rowT} ↔ ${colT}: ${v.toFixed(2)}`}
                              >
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
        </>
      )}

      {holdings.length === 0 && (
        <div className="card text-center py-12 space-y-3">
          <p className="text-zinc-400 font-medium">No holdings yet</p>
          <p className="text-zinc-600 text-sm">Use the <span className="text-zinc-300 font-medium">Add Holding</span> form above to add positions one at a time.</p>
          <p className="text-zinc-700 text-xs">Or click <span className="text-zinc-500">Import Data</span> in the top header to load your full portfolio from the Excel file.</p>
        </div>
      )}

      {/* Fundamentals drawer */}
      {selectedTicker && (
        <FundamentalsDrawer ticker={selectedTicker.ticker} currency={selectedTicker.currency} onClose={() => setSelectedTicker(null)} />
      )}
    </div>
  );
}
