import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus, ShoppingCart, X, Check, Edit2,
  LineChart, ArrowLeftRight, CheckCheck, AlertTriangle, Calendar, ArrowUp, ArrowDown, ArrowRight,
} from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import FundamentalsDrawer from '../FundamentalsDrawer';
import { toYahooTicker } from '../FundamentalsDrawer';
import { changeColor, fmtCurrency, fmtPct } from '../../lib/utils';
import { navigateTo } from '../../lib/navigation';
import { loadWatchMeta, setWatchMeta, markReviewed, removeWatchMeta } from '../../lib/watch/watchMeta';
import type { WatchMeta } from '../../lib/watch/watchMeta';
import { resolveSectors, fetchWatchReturns } from '../../lib/watch/watchSectorContext';
import type { StockReturns } from '../../lib/watch/watchSectorContext';
import { buildWatchRow, summarize, needsAttention, getMarket } from '../../lib/watch/watchEngine';
import type { WatchRow } from '../../lib/watch/watchEngine';
import { STATUS_STYLE, ALIGNMENT_STYLE, WATCH_THRESHOLDS } from '../../config/watchConfig';
import type { WatchStatus } from '../../config/watchConfig';
import { fetchAllHistories, fetchConstituentQuotes, fetchConstituentHistories } from '../../lib/sector/sectorData';
import { computeSectorMetrics } from '../../lib/sector/sectorEngine';
import type { SectorMetrics } from '../../lib/sector/sectorEngine';
import type { WatchItem, FinnhubQuote, Conviction } from '../../types';

const HOLDINGS_TABLE = 'holdings';
const TABLE = 'watch_items';

interface LiveData {
  quote?: FinnhubQuote;
  loading: boolean;
  error?: string;
}

const CONVICTION_ORDER: Conviction[] = ['HIGH', 'MEDIUM', 'LOW'];

const convictionBg: Record<Conviction, string> = {
  HIGH:   'bg-emerald-900/40 text-emerald-300 border border-emerald-700',
  MEDIUM: 'bg-amber-900/40 text-amber-300 border border-amber-700',
  LOW:    'bg-zinc-800 text-zinc-400 border border-zinc-700',
};

type SortKey =
  | 'actionable' | 'closest' | 'conviction' | 'sectorPressure' | 'relStrength'
  | 'upside' | 'newest' | 'oldest' | 'review' | 'alpha';

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'actionable',     label: 'Actionable' },
  { key: 'closest',        label: 'Closest to Entry' },
  { key: 'conviction',     label: 'Conviction' },
  { key: 'sectorPressure', label: 'Sector Pressure' },
  { key: 'relStrength',    label: 'Rel. Strength' },
  { key: 'upside',         label: 'Upside' },
  { key: 'review',         label: 'Needs Review' },
  { key: 'newest',         label: 'Newest' },
  { key: 'oldest',         label: 'Oldest' },
  { key: 'alpha',          label: 'A → Z' },
];

const STATUS_FILTERS: WatchStatus[] = ['ACTIONABLE', 'NEAR ENTRY', 'WATCH', 'EXTENDED', 'REVIEW'];

function pctColor(x: number | null | undefined): string {
  return x == null ? 'text-zinc-600' : x >= 0 ? 'text-emerald-400' : 'text-red-400';
}
const signedPct = (x: number | null | undefined, d = 2): string =>
  x == null ? 'N/A' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;

/** Compact labelled metric used across the card's stat strip. */
function Stat({ label, value, cls, title }: { label: string; value: React.ReactNode; cls?: string; title?: string }) {
  return (
    <div className="min-w-[68px]" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
      <div className={`text-sm font-semibold tabular-nums leading-tight ${cls ?? 'text-zinc-200'}`}>{value}</div>
    </div>
  );
}

function TrendArrow({ v }: { v: number | null }) {
  if (v == null) return <ArrowRight size={11} className="text-zinc-600" />;
  if (v > 0) return <ArrowUp size={11} className="text-emerald-400" />;
  if (v < 0) return <ArrowDown size={11} className="text-red-400" />;
  return <ArrowRight size={11} className="text-zinc-500" />;
}

