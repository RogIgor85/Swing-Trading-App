import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Plus, Trash2, Edit2, X, Check, Pencil, RefreshCw, AlertTriangle, ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, Calendar, Target } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { fetchYahoo } from '../../lib/yahoo';
import { getUsdCad, getUsdCadCached } from '../../lib/fx';
import { fetchQuote, fetchPortfolioHistories, purgeStaleCaches } from '../../lib/portfolio/portfolioData';
import { loadSectorOverrides, setSectorOverride, clearSectorOverride } from '../../lib/portfolio/sectorOverrides';
import {
  enrichHolding, withAllocation, computeTotals, computeAllocation,
  computeConcentration, computeRotationExposure, validateTotals, accountTotalsOf,
} from '../../lib/portfolio/portfolioEngine';
import type { EnrichedHolding } from '../../lib/portfolio/portfolioEngine';
import { publishAccountSnapshot } from '../../lib/portfolio/accountSnapshot';
import { computeCorrelationMatrix, averageCorrelation } from '../../lib/portfolio/correlation';
import { CORRELATION_SETTINGS, ROTATION_EXPOSURE_HELP, HOLDING_STATUS_STYLE, UNCLASSIFIED_LABEL, SECTOR_NAME_BY_ETF } from '../../config/portfolioConfig';
import { resolveSectors } from '../../lib/watch/watchSectorContext';
import { fetchAllHistories, fetchConstituentQuotes, fetchConstituentHistories } from '../../lib/sector/sectorData';
import { computeSectorMetrics } from '../../lib/sector/sectorEngine';
import type { SectorMetrics } from '../../lib/sector/sectorEngine';
import { PRESSURE_HELP, describePressure } from '../../lib/sector/pressureHelp';
import { navigateTo } from '../../lib/navigation';
import { toYahooTicker } from '../FundamentalsDrawer';
import { fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import FundamentalsDrawer from '../FundamentalsDrawer';
import type { Holding, LiquidityRisk, Account, Currency } from '../../types';

const MANUAL_PRICES_KEY  = 'swing_manual_prices';
const LIVE_PRICES_KEY    = 'swing_live_prices';
const DAILY_CHANGE_KEY   = 'swing_daily_change';
const EARNINGS_CACHE_KEY = 'swing_earnings_dates';
const TARGET_NOTIFIED_KEY = 'swing_target_notified';

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

const ACCOUNTS: Account[] = ['Brokerage', 'RRSP', 'LIRA', 'TSFA', 'HSA', 'Crypto', 'Other'];
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
  RRSP:      'text-emerald-400',
  LIRA:      'text-purple-400',
  TSFA:      'text-amber-400',
  HSA:       'text-cyan-400',
  Crypto:    'text-orange-400',
  Other:     'text-zinc-400',
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
  purchase_date: '',
  sell_date: '',
  target_price: '',
};

interface LivePrice { price: number; changePct: number; prevClose: number }

function loadManualPrices(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(MANUAL_PRICES_KEY) ?? '{}'); } catch { return {}; }
}
function saveManualPrices(prices: Record<string, number>) {
  localStorage.setItem(MANUAL_PRICES_KEY, JSON.stringify(prices));
}

function fmtCAD(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n);
}


