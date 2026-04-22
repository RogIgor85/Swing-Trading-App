import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Edit2, X, Check, Pencil, RefreshCw, AlertTriangle, ExternalLink, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import { fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import type { Holding, LiquidityRisk, Account, Currency } from '../../types';
import type { YahooData } from '../../lib/yahoo';

const MANUAL_PRICES_KEY = 'swing_manual_prices';
const TABLE = 'portfolio_holdings';
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

// ─── Fundamentals drawer ──────────────────────────────────────────────────────
function fmtBig(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}
function fmtPct2(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
function fmtNum(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

function recLabel(key: string | null | undefined): { label: string; color: string } {
  switch (key) {
    case 'strongBuy':    return { label: 'Strong Buy',  color: 'text-emerald-400' };
    case 'buy':          return { label: 'Buy',          color: 'text-emerald-300' };
    case 'hold':         return { label: 'Hold',         color: 'text-amber-400'   };
    case 'underperform': return { label: 'Underperform', color: 'text-red-400'     };
    case 'sell':         return { label: 'Sell',         color: 'text-red-500'     };
    default:             return { label: '—',            color: 'text-zinc-500'    };
  }
}

const TSX_SUFFIXES = ['.TO', '.V', '.TSX', '.CN', '.NEO', '.VN'];

function toYahooTicker(ticker: string, currency: string): string {
  // If already has an exchange suffix, use as-is
  if (TSX_SUFFIXES.some((s) => ticker.toUpperCase().endsWith(s))) return ticker;
  // CAD holdings without a suffix → assume TSX, append .TO
  if (currency === 'CAD') return `${ticker}.TO`;
  return ticker;
}

function FundamentalsDrawer({ ticker, currency, onClose }: { ticker: string; currency: string; onClose: () => void }) {
  const [data, setData] = useState<YahooData | null>(null);
  const [loading, setLoading] = useState(true);

  const yahooTicker = toYahooTicker(ticker, currency);

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetchYahoo(yahooTicker).then((d) => { setData(d); setLoading(false); });
  }, [yahooTicker]);

  const p  = data?.price;
  const sd = data?.summaryDetail;
  const fd = data?.financialData;
  const ks = data?.defaultKeyStatistics;
  const cal = data?.calendarEvents?.earnings;

  const price    = p?.regularMarketPrice ?? null;
  const prevClose = p?.regularMarketPreviousClose ?? sd?.regularMarketPreviousClose ?? null;
  const dayChange = price != null && prevClose != null ? price - prevClose : null;
  const dayChangePct = price != null && prevClose != null && prevClose !== 0 ? (dayChange! / prevClose) * 100 : null;
  const dayHigh  = p?.regularMarketDayHigh ?? sd?.dayHigh ?? null;
  const dayLow   = p?.regularMarketDayLow  ?? sd?.dayLow  ?? null;
  const marketCap = p?.marketCap ?? sd?.marketCap ?? null;

  const rec = recLabel(fd?.recommendationKey);
  const earningsDate = cal?.earningsDate?.[0] ?? null;

  const w52High = sd?.fiftyTwoWeekHigh ?? null;
  const w52Low  = sd?.fiftyTwoWeekLow  ?? null;
  const ma50    = sd?.fiftyDayAverage  ?? null;
  const ma200   = sd?.twoHundredDayAverage ?? null;
  const w52Pct  = price != null && w52Low != null && w52High != null && w52High !== w52Low
    ? ((price - w52Low) / (w52High - w52Low)) * 100
    : null;

  function Row({ label, value, colored }: { label: string; value: string; colored?: string }) {
    return (
      <div className="flex justify-between items-center py-1.5 border-b border-zinc-800/60 last:border-0">
        <span className="text-xs text-zinc-500">{label}</span>
        <span className={`text-xs font-medium tabular-nums ${colored ?? 'text-zinc-200'}`}>{value}</span>
      </div>
    );
  }

  function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
      <div className="mb-4">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1 pb-1 border-b border-zinc-800">{title}</div>
        {children}
      </div>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer panel */}
      <div className="fixed right-0 top-0 h-full w-80 bg-zinc-950 border-l border-zinc-800 z-50 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div>
            <div className="flex items-baseline gap-2">
              <div className="font-mono font-bold text-blue-400 text-lg">{ticker}</div>
              {yahooTicker !== ticker && (
                <span className="text-xs text-zinc-600 font-mono">{yahooTicker}</span>
              )}
            </div>
            {p?.longName && <div className="text-xs text-zinc-400 truncate mt-0.5 max-w-56">{p.longName}</div>}
            {p?.exchangeName && <div className="text-xs text-zinc-600">{p.exchangeName} · {p.currency}</div>}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-zinc-500">Loading {ticker}…</span>
            </div>
          ) : data?._error ? (
            <div className="flex flex-col items-center justify-center h-40 gap-2 text-center">
              <AlertTriangle size={20} className="text-amber-500" />
              <p className="text-xs text-zinc-500">No data available for {ticker}</p>
              <p className="text-xs text-zinc-700">May be a mutual fund or unlisted ticker</p>
            </div>
          ) : (
            <>
              {/* Price hero */}
              <div className="mb-5 bg-zinc-900 rounded-xl p-4">
                <div className="text-3xl font-bold tabular-nums">
                  {price != null ? fmtCurrency(price) : '—'}
                </div>
                {dayChange != null && (
                  <div className={`flex items-center gap-1.5 mt-1 text-sm font-medium ${dayChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {dayChange >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                    {dayChange >= 0 ? '+' : ''}{fmtCurrency(dayChange)} ({dayChangePct?.toFixed(2)}%)
                  </div>
                )}
                {(dayHigh != null || dayLow != null) && (
                  <div className="text-xs text-zinc-600 mt-1.5">
                    Day: {dayLow != null ? fmtCurrency(dayLow) : '—'} – {dayHigh != null ? fmtCurrency(dayHigh) : '—'}
                  </div>
                )}
              </div>

              {/* 52-week range bar */}
              {w52Pct != null && (
                <div className="mb-5 bg-zinc-900 rounded-xl p-3">
                  <div className="flex justify-between text-xs text-zinc-600 mb-1">
                    <span>52W Low: {fmtCurrency(w52Low!)}</span>
                    <span>52W High: {fmtCurrency(w52High!)}</span>
                  </div>
                  <div className="relative bg-zinc-700 rounded-full h-2">
                    <div className="absolute bg-gradient-to-r from-red-500 to-emerald-500 h-2 rounded-full w-full opacity-30" />
                    <div
                      className="absolute w-3 h-3 bg-white rounded-full border-2 border-zinc-900 shadow-md"
                      style={{ left: `calc(${w52Pct.toFixed(1)}% - 6px)`, top: '-2px' }}
                    />
                  </div>
                  <div className="text-center text-xs text-zinc-500 mt-1">{w52Pct.toFixed(0)}% of 52W range</div>
                </div>
              )}

              <Section title="Moving Averages">
                <Row label="50-Day MA"    value={ma50  != null ? fmtCurrency(ma50)  : '—'} colored={price != null && ma50  != null ? (price > ma50  ? 'text-emerald-400' : 'text-red-400') : undefined} />
                <Row label="200-Day MA"   value={ma200 != null ? fmtCurrency(ma200) : '—'} colored={price != null && ma200 != null ? (price > ma200 ? 'text-emerald-400' : 'text-red-400') : undefined} />
              </Section>

              <Section title="Valuation">
                <Row label="Market Cap"   value={fmtBig(marketCap)} />
                <Row label="Trailing P/E" value={fmtNum(sd?.trailingPE, 1)} />
                <Row label="Forward P/E"  value={fmtNum(sd?.forwardPE ?? ks?.forwardPE, 1)} />
                <Row label="Price/Book"   value={fmtNum(ks?.priceToBook, 1)} />
                <Row label="PEG Ratio"    value={fmtNum(ks?.pegRatio, 2)} />
                <Row label="Beta"         value={fmtNum(sd?.beta ?? ks?.beta, 2)} />
              </Section>

              <Section title="Fundamentals">
                <Row label="Revenue Growth"  value={fmtPct2(fd?.revenueGrowth)}  colored={fd?.revenueGrowth != null ? (fd.revenueGrowth >= 0 ? 'text-emerald-400' : 'text-red-400') : undefined} />
                <Row label="Earnings Growth" value={fmtPct2(fd?.earningsGrowth)} colored={fd?.earningsGrowth != null ? (fd.earningsGrowth >= 0 ? 'text-emerald-400' : 'text-red-400') : undefined} />
                <Row label="Profit Margin"   value={fmtPct2(fd?.profitMargins ?? ks?.profitMargins)} />
                <Row label="ROE"             value={fmtPct2(fd?.returnOnEquity)} />
                <Row label="Free Cash Flow"  value={fmtBig(fd?.freeCashflow)} />
                <Row label="Current Ratio"   value={fmtNum(fd?.currentRatio, 2)} />
                <Row label="Debt / Equity"   value={fd?.debtToEquity != null ? `${fmtNum(fd.debtToEquity / 100, 2)}x` : '—'} colored={fd?.debtToEquity != null ? (fd.debtToEquity < 100 ? 'text-emerald-400' : fd.debtToEquity < 200 ? 'text-amber-400' : 'text-red-400') : undefined} />
              </Section>

              <Section title="Analyst Coverage">
                <Row label="Recommendation" value={rec.label} colored={rec.color} />
                <Row label="Analysts"        value={fd?.numberOfAnalystOpinions != null ? `${fd.numberOfAnalystOpinions}` : '—'} />
                <Row label="Target (mean)"   value={fd?.targetMeanPrice != null ? fmtCurrency(fd.targetMeanPrice) : '—'} />
                <Row label="Target (high)"   value={fd?.targetHighPrice != null ? fmtCurrency(fd.targetHighPrice) : '—'} />
                <Row label="Target (low)"    value={fd?.targetLowPrice  != null ? fmtCurrency(fd.targetLowPrice)  : '—'} />
                {price != null && fd?.targetMeanPrice != null && (
                  <Row
                    label="Upside to target"
                    value={`${((fd.targetMeanPrice - price) / price * 100).toFixed(1)}%`}
                    colored={(fd.targetMeanPrice >= price) ? 'text-emerald-400' : 'text-red-400'}
                  />
                )}
              </Section>

              <Section title="Risk & Flow">
                <Row label="Short % of Float" value={ks?.shortPercentOfFloat != null ? fmtPct2(ks.shortPercentOfFloat) : '—'} colored={ks?.shortPercentOfFloat != null ? (ks.shortPercentOfFloat > 0.1 ? 'text-red-400' : 'text-zinc-200') : undefined} />
                <Row label="Short Ratio"      value={fmtNum(ks?.shortRatio, 1)} />
                <Row label="Avg Volume"       value={sd?.averageVolume != null ? `${(sd.averageVolume / 1e6).toFixed(1)}M` : '—'} />
              </Section>

              {earningsDate && (
                <Section title="Events">
                  <Row label="Next Earnings" value={new Date(earningsDate).toLocaleDateString('en-CA')} colored="text-blue-300" />
                </Section>
              )}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="p-3 border-t border-zinc-800 text-xs text-zinc-700 text-center">
          Data via Yahoo Finance · {data?._partial ? 'partial data' : 'full fundamentals'}
        </div>
      </div>
    </>
  );
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

  // Fetch stock prices
  useEffect(() => {
    holdings.forEach((h) => {
      if (!livePrices[h.ticker]) {
        finnhub.quote(h.ticker)
          .then((q) => setLivePrices((prev) => ({ ...prev, [h.ticker]: { price: q.c, changePct: q.dp } })))
          .catch(() => {});
      }
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
  const filtered = filterAccount === 'ALL' ? withAlloc : withAlloc.filter((h) => h.account === filterAccount);

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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
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
              <span className="text-amber-500 font-semibold ml-2">M</span> = manual override.
              Market Value and P&L shown in native currency; totals converted to CAD above.
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
                    <th className="th">Mkt Value</th>
                    <th className="th">≈ CAD</th>
                    <th className="th">P&L (native)</th>
                    <th className="th">Alloc %</th>
                    <th className="th">Sector</th>
                    <th className="th">Liquidity</th>
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

                      <td className={`td tabular-nums text-xs font-medium ${h.changePct > 0 ? 'text-emerald-400' : h.changePct < 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                        {h.priceSource === 'manual' ? <span className="text-zinc-600">—</span> : fmtPct(h.changePct)}
                      </td>

                      {/* Market value — native currency */}
                      <td className="td tabular-nums font-medium text-sm">
                        {fmtCurrency(h.marketValue)}
                        <span className="text-xs text-zinc-600 ml-1">{h.currency}</span>
                      </td>

                      {/* CAD equivalent */}
                      <td className="td tabular-nums text-xs text-zinc-400">
                        {h.currency === 'USD'
                          ? fmtCAD(h.cadMarketValue)
                          : <span className="text-zinc-600">—</span>}
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
                      <td className="td"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${liquidityBg[h.liquidity_risk]}`}>{h.liquidity_risk}</span></td>
                      <td className="td">
                        <div className="flex gap-1">
                          <button onClick={() => startEdit(h)} className="btn-ghost p-1" title="Edit holding"><Edit2 size={12} /></button>
                          {h.priceSource === 'manual' && (
                            <button onClick={() => clearManualPrice(h.ticker)} className="btn-ghost p-1 text-amber-500 hover:text-amber-300" title="Clear manual price">
                              <X size={12} />
                            </button>
                          )}
                          <button onClick={() => handleDelete(h.id)} className="btn-danger" title="Delete"><Trash2 size={12} /></button>
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