export default function WatchList() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [liveData, setLiveData] = useState<Record<string, LiveData>>({});
  const [meta, setMeta] = useState<Record<string, WatchMeta>>(loadWatchMeta);

  // Sector context (loaded progressively — never blocks the list)
  const [sectorMetrics, setSectorMetrics] = useState<Map<string, SectorMetrics>>(new Map());
  const [sectorMap, setSectorMap] = useState<Record<string, string | null>>({});
  const [stockReturns, setStockReturns] = useState<Map<string, StockReturns>>(new Map());
  const [ctxLoading, setCtxLoading] = useState(false);

  // Add form
  const [ticker, setTicker] = useState('');
  const [conviction, setConviction] = useState<Conviction>('MEDIUM');
  const [notes, setNotes] = useState('');
  const [watchPrice, setWatchPrice] = useState('');
  const [watchDate, setWatchDate] = useState(new Date().toISOString().split('T')[0]);
  const [analystTarget, setAnalystTarget] = useState('');
  const [targetEntry, setTargetEntry] = useState('');
  const [catalystDate, setCatalystDate] = useState('');
  const [catalystNote, setCatalystNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [fetchingPrice, setFetchingPrice] = useState(false);

  // Filters / sorting
  const [sortBy, setSortBy] = useState<SortKey>('actionable');
  const [filterMarket, setFilterMarket] = useState<'ALL' | 'US' | 'TSX'>('ALL');
  const [filterZone, setFilterZone] = useState<'ALL' | 'BUY' | 'ABOVE'>('ALL');
  const [filterStatus, setFilterStatus] = useState<WatchStatus | 'ALL'>('ALL');
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [onlyHighConv, setOnlyHighConv] = useState(false);
  const [onlySectorUp, setOnlySectorUp] = useState(false);
  const [onlyPosRs, setOnlyPosRs] = useState(false);
  const [onlyCatalyst, setOnlyCatalyst] = useState(false);

  const [drawer, setDrawer] = useState<{ ticker: string; currency: string } | null>(null);
  const [showExposure, setShowExposure] = useState(false);

  // Buy inline form (unchanged behaviour)
  const [buyId, setBuyId] = useState<string | null>(null);
  const [buyShares, setBuyShares] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const [buyAccount, setBuyAccount] = useState('Brokerage');
  const [buyCurrency, setBuyCurrency] = useState('USD');
  const [buyLoading, setBuyLoading] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [buyDest, setBuyDest] = useState<'portfolio' | 'swing'>('portfolio');
  const [buyStop, setBuyStop] = useState('');
  const [buyTarget, setBuyTarget] = useState('');
  const [buySetup, setBuySetup] = useState('Breakout');

  // Edit inline form (existing fields + structured thesis fields)
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    watch_price: '', target_entry: '', analyst_target: '', conviction: 'MEDIUM' as Conviction, notes: '',
    thesis: '', trigger: '', catalyst: '', catalyst_date: '', thesis_broken: false,
  });

  function openEdit(item: WatchItem) {
    const m = meta[item.id] ?? {};
    setEditId(item.id);
    setEditForm({
      watch_price:    item.watch_price?.toString()    ?? '',
      target_entry:   item.target_entry?.toString()   ?? '',
      analyst_target: item.analyst_target?.toString() ?? '',
      conviction:     item.conviction,
      notes:          item.notes ?? '',
      thesis:         m.thesis ?? '',
      trigger:        m.trigger ?? '',
      catalyst:       m.catalyst ?? '',
      catalyst_date:  m.catalyst_date ?? '',
      thesis_broken:  m.thesis_broken ?? false,
    });
  }

  async function saveEdit(id: string) {
    await storage.update(TABLE, id, {
      watch_price:    editForm.watch_price    ? parseFloat(editForm.watch_price)    : null,
      target_entry:   editForm.target_entry   ? parseFloat(editForm.target_entry)   : null,
      analyst_target: editForm.analyst_target ? parseFloat(editForm.analyst_target) : null,
      conviction:     editForm.conviction,
      notes:          editForm.notes,
    });
    setMeta(setWatchMeta(id, {
      thesis:        editForm.thesis || undefined,
      trigger:       editForm.trigger || undefined,
      catalyst:      editForm.catalyst || undefined,
      catalyst_date: editForm.catalyst_date || undefined,
      thesis_broken: editForm.thesis_broken,
    }));
    setEditId(null);
    await load();
  }

  // Swing Trade helpers (unchanged)
  function sGet<T>(key: string, def: T): T {
    try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : def; } catch { return def; }
  }
  function sSet(key: string, val: unknown) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota */ }
  }
  function currentSprintWeek(): number {
    try {
      const s = sGet<{ sprint_start_date?: string }>('sprint_settings', {});
      if (!s.sprint_start_date) return 1;
      const diff = Date.now() - new Date(s.sprint_start_date).getTime();
      return Math.max(1, Math.ceil(diff / (7 * 24 * 3600 * 1000)));
    } catch { return 1; }
  }

  const load = useCallback(async () => {
    const data = await storage.getAll<WatchItem>(TABLE);
    setItems(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Priority 2: sector context loads AFTER the list renders ───────────────
  const tickerKey = items.map(i => i.ticker).sort().join(',');
  useEffect(() => {
    if (items.length === 0) return;
    let live = true;
    setCtxLoading(true);
    (async () => {
      try {
        const tickers = items.map(i => i.ticker.toUpperCase());
        const [map, rets] = await Promise.all([
          resolveSectors(tickers),
          fetchWatchReturns(tickers),
        ]);
        if (!live) return;
        setSectorMap(map);
        setStockReturns(rets);

        const [hist, cq, ch] = await Promise.all([
          fetchAllHistories(), fetchConstituentQuotes(), fetchConstituentHistories(),
        ]);
        if (!live) return;
        const ms = computeSectorMetrics(hist, cq, ch);
        setSectorMetrics(new Map(ms.map(m => [m.etf, m])));
      } catch { /* context is optional — list still works */ } finally {
        if (live) setCtxLoading(false);
      }
    })();
    return () => { live = false; };
  }, [tickerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch current price when ticker is entered (unchanged)
  async function handleTickerBlur() {
    if (!ticker.trim() || watchPrice) return;
    setFetchingPrice(true);
    try {
      const t = ticker.trim().toUpperCase();
      const q = await finnhub.quote(t);
      if (q.c && q.c > 0) { setWatchPrice(q.c.toFixed(2)); return; }
      const yahooTicker = toYahooTicker(t, t.endsWith('.TO') || t.endsWith('.V') ? 'CAD' : 'USD');
      const y = await fetchYahoo(yahooTicker);
      const price = y.price?.regularMarketPrice ?? null;
      if (price && price > 0) setWatchPrice(price.toFixed(2));
    } catch { /* ignore */ } finally {
      setFetchingPrice(false);
    }
  }

  async function fetchLive(item: WatchItem) {
    setLiveData(prev => ({ ...prev, [item.ticker]: { loading: true } }));
    try {
      const q = await finnhub.quote(item.ticker).catch(() => null);
      if (q && q.c && q.c > 0) {
        setLiveData(prev => ({ ...prev, [item.ticker]: { quote: q, loading: false } }));
        if (!item.watch_price) {
          await storage.update(TABLE, item.id, { watch_price: q.c });
          setItems(prev => prev.map(i => i.id === item.id ? { ...i, watch_price: q.c } : i));
        }
        return;
      }
      const isCAD = getMarket(item.ticker) === 'TSX';
      const yahooTicker = toYahooTicker(item.ticker, isCAD ? 'CAD' : 'USD');
      const y = await fetchYahoo(yahooTicker);
      const price = y.price?.regularMarketPrice ?? null;
      if (price != null && price > 0) {
        const synthetic: FinnhubQuote = {
          c: price,
          d: y.price?.regularMarketChange ?? 0,
          dp: (y.price?.regularMarketChangePercent ?? 0) * 100,
          h: y.price?.regularMarketDayHigh ?? price,
          l: y.price?.regularMarketDayLow ?? price,
          o: y.price?.regularMarketOpen ?? price,
          pc: y.price?.regularMarketPreviousClose ?? price,
        };
        setLiveData(prev => ({ ...prev, [item.ticker]: { quote: synthetic, loading: false } }));
        if (!item.watch_price) {
          await storage.update(TABLE, item.id, { watch_price: price });
          setItems(prev => prev.map(i => i.id === item.id ? { ...i, watch_price: price } : i));
        }
      } else {
        setLiveData(prev => ({ ...prev, [item.ticker]: { loading: false, error: 'No price data' } }));
      }
    } catch {
      setLiveData(prev => ({ ...prev, [item.ticker]: { loading: false, error: 'Failed to fetch' } }));
    }
  }

  useEffect(() => {
    items.forEach(item => { if (!liveData[item.ticker]) fetchLive(item); });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim()) return;
    setAdding(true);
    try {
      let price: number | null = watchPrice ? parseFloat(watchPrice) : null;
      if (!price) {
        try {
          const t = ticker.trim().toUpperCase();
          const q = await finnhub.quote(t);
          if (q.c && q.c > 0) price = q.c;
          else {
            const isCAD = getMarket(t) === 'TSX';
            const y = await fetchYahoo(toYahooTicker(t, isCAD ? 'CAD' : 'USD'));
            price = y.price?.regularMarketPrice ?? null;
          }
        } catch { /* leave null */ }
      }

      const item: WatchItem = {
        id: newId(),
        ticker: ticker.toUpperCase().trim(),
        conviction,
        notes,
        watch_price: price,
        watch_date: watchDate,
        analyst_target: analystTarget ? parseFloat(analystTarget) : null,
        target_entry: targetEntry ? parseFloat(targetEntry) : null,
        created_at: nowIso(),
      };
      await storage.insert(TABLE, item);
      if (catalystDate || catalystNote) {
        setMeta(setWatchMeta(item.id, {
          catalyst_date: catalystDate || undefined,
          catalyst: catalystNote || undefined,
        }));
      }
      setTicker(''); setNotes(''); setWatchPrice('');
      setWatchDate(new Date().toISOString().split('T')[0]);
      setConviction('MEDIUM'); setAnalystTarget(''); setTargetEntry('');
      setCatalystDate(''); setCatalystNote('');
      await load();
    } catch { /* ignore */ } finally {
      setAdding(false);
    }
  }

  function openBuyForm(item: WatchItem) {
    setBuyId(item.id);
    setBuyError(null);
    setBuyShares('');
    const cp = liveData[item.ticker]?.quote?.c;
    setBuyPrice(cp ? cp.toFixed(2) : item.target_entry ? item.target_entry.toFixed(2) : '');
    setBuyCurrency(getMarket(item.ticker) === 'TSX' ? 'CAD' : 'USD');
    setBuyAccount('Brokerage');
    setBuyDest('portfolio');
    setBuyStop('');
    setBuyTarget(item.analyst_target?.toFixed(2) ?? '');
    setBuySetup('Breakout');
  }

  async function handleBuy(item: WatchItem) {
    const shares = parseFloat(buyShares);
    const cost = parseFloat(buyPrice);
    if (!shares || !cost || shares <= 0 || cost <= 0) return;
    if (buyDest === 'swing' && (!buyStop || !buyTarget)) {
      setBuyError('Stop price and target price are required for Swing Trade.');
      return;
    }
    setBuyLoading(true);
    setBuyError(null);
    try {
      if (buyDest === 'swing') {
        const stop = parseFloat(buyStop);
        const target = parseFloat(buyTarget);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing: any[] = sGet('sprint_positions', []);
        sSet('sprint_positions', [...existing, {
          id: newId(), ticker: item.ticker,
          entry_date: new Date().toISOString().split('T')[0],
          entry_price: cost, shares, position_size_usd: cost * shares,
          stop_price: stop, target_price: target, setup_type: buySetup,
          week_number: currentSprintWeek(), notes: item.notes ?? '', created_at: nowIso(),
        }]);
      } else {
        const existing = (await storage.getAll<{
          id: string; ticker: string; account: string; currency: string; shares: number; avg_cost: number;
        }>(HOLDINGS_TABLE)).find(
          h => h.ticker === item.ticker && h.account === buyAccount && h.currency === buyCurrency
        );
        if (existing) {
          const totalShares = existing.shares + shares;
          const newAvgCost = (existing.shares * existing.avg_cost + shares * cost) / totalShares;
          await storage.update(HOLDINGS_TABLE, existing.id, {
            shares: totalShares, avg_cost: parseFloat(newAvgCost.toFixed(6)),
          });
        } else {
          await storage.insert(HOLDINGS_TABLE, {
            id: newId(), ticker: item.ticker, shares, avg_cost: cost,
            sector: 'Other', account: buyAccount, currency: buyCurrency,
            liquidity_risk: 'LOW', notes: item.notes ?? '', created_at: nowIso(),
          });
        }
      }
      await storage.remove(TABLE, item.id);
      removeWatchMeta(item.id);
      setMeta(loadWatchMeta());
      setLiveData(prev => { const n = { ...prev }; delete n[item.ticker]; return n; });
      setBuyId(null);
      await load();
    } catch (err) {
      setBuyError(err instanceof Error ? err.message : 'Failed. Please try again.');
    } finally {
      setBuyLoading(false);
    }
  }

  async function handleDelete(id: string, t: string) {
    await storage.remove(TABLE, id);
    removeWatchMeta(id);
    setMeta(loadWatchMeta());
    setLiveData(prev => { const n = { ...prev }; delete n[t]; return n; });
    await load();
  }

  function handleMarkReviewed(id: string) {
    setMeta(markReviewed(id));
  }

  // ── derive rows ───────────────────────────────────────────────────────────
  const rows: WatchRow[] = useMemo(() => items.map(item => {
    const up = item.ticker.toUpperCase();
    const ld = liveData[item.ticker];
    const etf = meta[item.id]?.sector_etf ?? sectorMap[up] ?? null;
    return buildWatchRow({
      item,
      meta: meta[item.id] ?? {},
      currentPrice: ld?.quote?.c ?? null,
      dayPct: ld?.quote?.dp ?? null,
      sector: etf ? sectorMetrics.get(etf) ?? null : null,
      sectorEtf: etf,
      stockReturns: stockReturns.get(up) ?? null,
    });
  }), [items, liveData, meta, sectorMap, sectorMetrics, stockReturns]);

  const summary = useMemo(() => summarize(rows), [rows]);

  const sectorExposure = useMemo(() => {
    const counts: Record<string, number> = {};
    rows.forEach(r => {
      const name = r.sector?.name ?? (r.sectorEtf ?? 'Unclassified');
      counts[name] = (counts[name] ?? 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = useMemo(() => rows.filter(r => {
    if (filterMarket !== 'ALL' && r.market !== filterMarket) return false;
    if (filterZone === 'BUY' && r.insideEntry !== true) return false;
    if (filterZone === 'ABOVE' && r.insideEntry !== false) return false;
    if (filterStatus !== 'ALL' && r.status !== filterStatus) return false;
    if (onlyAttention && !needsAttention(r)) return false;
    if (onlyHighConv && r.item.conviction !== 'HIGH') return false;
    if (onlySectorUp && !(r.sector && r.sector.pressure > 0)) return false;
    if (onlyPosRs && !(r.rsVsSector1M != null && r.rsVsSector1M > 0)) return false;
    if (onlyCatalyst && !(r.catalystDaysAway != null && r.catalystDaysAway >= 0 && r.catalystDaysAway <= WATCH_THRESHOLDS.catalystSoonDays)) return false;
    return true;
  }), [rows, filterMarket, filterZone, filterStatus, onlyAttention, onlyHighConv, onlySectorUp, onlyPosRs, onlyCatalyst]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const nn = (v: number | null | undefined, fallback: number) => v == null ? fallback : v;
    switch (sortBy) {
      case 'closest':        arr.sort((a, b) => Math.abs(nn(a.entryDistancePct, 9999)) - Math.abs(nn(b.entryDistancePct, 9999))); break;
      case 'conviction':     arr.sort((a, b) => CONVICTION_ORDER.indexOf(a.item.conviction) - CONVICTION_ORDER.indexOf(b.item.conviction) || b.actionability - a.actionability); break;
      case 'sectorPressure': arr.sort((a, b) => nn(b.sector?.pressure, -999) - nn(a.sector?.pressure, -999)); break;
      case 'relStrength':    arr.sort((a, b) => nn(b.rsVsSector1M, -999) - nn(a.rsVsSector1M, -999)); break;
      case 'upside':         arr.sort((a, b) => nn(b.targetUpsidePct, -999) - nn(a.targetUpsidePct, -999)); break;
      case 'review':         arr.sort((a, b) => b.reviewReasons.length - a.reviewReasons.length || b.watchAgeDays - a.watchAgeDays); break;
      case 'newest':         arr.sort((a, b) => a.watchAgeDays - b.watchAgeDays); break;
      case 'oldest':         arr.sort((a, b) => b.watchAgeDays - a.watchAgeDays); break;
      case 'alpha':          arr.sort((a, b) => a.item.ticker.localeCompare(b.item.ticker)); break;
      default:               arr.sort((a, b) => b.actionability - a.actionability || a.item.ticker.localeCompare(b.item.ticker));
    }
    return arr;
  }, [filtered, sortBy]);

  const chipBase = 'text-xs px-3 py-1 rounded-full border transition-colors';
  const chipOff = 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500';

  return (
    <div className="space-y-6">
      {/* ── Add form (preserved, plus optional catalyst) ───────────────────── */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">Add to Watch List</h2>
        <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
          <div className="w-28">
            <label className="label">Ticker *</label>
            <input className="input-base uppercase" placeholder="NVDA" value={ticker}
              onChange={e => { setTicker(e.target.value); setWatchPrice(''); }}
              onBlur={handleTickerBlur} required />
          </div>
          <div className="w-28">
            <label className="label">
              Watch Price {fetchingPrice && <span className="ml-1 text-zinc-600 text-xs">fetching…</span>}
            </label>
            <input className="input-base" type="number" step="0.01" placeholder="auto"
              value={watchPrice} onChange={e => setWatchPrice(e.target.value)} />
          </div>
          <div className="w-36">
            <label className="label">Watch Date</label>
            <input className="input-base" type="date" value={watchDate} onChange={e => setWatchDate(e.target.value)} />
          </div>
          <div className="w-32">
            <label className="label">Conviction</label>
            <select className="select-base" value={conviction} onChange={e => setConviction(e.target.value as Conviction)}>
              {CONVICTION_ORDER.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="w-28">
            <label className="label">Target Entry</label>
            <input className="input-base" type="number" step="0.01" placeholder="e.g. 145.00"
              value={targetEntry} onChange={e => setTargetEntry(e.target.value)} />
          </div>
          <div className="w-28">
            <label className="label">Analyst Target</label>
            <input className="input-base" type="number" step="0.01" placeholder="e.g. 200.00"
              value={analystTarget} onChange={e => setAnalystTarget(e.target.value)} />
          </div>
          <div className="w-36">
            <label className="label">Catalyst Date</label>
            <input className="input-base" type="date" value={catalystDate} onChange={e => setCatalystDate(e.target.value)} />
          </div>
          <div className="w-36">
            <label className="label">Catalyst</label>
            <input className="input-base" placeholder="Earnings…" value={catalystNote} onChange={e => setCatalystNote(e.target.value)} />
          </div>
          <div className="flex-1 min-w-40">
            <label className="label">Notes / Thesis</label>
            <input className="input-base" placeholder="Setup thesis..." value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          <button type="submit" className="btn-primary flex items-center gap-2" disabled={adding}>
            <Plus size={14} />{adding ? 'Adding...' : 'Add'}
          </button>
        </form>
        {targetEntry && analystTarget && parseFloat(targetEntry) > 0 && (
          <p className="text-xs text-zinc-500 mt-2">
            Upside from target entry to analyst target:{' '}
            <span className="text-emerald-400 font-medium tabular-nums">
              {(((parseFloat(analystTarget) - parseFloat(targetEntry)) / parseFloat(targetEntry)) * 100).toFixed(1)}%
            </span>
          </p>
        )}
        <p className="text-xs text-zinc-600 mt-2">
          Watch price auto-fills when you tab out of the ticker field. Catalyst fields are optional.
        </p>
      </div>

      {/* ── Watch list ─────────────────────────────────────────────────────── */}
      <div className="card">
        {/* Summary bar */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pb-3 mb-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">
            Watching <span className="text-zinc-600 text-sm font-normal">({summary.total})</span>
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
            <span className="text-emerald-400 font-medium">{summary.actionable} Actionable</span>
            <span className="text-blue-400 font-medium">{summary.nearEntry} Near Entry</span>
            <span className="text-amber-400 font-medium">{summary.extended} Extended</span>
            <span className="text-orange-400 font-medium">{summary.review} Needs Review</span>
            <span className="text-zinc-400">{summary.sectorsImproving} Sectors Improving</span>
            <button onClick={() => setShowExposure(v => !v)}
              className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 decoration-dotted">
              Sector exposure
            </button>
            {ctxLoading && (
              <span className="text-zinc-600 flex items-center gap-1"><RefreshCw size={10} className="animate-spin" /> sector context…</span>
            )}
          </div>
          <button
            onClick={() => setOnlyAttention(v => !v)}
            className={`${chipBase} ml-auto ${onlyAttention ? 'bg-blue-900/50 text-blue-300 border-blue-600' : chipOff}`}>
            ⚡ Needs Attention ({summary.attention})
          </button>
        </div>

        {showExposure && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400 mb-3 pb-3 border-b border-zinc-800">
            {sectorExposure.map(([name, n]) => (
              <span key={name}>{name}: <span className="text-zinc-200 font-medium tabular-nums">{n}</span></span>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="flex gap-1">
            {(['ALL', 'US', 'TSX'] as const).map(m => (
              <button key={m} onClick={() => setFilterMarket(m)}
                className={`${chipBase} ${filterMarket === m ? 'bg-blue-900/50 text-blue-300 border-blue-600' : chipOff}`}>
                {m}
              </button>
            ))}
          </div>

          <span className="w-px h-4 bg-zinc-700" />

          <div className="flex gap-1 flex-wrap">
            <button onClick={() => setFilterStatus('ALL')}
              className={`${chipBase} ${filterStatus === 'ALL' ? 'bg-zinc-700 text-zinc-200 border-zinc-500' : chipOff}`}>
              All Status
            </button>
            {STATUS_FILTERS.map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={`${chipBase} ${filterStatus === s ? STATUS_STYLE[s].badge : chipOff}`}>
                {s}
              </button>
            ))}
          </div>

          <span className="w-px h-4 bg-zinc-700" />

          <div className="flex gap-1 flex-wrap">
            {([
              { on: onlyHighConv, set: setOnlyHighConv, label: 'High Conviction' },
              { on: onlySectorUp, set: setOnlySectorUp, label: 'Sector Improving' },
              { on: onlyPosRs, set: setOnlyPosRs, label: '+Rel Strength' },
              { on: onlyCatalyst, set: setOnlyCatalyst, label: 'Catalyst Soon' },
            ] as const).map(f => (
              <button key={f.label} onClick={() => f.set(v => !v)}
                className={`${chipBase} ${f.on ? 'bg-zinc-700 text-zinc-100 border-zinc-500' : chipOff}`}>
                {f.label}
              </button>
            ))}
            {([
              { key: 'BUY', label: '🟢 Buy Zone' },
              { key: 'ABOVE', label: 'Above Entry' },
            ] as const).map(z => (
              <button key={z.key} onClick={() => setFilterZone(filterZone === z.key ? 'ALL' : z.key)}
                className={`${chipBase} ${filterZone === z.key ? 'bg-emerald-900/50 text-emerald-300 border-emerald-600' : chipOff}`}>
                {z.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-zinc-600">Sort:</span>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)} className="select-base text-xs w-44">
              {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {sorted.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-8">
            {rows.length === 0 ? 'No tickers watched yet.' : 'No entries match the current filters.'}
          </p>
        ) : (
          <div className="space-y-2">
            {sorted.map(r => {
              const item = r.item;
              const ld = liveData[item.ticker];
              const isBuying = buyId === item.id;
              const style = STATUS_STYLE[r.status];
              const m = meta[item.id] ?? {};
              const thesisText = m.thesis || item.notes || '';
              // Only THESIS BROKEN gets a tinted card; everything else stays neutral
              const cardTint = r.status === 'THESIS BROKEN' ? 'bg-red-950/20 border-red-900/50' : 'bg-zinc-800/40 border-zinc-800';

              return (
                <div key={item.id} className={`rounded-lg border border-l-4 ${style.border} ${cardTint} p-3.5 transition-colors`}>
                  <div className="flex items-start gap-4 flex-wrap">
                    {/* Identity + status */}
                    <div className="w-40 flex-shrink-0">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setDrawer({ ticker: item.ticker, currency: r.market === 'TSX' ? 'CAD' : 'USD' })}
                          className="font-mono font-bold text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 text-base"
                          title={`View fundamentals for ${item.ticker}`}>
                          {item.ticker}
                        </button>
                        <span className="text-[10px] text-zinc-600">{r.market}</span>
                      </div>
                      <div className={`inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${style.badge}`}>
                        {r.status}
                      </div>
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${convictionBg[item.conviction]}`}>
                          {item.conviction}
                        </span>
                        {r.sectorEtf ? (
                          <button
                            onClick={() => navigateTo('sectors', { sector: r.sectorEtf! })}
                            title={`Open ${r.sectorEtf} in Sector Rotation`}
                            className="text-[10px] text-zinc-400 hover:text-blue-300 hover:underline underline-offset-2">
                            {r.sector?.name ?? r.sectorEtf} — {r.sectorEtf}
                          </button>
                        ) : (
                          <span className="text-[10px] text-zinc-700">Sector N/A</span>
                        )}
                      </div>
                    </div>

                    {/* Price / entry strip */}
                    <div className="flex items-start gap-4 flex-wrap flex-1">
                      <Stat label="Now"
                        value={ld?.loading ? <span className="text-zinc-600 text-xs animate-pulse">…</span>
                          : ld?.error ? <span className="text-red-500 text-xs">{ld.error}</span>
                          : r.currentPrice != null ? fmtCurrency(r.currentPrice) : '—'} />
                      <Stat label="Entry" value={item.target_entry ? fmtCurrency(item.target_entry) : 'N/A'} cls="text-zinc-400" />
                      <Stat
                        label="Distance"
                        title="Current price vs your target entry"
                        value={r.entryDistancePct == null ? 'N/A'
                          : r.insideEntry ? `${signedPct(r.entryDistancePct, 1)}` : signedPct(r.entryDistancePct, 1)}
                        cls={r.entryDistancePct == null ? 'text-zinc-600' : r.insideEntry ? 'text-emerald-400' : r.entryDistancePct > WATCH_THRESHOLDS.extendedPct ? 'text-amber-400' : 'text-zinc-300'} />
                      <Stat label="Today" value={r.dayPct != null ? fmtPct(r.dayPct) : '—'} cls={r.dayPct != null ? changeColor(r.dayPct) : 'text-zinc-600'} />
                      <Stat label={`Since Watch (${r.watchAgeDays}d)`}
                        value={r.sinceWatchPct != null ? signedPct(r.sinceWatchPct) : '—'}
                        cls={pctColor(r.sinceWatchPct)} />
                      <Stat label="Target" value={item.analyst_target ? fmtCurrency(item.analyst_target) : 'N/A'} cls="text-zinc-400" />
                      <Stat label="Upside" value={r.targetUpsidePct != null ? signedPct(r.targetUpsidePct, 1) : 'N/A'}
                        cls={pctColor(r.targetUpsidePct)} />
                    </div>

                    {/* Sector context */}
                    <div className="flex items-start gap-4 flex-shrink-0">
                      <Stat
                        label="Sector Press."
                        title={r.sector ? `${r.sector.name}: ${r.sector.classification}` : 'Sector data unavailable'}
                        value={r.sector ? (
                          <span className="inline-flex items-center gap-1">
                            {r.sector.pressure >= 0 ? '+' : ''}{r.sector.pressure}
                            <TrendArrow v={r.sector.pressureDelta.d5} />
                          </span>
                        ) : 'N/A'}
                        cls={r.sector ? (r.sector.pressure >= 22 ? 'text-emerald-400' : r.sector.pressure <= -22 ? 'text-red-400' : 'text-zinc-300') : 'text-zinc-600'} />
                      <Stat label="vs Sector"
                        title={r.stockReturns ? `Stock 1M ${signedPct((r.stockReturns.ret1M ?? 0) * 100, 1)} · 5D ${signedPct((r.stockReturns.ret5D ?? 0) * 100, 1)} · 3M ${signedPct((r.stockReturns.ret3M ?? 0) * 100, 1)}` : undefined}
                        value={r.rsVsSector1M != null ? signedPct(r.rsVsSector1M * 100, 1) : 'N/A'}
                        cls={pctColor(r.rsVsSector1M)} />
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                      <button onClick={() => navigateTo('technical', { ticker: item.ticker })}
                        className="btn-ghost p-1.5" title="Open in Chart Analysis">
                        <LineChart size={13} />
                      </button>
                      {r.sectorEtf && (
                        <button onClick={() => navigateTo('sectors', { sector: r.sectorEtf! })}
                          className="btn-ghost p-1.5" title="Open sector in Sector Rotation">
                          <ArrowLeftRight size={13} />
                        </button>
                      )}
                      <button onClick={() => handleMarkReviewed(item.id)}
                        className={`btn-ghost p-1.5 ${r.reviewDue ? 'text-orange-400' : ''}`}
                        title={m.last_reviewed ? `Last reviewed ${m.last_reviewed}` : 'Mark reviewed'}>
                        <CheckCheck size={13} />
                      </button>
                      <button onClick={() => fetchLive(item)} className="btn-ghost p-1.5" title="Refresh">
                        <RefreshCw size={13} className={ld?.loading ? 'animate-spin' : ''} />
                      </button>
                      <button onClick={() => editId === item.id ? setEditId(null) : openEdit(item)}
                        className={`btn-ghost p-1.5 ${editId === item.id ? 'text-blue-400' : ''}`} title="Edit">
                        <Edit2 size={13} />
                      </button>
                      <button onClick={() => isBuying ? setBuyId(null) : openBuyForm(item)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                          isBuying ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600' : 'bg-emerald-700 hover:bg-emerald-600 text-white'
                        }`} title="Buy">
                        {isBuying ? <X size={12} /> : <ShoppingCart size={12} />}
                        {isBuying ? 'Cancel' : 'Buy'}
                      </button>
                      <button onClick={() => handleDelete(item.id, item.ticker)} className="btn-danger">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Chips: alignment · sector shift · catalyst · review */}
                  {(r.alignment || r.sectorShift != null || r.catalystDaysAway != null || r.reviewReasons.length > 0 || r.reviewDue) && (
                    <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px]">
                      {r.alignment && (
                        <span className={`font-semibold ${ALIGNMENT_STYLE[r.alignment]}`}>{r.alignment}</span>
                      )}
                      {r.sectorShift != null && r.sector && (
                        <span className="flex items-center gap-1 text-zinc-400 bg-zinc-800/70 border border-zinc-700 rounded px-1.5 py-0.5">
                          <ArrowLeftRight size={10} className="text-blue-400" />
                          SECTOR SHIFT: {r.sector.name} {r.sectorShift >= 0 ? '+' : ''}{r.sectorShift} over 5D
                        </span>
                      )}
                      {r.catalystDaysAway != null && (
                        <span className={`flex items-center gap-1 rounded px-1.5 py-0.5 border ${
                          r.catalystDaysAway < 0 ? 'text-orange-400 bg-orange-950/30 border-orange-900/50'
                          : r.catalystDaysAway <= WATCH_THRESHOLDS.catalystSoonDays ? 'text-violet-300 bg-violet-950/30 border-violet-900/50'
                          : 'text-zinc-400 bg-zinc-800/70 border-zinc-700'}`}>
                          <Calendar size={10} />
                          {m.catalyst || 'Catalyst'}{' '}
                          {r.catalystDaysAway < 0 ? `passed ${Math.abs(r.catalystDaysAway)}d ago` : `in ${r.catalystDaysAway}d`}
                        </span>
                      )}
                      {r.reviewDue && r.reviewReasons.length === 0 && (
                        <span className="text-orange-400/80">REVIEW DUE</span>
                      )}
                      {r.reviewReasons.length > 0 && (
                        <span className="flex items-center gap-1 text-orange-400" title={r.reviewReasons.join('\n')}>
                          <AlertTriangle size={10} />
                          {r.reviewReasons[0]}
                          {r.reviewReasons.length > 1 && <span className="text-zinc-600">+{r.reviewReasons.length - 1} more</span>}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Thesis / Trigger / Catalyst */}
                  {(thesisText || m.trigger || m.catalyst) && (
                    <div className="mt-2 pt-2 border-t border-zinc-700/40 grid gap-1 text-xs sm:grid-cols-3">
                      {thesisText && (
                        <div>
                          <span className="text-[10px] uppercase tracking-wide text-zinc-600 block">Thesis</span>
                          <span className="text-zinc-400 leading-relaxed">{thesisText}</span>
                        </div>
                      )}
                      {m.trigger && (
                        <div>
                          <span className="text-[10px] uppercase tracking-wide text-zinc-600 block">Entry Trigger</span>
                          <span className="text-zinc-400 leading-relaxed">{m.trigger}</span>
                        </div>
                      )}
                      {m.catalyst && (
                        <div>
                          <span className="text-[10px] uppercase tracking-wide text-zinc-600 block">Catalyst</span>
                          <span className="text-zinc-400 leading-relaxed">
                            {m.catalyst}{m.catalyst_date ? ` · ${m.catalyst_date}` : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Inline edit form */}
                  {editId === item.id && (
                    <div className="mt-3 pt-3 border-t border-zinc-700/50 space-y-3">
                      <div className="flex flex-wrap gap-3 items-end">
                        <div><label className="label">Watch Price</label>
                          <input className="input-base w-28" type="number" step="0.01" value={editForm.watch_price}
                            onChange={e => setEditForm({ ...editForm, watch_price: e.target.value })} autoFocus /></div>
                        <div><label className="label">Target Entry</label>
                          <input className="input-base w-28" type="number" step="0.01" value={editForm.target_entry}
                            onChange={e => setEditForm({ ...editForm, target_entry: e.target.value })} /></div>
                        <div><label className="label">Analyst Target</label>
                          <input className="input-base w-28" type="number" step="0.01" value={editForm.analyst_target}
                            onChange={e => setEditForm({ ...editForm, analyst_target: e.target.value })} /></div>
                        <div><label className="label">Conviction</label>
                          <select className="select-base w-28" value={editForm.conviction}
                            onChange={e => setEditForm({ ...editForm, conviction: e.target.value as Conviction })}>
                            {CONVICTION_ORDER.map(c => <option key={c}>{c}</option>)}
                          </select></div>
                        <div><label className="label">Catalyst Date</label>
                          <input className="input-base w-36" type="date" value={editForm.catalyst_date}
                            onChange={e => setEditForm({ ...editForm, catalyst_date: e.target.value })} /></div>
                        <div className="flex-1 min-w-40"><label className="label">Catalyst</label>
                          <input className="input-base" placeholder="Earnings Apr 29" value={editForm.catalyst}
                            onChange={e => setEditForm({ ...editForm, catalyst: e.target.value })} /></div>
                      </div>
                      <div className="flex flex-wrap gap-3 items-end">
                        <div className="flex-1 min-w-52"><label className="label">Thesis</label>
                          <input className="input-base" placeholder="Why this stock is interesting"
                            value={editForm.thesis} onChange={e => setEditForm({ ...editForm, thesis: e.target.value })} /></div>
                        <div className="flex-1 min-w-52"><label className="label">Entry Trigger</label>
                          <input className="input-base" placeholder="What must happen before buying"
                            value={editForm.trigger} onChange={e => setEditForm({ ...editForm, trigger: e.target.value })} /></div>
                      </div>
                      <div className="flex flex-wrap gap-3 items-end">
                        <div className="flex-1 min-w-52"><label className="label">Notes (original)</label>
                          <input className="input-base" value={editForm.notes}
                            onChange={e => setEditForm({ ...editForm, notes: e.target.value })} /></div>
                        <label className="flex items-center gap-2 text-xs text-zinc-400 pb-2 cursor-pointer">
                          <input type="checkbox" checked={editForm.thesis_broken}
                            onChange={e => setEditForm({ ...editForm, thesis_broken: e.target.checked })}
                            className="accent-red-500" />
                          Mark thesis broken
                        </label>
                        <div className="flex gap-2">
                          <button onClick={() => saveEdit(item.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded transition-colors">
                            <Check size={13} /> Save
                          </button>
                          <button onClick={() => setEditId(null)} className="btn-ghost text-xs px-3 py-1.5">Cancel</button>
                        </div>
                      </div>
                      <p className="text-xs text-zinc-600">
                        Thesis, trigger and catalyst are stored in this browser; price fields and notes save to your account.
                      </p>
                    </div>
                  )}

                  {/* Inline buy form (unchanged behaviour) */}
                  {isBuying && (
                    <div className="mt-3 pt-3 border-t border-zinc-700/50 space-y-3">
                      <div className="flex gap-2">
                        <span className="text-xs text-zinc-500 self-center mr-1">Send to:</span>
                        {(['portfolio', 'swing'] as const).map(d => (
                          <button key={d} onClick={() => setBuyDest(d)}
                            className={`${chipBase} font-medium ${buyDest === d ? 'bg-blue-900/50 text-blue-300 border-blue-600' : chipOff}`}>
                            {d === 'portfolio' ? '📊 Portfolio' : '⚡ Swing Trade'}
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-3 items-end">
                        <div><label className="label">Shares *</label>
                          <input className="input-base w-24" type="number" step="0.0001" min="0.0001" placeholder="100"
                            value={buyShares} onChange={e => setBuyShares(e.target.value)} autoFocus /></div>
                        <div><label className="label">Entry Price *</label>
                          <input className="input-base w-28" type="number" step="0.01" min="0.01" placeholder="0.00"
                            value={buyPrice} onChange={e => setBuyPrice(e.target.value)} /></div>
                        {buyDest === 'portfolio' && (
                          <>
                            <div><label className="label">Account</label>
                              <select className="select-base w-28" value={buyAccount} onChange={e => setBuyAccount(e.target.value)}>
                                {['Brokerage', 'RRSP', 'LIRA', 'TSFA', 'HSA', 'Other'].map(a => <option key={a}>{a}</option>)}
                              </select></div>
                            <div><label className="label">Currency</label>
                              <select className="select-base w-24" value={buyCurrency} onChange={e => setBuyCurrency(e.target.value)}>
                                <option>USD</option><option>CAD</option>
                              </select></div>
                          </>
                        )}
                        {buyDest === 'swing' && (
                          <>
                            <div><label className="label">Stop Price *</label>
                              <input className="input-base w-28" type="number" step="0.01" placeholder="0.00"
                                value={buyStop} onChange={e => setBuyStop(e.target.value)} /></div>
                            <div><label className="label">Target Price *</label>
                              <input className="input-base w-28" type="number" step="0.01" placeholder="0.00"
                                value={buyTarget} onChange={e => setBuyTarget(e.target.value)} /></div>
                            <div><label className="label">Setup</label>
                              <select className="select-base w-32" value={buySetup} onChange={e => setBuySetup(e.target.value)}>
                                {['Breakout', 'Pullback', 'Reversal', 'Momentum', 'Other'].map(s => <option key={s}>{s}</option>)}
                              </select></div>
                          </>
                        )}
                        <button onClick={() => handleBuy(item)} disabled={buyLoading || !buyShares || !buyPrice}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold rounded transition-colors">
                          <Check size={13} />
                          {buyLoading ? 'Adding…' : buyDest === 'swing' ? 'Add to Swing Trade' : 'Add to Portfolio'}
                        </button>
                      </div>
                      <p className="text-xs text-zinc-600">
                        {buyDest === 'swing'
                          ? `${item.ticker} will be added to your Swing Trade open positions.`
                          : `${item.ticker} will be added to your Portfolio.`}{' '}
                        It will be removed from the Watch List.
                      </p>
                      {buyError && <p className="text-xs text-red-400">{buyError}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {drawer && (
        <FundamentalsDrawer ticker={drawer.ticker} currency={drawer.currency} onClose={() => setDrawer(null)} />
      )}
    </div>
  );
}