// Reusable date picker: styled button + hidden native input opened via showPicker()
function DatePicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  function open() {
    try { ref.current?.showPicker(); } catch { ref.current?.click(); }
  }
  return (
    <div className="w-36">
      <label className="label">{label}</label>
      <button
        type="button"
        onClick={open}
        className="input-base w-full flex items-center justify-between gap-2 cursor-pointer hover:border-zinc-500 transition-colors"
      >
        <span className={value ? 'text-zinc-100 tabular-nums text-sm' : 'text-zinc-500 text-xs'}>
          {value || 'Pick a date'}
        </span>
        <Calendar size={13} className="text-zinc-500 flex-shrink-0" />
      </button>
      <input
        ref={ref}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
        tabIndex={-1}
      />
    </div>
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

  // USD/CAD exchange rate — starts from last cached live rate
  const [usdCadRate, setUsdCadRate] = useState<number>(getUsdCadCached);
  const [rateLoading, setRateLoading] = useState(false);

  // Data freshness + progressively-loaded intelligence
  const [pricesUpdatedAt, setPricesUpdatedAt] = useState<Date | null>(null);
  const [fxUpdatedAt, setFxUpdatedAt]         = useState<Date | null>(null);
  const [closesByTicker, setCloses]           = useState<Map<string, number[]>>(new Map());
  const [sectorMetricsMap, setSectorMetrics]  = useState<Map<string, SectorMetrics>>(new Map());
  const [detectedSectors, setDetectedSectors] = useState<Record<string, string | null>>({});
  const [corrDays, setCorrDays]               = useState<number>(CORRELATION_SETTINGS.defaultDays);
  const [ctxLoading, setCtxLoading]           = useState(false);
  const [sectorOverrides, setSectorOverrides] = useState<Record<string, string>>(loadSectorOverrides);
  const [showSectorAudit, setShowSectorAudit] = useState(false);

  // Drop caches written while the price proxy was returning a year-old
  // "previous close" — otherwise the bad daily figures survive the fix.
  useEffect(() => { purgeStaleCaches(); }, []);
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


  type SortKey = 'ticker' | 'account' | 'currency' | 'shares' | 'avg_cost' | 'currentPrice' | 'changePct' | 'costBasis' | 'marketValue' | 'pnl' | 'allocationPct' | 'sector' | 'purchase_date' | 'sell_date'
    | 'pnlPct' | 'targetRemaining' | 'sectorPressure' | 'rsVsSector' | 'ret1M' | 'ret3M';
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

  // Fetch live USD/CAD rate on mount (Yahoo CAD=X, cached 12h)
  async function fetchRate() {
    setRateLoading(true);
    try {
      const rate = await getUsdCad();
      if (rate > 0) { setUsdCadRate(rate); setFxUpdatedAt(new Date()); }
    } catch { /* keep cached/default */ } finally {
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

  // Fetch stock prices. Exchange-suffixed tickers (.TO etc.) go to Yahoo only —
  // Finnhub ignores the suffix and returns the US listing's USD price, which
  // previously corrupted CAD holdings' prices and daily moves.
  useEffect(() => {
    holdings.forEach(async (h) => {
      if (livePrices[h.ticker]) return; // already have it
      const q = await fetchQuote(h.ticker);
      if (q) {
        setLivePrices((prev) => ({
          ...prev,
          [h.ticker]: {
            price: q.price,
            // percent kept for the localStorage contract other tabs read
            changePct: q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0,
            prevClose: q.prevClose ?? 0,
          },
        }));
        setPricesUpdatedAt(new Date());
      }
    });
  }, [holdings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Secondary intelligence (history, sectors, rotation) — loads AFTER prices
  // so the table is never blocked waiting on it.
  const tickerKey = holdings.map(h => h.ticker).sort().join(',');
  useEffect(() => {
    if (holdings.length === 0) return;
    let live = true;
    setCtxLoading(true);
    (async () => {
      try {
        const tickers = holdings.map(h => h.ticker.toUpperCase());
        const [hist, sectors] = await Promise.all([
          fetchPortfolioHistories(tickers),
          resolveSectors(tickers),
        ]);
        if (!live) return;
        setCloses(hist);
        setDetectedSectors(sectors);

        const [sh, sq, sc] = await Promise.all([
          fetchAllHistories(), fetchConstituentQuotes(), fetchConstituentHistories(),
        ]);
        if (!live) return;
        setSectorMetrics(new Map(computeSectorMetrics(sh, sq, sc).map(m => [m.etf, m])));
      } catch { /* optional context — table still works */ } finally {
        if (live) setCtxLoading(false);
      }
    })();
    return () => { live = false; };
  }, [tickerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist live prices to localStorage so Net Worth tab can read them
  useEffect(() => {
    if (Object.keys(livePrices).length > 0) {
      localStorage.setItem(LIVE_PRICES_KEY, JSON.stringify(livePrices));
    }
  }, [livePrices]);

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
          purchase_date: form.purchase_date || null,
          sell_date: form.sell_date || null,
          target_price: form.target_price ? parseFloat(form.target_price) : null,
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
            purchase_date: form.purchase_date || null,
            sell_date: form.sell_date || null,
            target_price: form.target_price ? parseFloat(form.target_price) : null,
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
      purchase_date: h.purchase_date ?? '',
      sell_date: h.sell_date ?? '',
      target_price: h.target_price?.toString() ?? '',
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

  // Enrich each holding through the portfolio engine (all math lives there).
  const toCAD = (val: number, cur: Currency) => cur === 'USD' ? val * usdCadRate : val;

  const engineRows: EnrichedHolding[] = useMemo(() => withAllocation(
    holdings.map((h) => {
      const lp = livePrices[h.ticker];
      const manual = manualPrices[h.ticker];
      const livePrice = lp?.price && lp.price > 0 ? lp.price : null;
      const price = manual != null
        ? { price: manual, prevClose: lp?.prevClose && lp.prevClose > 0 ? lp.prevClose : null, manual: true }
        : livePrice != null
          ? { price: livePrice, prevClose: lp?.prevClose && lp.prevClose > 0 ? lp.prevClose : null }
          : null;
      const sectorEtf = detectedSectors[h.ticker.toUpperCase()] ?? null;
      const override = sectorOverrides[h.ticker.toUpperCase()] ?? null;
      // Rotation always follows the CURRENT sector mapping — never stored on the holding
      const effectiveEtf = override
        ? Object.entries(SECTOR_NAME_BY_ETF).find(([, n]) => n === override)?.[0] ?? sectorEtf
        : sectorEtf;
      return enrichHolding({
        h, price, fxUsdCad: usdCadRate,
        detectedSectorEtf: sectorEtf,
        sectorOverride: override,
        sector: effectiveEtf ? sectorMetricsMap.get(effectiveEtf) ?? null : null,
        closes: closesByTicker.get(h.ticker.toUpperCase()),
      });
    })
  ), [holdings, livePrices, manualPrices, usdCadRate, detectedSectors, sectorMetricsMap, closesByTicker, sectorOverrides]);

  const engineByTicker = useMemo(
    () => new Map(engineRows.map(r => [r.ticker, r])), [engineRows]);

  // Publish account balances so Scorecard position sizing uses real values.
  // Only once prices have actually loaded — otherwise we'd broadcast zeros.
  useEffect(() => {
    if (engineRows.length === 0) return;
    if (!engineRows.some(r => r.marketValueCAD > 0)) return;
    publishAccountSnapshot(accountTotalsOf(engineRows));
  }, [engineRows]);

  // Compatibility view — keeps the existing table markup working while
  // exposing the full engine row as `_e` for the new columns.
  const enriched = engineRows.map((r) => ({
    ...r.h,
    currentPrice: r.currentPrice ?? r.h.avg_cost,
    priceSource: r.priceSource,
    marketValue: r.marketValueNative,
    costBasis: r.costBasisNative,
    pnl: r.pnlNative,
    pnlPct: r.pnlPct ?? 0,
    cadMarketValue: r.marketValueCAD,
    cadCostBasis: r.costBasisCAD,
    cadPnl: r.pnlCAD,
    changePct: r.dailyPct,
    _e: r,
  }));

  // ── Sell-target hits: banner + one browser notification per ticker per day ──
  const targetHits = enriched.filter(h =>
    h.target_price != null && h.target_price > 0
    && h.priceSource !== 'cost'
    && h.currentPrice >= h.target_price
    && (h.currentPrice - h.target_price) / h.target_price <= 1  // ignore ancient targets
  );

  useEffect(() => {
    if (targetHits.length === 0) return;
    const today = new Date().toISOString().split('T')[0];
    let notified: Record<string, string> = {};
    try { notified = JSON.parse(localStorage.getItem(TARGET_NOTIFIED_KEY) ?? '{}'); } catch { /* fresh */ }

    const fresh = targetHits.filter(h => notified[h.ticker] !== today);
    if (fresh.length === 0) return;

    fresh.forEach(h => { notified[h.ticker] = today; });
    localStorage.setItem(TARGET_NOTIFIED_KEY, JSON.stringify(notified));

    if (typeof Notification !== 'undefined') {
      const fire = () => new Notification('🎯 Sell target hit', {
        body: fresh.map(h => `${h.ticker}: $${h.currentPrice.toFixed(2)} ≥ target $${h.target_price}`).join('\n'),
      });
      if (Notification.permission === 'granted') fire();
      else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => { if (p === 'granted') fire(); });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetHits.map(h => h.ticker).join(',')]);

  // Earnings dates cached by the Portfolio Review run
  let earningsDates: Record<string, string> = {};
  try { earningsDates = JSON.parse(localStorage.getItem(EARNINGS_CACHE_KEY) ?? '{}'); } catch { /* none */ }
  const daysToEarnings = (ticker: string): number | null => {
    const d = earningsDates[ticker];
    if (!d) return null;
    const days = Math.ceil((new Date(d + 'T00:00:00').getTime() - Date.now()) / 86400000);
    return days >= 0 ? days : null;
  };

  // Allocation % relative to TOTAL portfolio in CAD (all accounts)
  const totalPortfolioCAD = enriched.reduce((s, h) => s + h.cadMarketValue, 0);

  const withAlloc = enriched.map((h) => ({
    ...h,
    allocationPct: totalPortfolioCAD > 0 ? (h.cadMarketValue / totalPortfolioCAD) * 100 : 0,
  }));

  // Filter by account
  const baseFiltered = filterAccount === 'ALL' ? withAlloc : withAlloc.filter((h) => h.account === filterAccount);

  // Sort
  // Derived sort keys read from the engine row; missing data sorts last.
  const DERIVED_SORTS: Record<string, (r: typeof baseFiltered[number]) => number> = {
    pnlPct:          (r) => r.pnlPct ?? -9e9,
    targetRemaining: (r) => r._e.targetRemainingPct ?? 9e9,   // closest to target first when asc
    sectorPressure:  (r) => r._e.sectorEtf ? (sectorMetricsMap.get(r._e.sectorEtf)?.pressure ?? -9e9) : -9e9,
    rsVsSector:      (r) => r._e.rsVsSector1M ?? -9e9,
    ret1M:           (r) => r._e.ret1M ?? -9e9,
    ret3M:           (r) => r._e.ret3M ?? -9e9,
    changePct:       (r) => r.changePct ?? -9e9,
  };

  const filtered = sortKey
    ? [...baseFiltered].sort((a, b) => {
        let cmp = 0;
        const derive = DERIVED_SORTS[sortKey];
        if (derive) {
          cmp = derive(a) - derive(b);
        } else {
          const aVal = a[sortKey as keyof typeof a];
          const bVal = b[sortKey as keyof typeof b];
          if (typeof aVal === 'string' && typeof bVal === 'string') {
            cmp = aVal.localeCompare(bVal);
          } else {
            cmp = (aVal as number) - (bVal as number);
          }
        }
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : baseFiltered;

  // Summary stats scoped to the filtered (account) view — always in CAD
  const summaryValueCAD = filtered.reduce((s, h) => s + h.cadMarketValue, 0);
  const summaryCostCAD  = filtered.reduce((s, h) => s + h.cadCostBasis, 0);
  const summaryPnLCAD   = summaryValueCAD - summaryCostCAD;
  const summaryPnLPct   = summaryCostCAD > 0 ? (summaryPnLCAD / summaryCostCAD) * 100 : 0;

  // Daily change — computed by the engine strictly from previous-day closes
  const filteredEngine = filtered
    .map((h) => engineByTicker.get(h.ticker))
    .filter((r): r is EnrichedHolding => !!r);
  const totals = computeTotals(filteredEngine);
  const dailyChangeCAD = totals.dailyPnlCAD ?? 0;
  const dailyChangePct = totals.dailyPct ?? 0;
  const hasDailyData   = totals.dailyPnlCAD != null;


  // Account breakdown (all accounts, CAD)
  const accountMap: Record<string, number> = {};
  withAlloc.forEach((h) => {
    accountMap[h.account] = (accountMap[h.account] ?? 0) + h.cadMarketValue;
  });

  // Sector allocation — ETFs bucketed honestly, totals to 100%
  const allocation = computeAllocation(filteredEngine);
  const pieData = allocation.map((a) => ({ name: a.label, value: +a.weightPct.toFixed(1) }));

  const concentration = computeConcentration(filteredEngine, allocation);
  const concentrationRisk = concentration.level;
  const rotationExposure = computeRotationExposure(filteredEngine, sectorMetricsMap);

  // Reconciliation diagnostics (surfaced, never silently hidden)
  const diagnostics = validateTotals(filteredEngine, totals, allocation, accountTotalsOf(filteredEngine));

  // Real historical return correlation
  const tickers = withAlloc.map((h) => h.ticker);
  const corrMatrix = useMemo(
    () => computeCorrelationMatrix(tickers, closesByTicker, corrDays),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tickers.join(','), closesByTicker, corrDays]);
  const avgCorr = averageCorrelation(corrMatrix);

  function corrColor(v: number | null): string {
    if (v == null) return 'bg-zinc-800';
    if (v >= 0.9) return 'bg-red-700';
    if (v >= 0.7) return 'bg-red-600/60';
    if (v >= 0.5) return 'bg-amber-600/60';
    if (v >= 0.3) return 'bg-zinc-600';
    if (v >= -0.3) return 'bg-zinc-700/50';
    return 'bg-blue-700/50';
  }

  const uniqueAccounts = [...new Set(holdings.map((h) => h.account))];
  const accountLabel = filterAccount === 'ALL' ? 'All Accounts' : filterAccount;

  return (
    <div className="space-y-6">
      {/* Sell-target hit banner */}
      {targetHits.length > 0 && (
        <div className="bg-emerald-950/50 border border-emerald-700/50 rounded-xl p-4 flex items-start gap-3">
          <Target size={16} className="text-emerald-400 mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-semibold text-emerald-300">
              🎯 {targetHits.length === 1 ? 'Sell target hit' : `${targetHits.length} sell targets hit`}
            </div>
            <div className="text-xs text-emerald-400/80 mt-1 space-y-0.5">
              {targetHits.map(h => (
                <div key={h.id}>
                  <span className="font-mono font-bold">{h.ticker}</span>
                  {' '}({h.account}) — ${h.currentPrice.toFixed(2)} is at/above your ${h.target_price!.toFixed(2)} target
                  {' '}· consider taking profits
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Row 1 — core position fields */}
          <div className="flex flex-wrap gap-3 items-end">
            <div className="w-20"><label className="label">Ticker *</label><input className="input-base uppercase" placeholder="AAPL" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} required /></div>
            <div className="w-24"><label className="label">Shares *</label><input className="input-base" type="number" step="0.001" placeholder="100" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} required /></div>
            <div className="w-28"><label className="label">Avg Cost *</label><input className="input-base" type="number" step="0.0001" placeholder="150.00" value={form.avg_cost} onChange={(e) => setForm({ ...form, avg_cost: e.target.value })} required /></div>
            <div className="w-28">
              <label className="label flex items-center gap-1"><Target size={11} className="text-amber-400" /> Sell Target</label>
              <input className="input-base" type="number" step="0.01" placeholder="200.00" value={form.target_price} onChange={(e) => setForm({ ...form, target_price: e.target.value })} />
            </div>
            <DatePicker label="Purchase Date" value={form.purchase_date} onChange={(v) => setForm({ ...form, purchase_date: v })} />
            <DatePicker label="Sell Date"     value={form.sell_date}     onChange={(v) => setForm({ ...form, sell_date: v })} />
          </div>
          {/* Row 2 — classification + notes + submit */}
          <div className="flex flex-wrap gap-3 items-end">
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
            <div className="flex-1 min-w-[7rem]"><label className="label">Notes</label><input className="input-base" placeholder="Notes..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <button type="submit" className="btn-primary flex items-center gap-2 self-end" disabled={loading}>
              {editId ? <Check size={14} /> : <Plus size={14} />}
              {loading ? 'Saving...' : editId ? 'Update' : 'Add'}
            </button>
          </div>
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
            <div className={`card py-3 ${!hasDailyData ? '' : dailyChangeCAD >= 0 ? 'border-emerald-900' : 'border-red-900'}`}>
              <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                Today's Change
                <span className="text-zinc-600 cursor-help" title={
                  "Today's Change\n\nCalculated from each holding's latest market price versus its previous trading-day close. " +
                  "USD holdings are converted to CAD for the portfolio total.\n\n" +
                  "Average cost and book value are never used. Holdings without a reliable previous close are excluded and shown as N/A."
                }>ⓘ</span>
              </div>
              {hasDailyData ? (
                <>
                  <div className={`text-xl font-bold ${dailyChangeCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {dailyChangePct >= 0 ? '+' : ''}{dailyChangePct.toFixed(2)}%
                  </div>
                  <div className={`text-xs tabular-nums mt-0.5 ${dailyChangeCAD >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {dailyChangeCAD >= 0 ? '+' : ''}{fmtCAD(dailyChangeCAD)}
                  </div>
                </>
              ) : (
                <div className="text-xl font-bold text-zinc-600">—</div>
              )}
              <div className="text-xs text-zinc-700 mt-1">
                vs. prev close
                {totals.dailyCoverage.counted < totals.dailyCoverage.total && (
                  <span className="text-amber-600/80"> · {totals.dailyCoverage.counted}/{totals.dailyCoverage.total} priced</span>
                )}
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

          {/* Portfolio context strip */}
          <div className="card py-2.5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="text-zinc-500">Rotation Exposure</span>
                <span title={ROTATION_EXPOSURE_HELP} className="text-zinc-600 cursor-help">ⓘ</span>
                {rotationExposure.value != null ? (
                  <>
                    <span className={`font-bold tabular-nums ${
                      rotationExposure.value >= 22 ? 'text-emerald-400'
                      : rotationExposure.value <= -22 ? 'text-red-400' : 'text-zinc-300'}`}>
                      {rotationExposure.value >= 0 ? '+' : ''}{rotationExposure.value}
                    </span>
                    <span className="text-zinc-500">{rotationExposure.label}</span>
                    <span className="text-zinc-700">({fmt(rotationExposure.classifiedPct, 0)}% classifiable)</span>
                  </>
                ) : <span className="text-zinc-600">N/A</span>}
              </span>
              {concentration.largestStock && (
                <span className="text-zinc-500">
                  Largest stock <span className="text-zinc-200 font-medium">{concentration.largestStock.ticker} {fmt(concentration.largestStock.pct, 1)}%</span>
                </span>
              )}
              {concentration.largestSector && (
                <span className="text-zinc-500">
                  Largest sector <span className="text-zinc-200 font-medium">{concentration.largestSector.label} {fmt(concentration.largestSector.pct, 1)}%</span>
                </span>
              )}
              <span className="text-zinc-500">
                Broad-Market ETF <span className="text-zinc-200 font-medium">{fmt(concentration.broadEtfPct, 1)}%</span>
              </span>
              {concentration.growthEtfPct > 0 && (
                <span className="text-zinc-500" title="Nasdaq-100 / large-cap growth funds — concentrated, so only partial diversification credit">
                  Growth / Nasdaq ETF <span className="text-zinc-200 font-medium">{fmt(concentration.growthEtfPct, 1)}%</span>
                </span>
              )}
              <button onClick={() => setShowSectorAudit(v => !v)}
                className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 decoration-dotted">
                Sector audit
              </button>
              <span className="ml-auto flex items-center gap-3 text-zinc-600">
                {pricesUpdatedAt && <span>Prices {pricesUpdatedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</span>}
                {fxUpdatedAt && <span>FX {fxUpdatedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</span>}
                {ctxLoading && <span className="flex items-center gap-1"><RefreshCw size={10} className="animate-spin" /> context…</span>}
              </span>
            </div>
            {diagnostics.length > 0 && (
              <div className="mt-2 pt-2 border-t border-amber-900/40 text-xs text-amber-400 space-y-0.5">
                {diagnostics.map((d, i) => (
                  <div key={i}>⚠ {d.label}: expected {fmtCAD(d.expected)}, got {fmtCAD(d.actual)} (diff {fmtCAD(d.diff)})</div>
                ))}
              </div>
            )}

            {/* Sector audit — review before changing anything */}
            {showSectorAudit && (
              <div className="mt-3 pt-3 border-t border-zinc-800">
                <div className="text-xs text-zinc-400 mb-2">
                  Provider classification is used automatically. Pin a sector only if you disagree with it.
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-500 border-b border-zinc-800">
                        <th className="th text-left">Ticker</th>
                        <th className="th text-left">In use</th>
                        <th className="th text-left">Provider</th>
                        <th className="th text-left">Saved on holding</th>
                        <th className="th text-left">Source</th>
                        <th className="th" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60">
                      {engineRows.map((e) => {
                        const providerEtf = detectedSectors[e.ticker.toUpperCase()] ?? null;
                        const providerName = providerEtf ? SECTOR_NAME_BY_ETF[providerEtf] ?? providerEtf : null;
                        const pinned = sectorOverrides[e.ticker.toUpperCase()];
                        return (
                          <tr key={e.ticker} className="tr-hover">
                            <td className="td font-mono text-blue-400">{e.ticker}</td>
                            <td className="td text-zinc-200">{e.sectorLabel}</td>
                            <td className="td text-zinc-400">{e.isEtf ? <span className="text-zinc-600">n/a (fund)</span> : providerName ?? <span className="text-zinc-600">unavailable</span>}</td>
                            <td className={`td ${e.staleStoredSector ? 'text-amber-500' : 'text-zinc-600'}`}>{e.h.sector || '—'}</td>
                            <td className="td text-zinc-500">
                              {e.isEtf ? 'fund registry' : pinned ? 'pinned by you' : providerName ? 'provider' : 'saved value'}
                            </td>
                            <td className="td text-right whitespace-nowrap">
                              {!e.isEtf && providerName && (
                                pinned ? (
                                  <button onClick={() => setSectorOverrides(clearSectorOverride(e.ticker))}
                                    className="text-xs text-blue-400 hover:text-blue-300">Use provider</button>
                                ) : (
                                  <select
                                    className="select-base text-xs w-40"
                                    value=""
                                    onChange={(ev) => { if (ev.target.value) setSectorOverrides(setSectorOverride(e.ticker, ev.target.value)); }}
                                  >
                                    <option value="">Pin sector…</option>
                                    {Object.values(SECTOR_NAME_BY_ETF).map((n) => <option key={n} value={n}>{n}</option>)}
                                  </select>
                                )
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
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

            <div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800">
                    {([
                      { label: 'Ticker / Sector', key: 'ticker'        },
                      { label: 'Account',          key: 'account'       },
                      { label: 'Qty / Avg Cost',   key: 'shares'        },
                      { label: 'Price / Day %',    key: 'currentPrice'  },
                      { label: 'Book → Mkt',       key: 'marketValue'   },
                      { label: 'P&L',              key: 'pnl'           },
                      { label: 'Sector / Rotation', key: 'sectorPressure' },
                      { label: 'vs Sector 1M',     key: 'rsVsSector'    },
                      { label: 'To Target',        key: 'targetRemaining' },
                      { label: 'Alloc',            key: 'allocationPct' },
                    ] as { label: string; key: SortKey }[]).map(({ label, key }) => (
                      <th key={key} className="th">
                        <button onClick={() => handleSort(key)} className="flex items-center gap-1 hover:text-zinc-100 transition-colors group whitespace-nowrap">
                          {label}
                          <span className="text-zinc-600 group-hover:text-zinc-400">
                            {sortKey === key ? (sortDir === 'asc' ? <ChevronUp size={11} className="text-blue-400" /> : <ChevronDown size={11} className="text-blue-400" />) : <ChevronsUpDown size={11} />}
                          </span>
                        </button>
                      </th>
                    ))}
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {filtered.map((h) => (
                    <tr key={h.id} className={`tr-hover ${h.target_price != null && h.currentPrice >= h.target_price ? 'bg-emerald-950/40 border-l-2 border-l-emerald-500' : ''}`}>

                      {/* Ticker + sector + dates */}
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => setSelectedTicker({ ticker: h.ticker, currency: h.currency })}
                            className="font-mono font-bold text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 flex items-center gap-1 group">
                            {h.ticker}<ExternalLink size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                          </button>
                          {(() => {
                            const d = daysToEarnings(h.ticker);
                            if (d == null || d > 14) return null;
                            return (
                              <span
                                title={`Earnings ${earningsDates[h.ticker]}`}
                                className={`text-[10px] px-1 py-0.5 rounded font-medium ${d <= 7 ? 'bg-amber-900/50 text-amber-300 border border-amber-700/50' : 'bg-zinc-800 text-zinc-400'}`}
                              >
                                ⚠ ER {d === 0 ? 'today' : `${d}d`}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="text-zinc-600 leading-tight">{h.sector}</div>
                        <div className="text-zinc-400 leading-tight tabular-nums mt-0.5">
                          📅 {h.purchase_date ?? '—'}{h.sell_date ? ` → ${h.sell_date}` : ''}
                        </div>
                      </td>

                      {/* Account + currency */}
                      <td className="td">
                        <span className={`font-semibold ${accountColors[h.account]}`}>{h.account}</span>
                        <div className="text-zinc-600">{h.currency}</div>
                      </td>

                      {/* Qty + avg cost */}
                      <td className="td tabular-nums text-right">
                        <div>{fmt(h.shares, 0)} sh</div>
                        <div className="text-zinc-500">{fmtCurrency(h.avg_cost)}</div>
                      </td>

                      {/* Current price (editable) + day % */}
                      <td className="td tabular-nums text-right">
                        {editingPrice === h.ticker ? (
                          <div className="flex items-center gap-1 justify-end">
                            <input ref={priceInputRef} type="number" step="0.0001"
                              className="w-20 bg-zinc-700 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-zinc-100 tabular-nums focus:outline-none"
                              value={priceInput} onChange={(e) => setPriceInput(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') commitPrice(h.ticker); if (e.key === 'Escape') setEditingPrice(null); }} />
                            <button onClick={() => commitPrice(h.ticker)} className="text-emerald-400 p-0.5"><Check size={12} /></button>
                            <button onClick={() => setEditingPrice(null)} className="text-zinc-500 p-0.5"><X size={12} /></button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => startEditPrice(h.ticker, h.currentPrice)}
                              className="group flex items-center gap-0.5 hover:text-blue-300 transition-colors"
                              title={h.priceSource === 'cost' ? 'No live price — click to set manually' : 'Click to override'}>
                              <span className={h.priceSource === 'cost' ? 'text-zinc-600' : ''}>{fmtCurrency(h.currentPrice)}</span>
                              <Pencil size={9} className="opacity-0 group-hover:opacity-60 text-zinc-400 transition-opacity" />
                            </button>
                            {h.priceSource === 'manual' && (
                              <button onClick={() => clearManualPrice(h.ticker)}
                                className="text-[10px] font-bold text-amber-500 hover:text-white hover:bg-amber-600 px-1 rounded transition-colors leading-none py-0.5"
                                title="Manual — click to restore auto">M×</button>
                            )}
                          </div>
                        )}
                        <div
                          className={`${h.changePct == null ? 'text-zinc-600' : h.changePct > 0 ? 'text-emerald-400' : h.changePct < 0 ? 'text-red-400' : 'text-zinc-500'}`}
                          title={h.changePct == null
                            ? (h._e.currentPrice == null ? 'Price unavailable' : 'Previous close unavailable — daily move cannot be calculated')
                            : `Change vs previous close ${fmtCurrency(h._e.prevClose ?? 0)}${h._e.dailyFromManualPrice ? ' (using your manual price)' : ''}`}
                        >
                          {h.changePct == null ? '—' : fmtPct(h.changePct)}
                          {h._e.dailyFromManualPrice && <span className="text-amber-500 ml-0.5">M</span>}
                        </div>
                        {h.target_price != null && (() => {
                          const upsidePct = h.currentPrice > 0 ? ((h.target_price - h.currentPrice) / h.currentPrice) * 100 : 0;
                          const hit = h.currentPrice >= h.target_price;
                          return (
                            <div className="flex items-center gap-1 mt-0.5">
                              <Target size={9} className={hit ? 'text-emerald-400' : 'text-amber-500'} />
                              <span className="text-amber-400 tabular-nums">{fmtCurrency(h.target_price)}</span>
                              <span className={`text-[10px] ${upsidePct >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                                {upsidePct >= 0 ? '+' : ''}{upsidePct.toFixed(1)}%
                              </span>
                              {hit && <span className="text-[10px] font-bold text-emerald-400">✓HIT</span>}
                            </div>
                          );
                        })()}
                      </td>

                      {/* Book → Market value */}
                      <td className="td tabular-nums text-right">
                        <div className="text-zinc-500">{fmtCurrency(h.costBasis)}</div>
                        <div className="font-medium">{fmtCurrency(h.marketValue)} <span className="text-zinc-600">{h.currency}</span></div>
                      </td>

                      {/* P&L */}
                      <td className={`td tabular-nums text-right font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        <div>{h.pnl >= 0 ? '+' : ''}{fmtCurrency(h.pnl)}</div>
                        <div className="font-normal">{fmtPct(h.pnlPct)}</div>
                        <div className="font-normal text-zinc-600 text-[10px]" title="1-month and 3-month price return">
                          {h._e.ret1M != null ? `1M ${h._e.ret1M >= 0 ? '+' : ''}${(h._e.ret1M * 100).toFixed(1)}%` : ''}
                          {h._e.ret3M != null ? ` · 3M ${h._e.ret3M >= 0 ? '+' : ''}${(h._e.ret3M * 100).toFixed(1)}%` : ''}
                        </div>
                      </td>

                      {/* Sector + rotation pressure */}
                      <td className="td">
                        {(() => {
                          const e = h._e;
                          const sm = e.sectorEtf ? sectorMetricsMap.get(e.sectorEtf) : null;
                          return (
                            <div className="leading-tight">
                              <div className="flex items-center gap-1">
                                {e.sectorEtf ? (
                                  <button onClick={() => navigateTo('sectors', { sector: e.sectorEtf! })}
                                    title={`Open ${e.sectorEtf} in Sector Rotation`}
                                    className="text-zinc-300 hover:text-blue-300 hover:underline underline-offset-2 truncate max-w-[120px]">
                                    {e.sectorLabel}
                                  </button>
                                ) : (
                                  <span className={e.sectorLabel === UNCLASSIFIED_LABEL ? 'text-zinc-600' : 'text-zinc-400'}>{e.sectorLabel}</span>
                                )}
                                {e.sectorIsManual && (
                                  <button
                                    onClick={() => setSectorOverrides(clearSectorOverride(h.ticker))}
                                    className="text-[9px] text-amber-500 font-bold hover:text-white hover:bg-amber-600 px-0.5 rounded"
                                    title="Manual sector override — click to use the provider's sector">M×</button>
                                )}
                                {e.staleStoredSector && (
                                  <span className="text-[9px] text-zinc-600" title={`Saved as "${e.staleStoredSector}" — now using the provider's classification`}>⟲</span>
                                )}
                              </div>
                              {sm ? (
                                <div title={describePressure(sm.pressure, sm.pressureDelta.d5)}
                                  className={`tabular-nums ${sm.pressure >= 22 ? 'text-emerald-400' : sm.pressure <= -22 ? 'text-red-400' : 'text-zinc-500'}`}>
                                  {sm.pressure >= 0 ? '+' : ''}{sm.pressure}{' '}
                                  {sm.trendArrow === 'up' ? '↑' : sm.trendArrow === 'down' ? '↓' : '→'}
                                  <span className="text-zinc-600 ml-1">{sm.classification}</span>
                                </div>
                              ) : (
                                <div className="text-zinc-700" title={e.isEtf ? 'Diversified funds have no single sector pressure' : PRESSURE_HELP}>—</div>
                              )}
                              <div className={`text-[10px] font-semibold ${HOLDING_STATUS_STYLE[e.status]}`}
                                title={e.statusReasons.length > 0 ? e.statusReasons.join('\n') : 'No notable conditions'}>
                                {e.status}
                              </div>
                            </div>
                          );
                        })()}
                      </td>

                      {/* Stock vs sector (1M) */}
                      <td className={`td tabular-nums text-right ${
                        h._e.rsVsSector1M == null ? 'text-zinc-600'
                        : h._e.rsVsSector1M >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                        title={h._e.rsVsSector1M == null
                          ? 'Needs both stock and sector 1-month returns'
                          : `Stock 1M ${(h._e.ret1M! * 100).toFixed(1)}% vs sector ${(((h._e.ret1M! - h._e.rsVsSector1M)) * 100).toFixed(1)}%`}>
                        {h._e.rsVsSector1M == null ? 'N/A'
                          : `${h._e.rsVsSector1M >= 0 ? '+' : ''}${(h._e.rsVsSector1M * 100).toFixed(1)}%`}
                      </td>

                      {/* Distance to sell target */}
                      <td className="td tabular-nums text-right">
                        {h._e.targetRemainingPct == null ? (
                          <span className="text-zinc-600">—</span>
                        ) : h._e.targetStale ? (
                          <span className="text-zinc-500" title={`Price is far past the $${h.target_price} target — consider updating it`}>stale</span>
                        ) : (
                          <>
                            <div className={h._e.targetReached ? 'text-emerald-400 font-semibold' : h._e.nearTarget ? 'text-amber-400 font-semibold' : 'text-zinc-300'}>
                              {h._e.targetRemainingPct >= 0 ? '+' : ''}{h._e.targetRemainingPct.toFixed(1)}%
                            </div>
                            {(h._e.targetReached || h._e.nearTarget) && (
                              <div className={`text-[10px] font-bold ${h._e.targetReached ? 'text-emerald-500' : 'text-amber-500'}`}>
                                {h._e.targetReached ? 'AT TARGET' : 'NEAR TARGET'}
                              </div>
                            )}
                          </>
                        )}
                      </td>

                      {/* Alloc % */}
                      <td className="td">
                        <div className="flex items-center gap-1.5 justify-end">
                          <div className="w-10 bg-zinc-700 rounded-full h-1.5 flex-shrink-0">
                            <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(h.allocationPct, 100)}%` }} />
                          </div>
                          <span className="tabular-nums">{fmt(h.allocationPct, 1)}%</span>
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="td">
                        {sellId === h.id ? (
                          <div className="flex flex-col gap-1 min-w-0">
                            <div className="flex gap-1">
                              <input type="number" step="0.0001" placeholder="Exit $" value={sellForm.exitPrice}
                                onChange={(e) => setSellForm({ ...sellForm, exitPrice: e.target.value })}
                                className="w-20 bg-zinc-700 border border-amber-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none" />
                              <input type="number" step="0.001" placeholder={`Qty`} value={sellForm.qtySold}
                                onChange={(e) => setSellForm({ ...sellForm, qtySold: e.target.value })}
                                className="w-16 bg-zinc-700 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none" />
                            </div>
                            <div className="flex gap-1 items-center">
                              <input type="date" value={sellForm.dateSold}
                                onChange={(e) => setSellForm({ ...sellForm, dateSold: e.target.value })}
                                className="w-28 bg-zinc-700 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none" />
                              <button onClick={() => handleSell(h)} disabled={sellLoading} className="btn-primary text-xs px-2 py-1 flex items-center gap-1">
                                <Check size={11} />{sellLoading ? '…' : 'Sell'}
                              </button>
                              <button onClick={() => setSellId(null)} className="btn-ghost p-1"><X size={11} /></button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => { setSellId(h.id); setSellForm({ exitPrice: h.currentPrice.toFixed(2), qtySold: h.shares.toString(), dateSold: new Date().toISOString().split('T')[0] }); }}
                              className="text-xs px-2 py-1 rounded border border-amber-700 text-amber-400 hover:bg-amber-900/30 transition-colors font-medium">
                              Sell
                            </button>
                            <button onClick={() => startEdit(h)} className="btn-ghost p-1" title="Edit"><Edit2 size={12} /></button>
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
                    { label: 'Largest position', value: concentration.largestPosition ? `${concentration.largestPosition.ticker} ${fmt(concentration.largestPosition.pct, 1)}%` : 'N/A' },
                    { label: 'Largest individual stock', value: concentration.largestStock ? `${concentration.largestStock.ticker} ${fmt(concentration.largestStock.pct, 1)}%` : 'N/A' },
                    { label: 'Largest broad-market ETF', value: concentration.largestBroadEtf ? `${concentration.largestBroadEtf.ticker} ${fmt(concentration.largestBroadEtf.pct, 1)}%` : 'N/A' },
                    { label: 'Largest growth/Nasdaq ETF', value: concentration.largestGrowthEtf ? `${concentration.largestGrowthEtf.ticker} ${fmt(concentration.largestGrowthEtf.pct, 1)}%` : 'N/A' },
                    { label: 'Top 3 individual stocks', value: concentration.top3StocksPct != null ? `${fmt(concentration.top3StocksPct, 1)}%` : 'N/A' },
                    { label: 'Top 5 holdings', value: concentration.top5Pct != null ? `${fmt(concentration.top5Pct, 1)}%` : 'N/A' },
                    { label: 'Largest sector', value: concentration.largestSector ? `${concentration.largestSector.label} ${fmt(concentration.largestSector.pct, 1)}%` : 'N/A' },
                    { label: 'Broad-market ETF %', value: `${fmt(concentration.broadEtfPct, 1)}%` },
                    { label: 'Growth / Nasdaq ETF %', value: `${fmt(concentration.growthEtfPct, 1)}%` },
                    { label: 'Concentration Risk', value: concentrationRisk, colored: true },
                    { label: 'Holdings shown', value: `${filtered.length}` },
                  ].map(({ label, value, colored }) => (
                    <div key={label} className="flex justify-between text-sm">
                      <span className="text-zinc-400">{label}</span>
                      {colored ? (
                        <span className={`font-semibold px-2 py-0.5 rounded text-xs ${
                          value === 'LOW' ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700'
                          : value === 'MODERATE' ? 'bg-amber-900/40 text-amber-300 border border-amber-700'
                          : 'bg-red-900/40 text-red-300 border border-red-700'}`}>{value}</span>
                      ) : (
                        <span className="font-medium text-right">{value}</span>
                      )}
                    </div>
                  ))}
                </div>
                {concentration.reasons.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-zinc-800 text-xs text-zinc-500 space-y-0.5">
                    <div className="text-zinc-600">Why {concentrationRisk}:</div>
                    {concentration.reasons.map((r, i) => <div key={i}>• {r}</div>)}
                    <div className="text-zinc-600 pt-1">
                      Broad-market funds count as genuine diversification. Growth / Nasdaq funds get partial credit only —
                      they concentrate in large-cap tech and overlap with individual holdings.
                    </div>
                  </div>
                )}
                <div className="mt-3 space-y-1">
                  {[...filtered].sort((a, b) => b.allocationPct - a.allocationPct).slice(0, 8).map((h) => (
                    <div key={h.id} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-blue-400 w-14 flex-shrink-0">{h.ticker}</span>
                      <div className="flex-1 bg-zinc-700 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full ${
                          h._e.isEtf ? 'bg-blue-500'
                          : h.allocationPct > 30 ? 'bg-red-500'
                          : h.allocationPct > 15 ? 'bg-amber-500' : 'bg-zinc-500'}`}
                          style={{ width: `${Math.min(h.allocationPct, 100)}%` }} />
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
                    {corrDays}-day daily return correlation
                    {avgCorr != null && <> · average pair <span className="text-zinc-400 font-mono">{avgCorr.toFixed(2)}</span></>}
                    {ctxLoading && <span className="ml-2 text-zinc-600">loading history…</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Timeframe */}
                  <div className="flex gap-1">
                    {CORRELATION_SETTINGS.options.map((d) => (
                      <button key={d} onClick={() => setCorrDays(d)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                          corrDays === d ? 'bg-blue-900/50 text-blue-300 border-blue-600'
                            : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
                        {d === 252 ? '1Y' : `${d}D`}
                      </button>
                    ))}
                  </div>
                  {/* Legend */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {[
                      { bg: 'bg-red-700',      label: '0.9–1.0', tip: 'Move almost identically' },
                      { bg: 'bg-red-600/60',   label: '0.7–0.9', tip: 'Strongly move together' },
                      { bg: 'bg-amber-600/60', label: '0.5–0.7', tip: 'Moderately move together' },
                      { bg: 'bg-zinc-600',     label: '0.3–0.5', tip: 'Weak relationship' },
                      { bg: 'bg-zinc-700/50',  label: '−0.3–0.3', tip: 'Little linear relationship' },
                      { bg: 'bg-blue-700/50',  label: '< −0.3',  tip: 'Tend to move opposite' },
                    ].map(({ bg, label, tip }) => (
                      <div key={label} className="flex items-center gap-1" title={tip}>
                        <div className={`w-4 h-4 rounded ${bg}`} />
                        <span className="text-xs text-zinc-500">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-3 p-3 bg-zinc-900/50 rounded-lg border border-zinc-800 text-xs text-zinc-500 mb-4 space-y-1">
                <div><span className="text-zinc-300 font-medium">How to read it:</span> Pearson correlation of actual daily returns over the selected window.</div>
                <div>
                  <span className="text-red-400 font-mono">1.00</span> = tends to move together ·
                  <span className="text-zinc-300 font-mono"> 0.00</span> = little relationship ·
                  <span className="text-blue-400 font-mono"> −1.00</span> = tends to move opposite.
                  Higher values mean less diversification benefit.
                </div>
                {corrMatrix.unavailable.length > 0 && (
                  <div className="text-zinc-600">
                    Insufficient price history for: {corrMatrix.unavailable.join(', ')} — shown as N/A.
                  </div>
                )}
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
                          const v = corrMatrix.get(rowT, colT);
                          const obs = corrMatrix.observations(rowT, colT);
                          return (
                            <td key={colT} className="p-0.5">
                              <div
                                className={`w-9 h-9 rounded flex items-center justify-center font-semibold text-white/80 text-xs ${corrColor(v)}`}
                                title={v == null
                                  ? `${rowT} ↔ ${colT}: insufficient overlapping price history`
                                  : `${rowT} ↔ ${colT}: ${v.toFixed(2)} (${rowT === colT ? 'same security' : `${obs} daily observations`})`}
                              >
                                {v == null ? <span className="text-zinc-600 text-[10px]">N/A</span> : v.toFixed(2)}
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
