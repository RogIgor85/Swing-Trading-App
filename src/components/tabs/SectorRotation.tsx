import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  RefreshCw, ArrowLeftRight, ArrowUp, ArrowDown, ArrowRight, AlertTriangle,
  Info, TrendingUp, TrendingDown, Eye, X, ChevronUp, ChevronDown, ChevronsUpDown, List,
} from 'lucide-react';
import {
  ScatterChart, Scatter, XAxis, YAxis, ReferenceLine, Tooltip as ReTooltip,
  ResponsiveContainer, Label,
} from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import { consumePendingSector } from '../../lib/navigation';
import FundamentalsDrawer from '../FundamentalsDrawer';
import {
  fetchAllHistories, fetchConstituentQuotes, fetchConstituentHistories,
  fetchSpyQuote, fetchFundamentals, usMarketStatus,
} from '../../lib/sector/sectorData';
import type { ConstituentQuote, SpyQuote, ConstituentFundamentals, EtfHistory } from '../../lib/sector/sectorData';
import {
  computeSectorMetrics, computeRegime, computeOpportunities, computeConstituentRows, quadrantOf,
} from '../../lib/sector/sectorEngine';
import type { SectorMetrics, Classification, ConstituentRow } from '../../lib/sector/sectorEngine';
import { SECTOR_ETFS, BENCHMARK_ETF, VOLUME_LEVELS } from '../../config/sectorConfig';
import type { Timeframe, MatrixTimeframe } from '../../config/sectorConfig';
import type { WatchItem, Conviction } from '../../types';

// ─── formatting helpers ──────────────────────────────────────────────────────

const fmtPctS = (x: number | null | undefined, d = 1): string =>
  x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;

const pctColor = (x: number | null | undefined): string =>
  x == null ? 'text-zinc-600' : x >= 0 ? 'text-emerald-400' : 'text-red-400';

const pressureColor = (p: number): string =>
  p >= 22 ? 'text-emerald-400' : p <= -22 ? 'text-red-400' : 'text-zinc-300';

const signedInt = (n: number | null | undefined): string =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n}`;

const classColor: Record<Classification, string> = {
  Leading:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/40',
  Improving: 'text-blue-400 bg-blue-500/10 border-blue-500/40',
  Neutral:   'text-zinc-400 bg-zinc-500/10 border-zinc-600/40',
  Weakening: 'text-amber-400 bg-amber-500/10 border-amber-500/40',
  Lagging:   'text-red-400 bg-red-500/10 border-red-500/40',
};

function TrendArrowIcon({ arrow }: { arrow: 'up' | 'flat' | 'down' }) {
  if (arrow === 'up')   return <ArrowUp size={12} className="text-emerald-400" />;
  if (arrow === 'down') return <ArrowDown size={12} className="text-red-400" />;
  return <ArrowRight size={12} className="text-zinc-500" />;
}

function MomentumBadge({ m }: { m: SectorMetrics['momentum'] }) {
  const cls = m === 'ACCELERATING' ? 'text-emerald-400' : m === 'DECELERATING' ? 'text-red-400' : 'text-zinc-500';
  return <span className={`text-xs font-medium ${cls}`}>{m}</span>;
}

function InfoTip({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex text-zinc-600 hover:text-zinc-400 cursor-help align-middle">
      <Info size={11} />
    </span>
  );
}

function breadthTitle(m: SectorMetrics): string {
  const b = m.breadth;
  if (!b) return 'Breadth unavailable — insufficient constituent data';
  const line = (label: string, v: number | null) => v != null ? `${label}: ${v}%` : null;
  return [
    line('20DMA', b.above20Pct), line('50DMA', b.above50Pct), line('200DMA', b.above200Pct),
    line('5D Positive', b.pos5DPct), line('20D Positive', b.pos20DPct),
    line('Positive today', b.positiveTodayPct),
    `Breadth Score: ${b.score}`,
    b.change != null ? `5D Change: ${b.change >= 0 ? '+' : ''}${b.change}` : null,
    `(${b.count} tracked names, ${b.source === 'history' ? 'price history' : 'current quotes only'})`,
  ].filter(Boolean).join('\n');
}

/** Tiny sparkline of pressure history (last ~20 points) */
function PressureSpark({ values }: { values: number[] }) {
  const vals = values.slice(-20);
  if (vals.length < 2) return null;
  const w = 64, h = 18, pad = 2;
  const min = Math.min(...vals, -10), max = Math.max(...vals, 10);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 opacity-70">
      <polyline points={pts} fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Full sector detail block used inside hover tooltips */
function SectorTooltipBody({ m, tf }: { m: SectorMetrics; tf?: MatrixTimeframe }) {
  const mtx = tf ? m.matrix[tf] : null;
  const prev = mtx && mtx.trail.length > 0 ? mtx.trail[mtx.trail.length - 1] : null;
  const fromQ = prev ? quadrantOf(prev.x, prev.y) : null;
  const toQ   = mtx ? quadrantOf(mtx.x, mtx.y) : null;
  return (
    <div className="text-xs space-y-1 tabular-nums">
      <div className="font-bold text-zinc-100">{m.name} — {m.etf}</div>
      <div>Rotation Pressure: <span className={pressureColor(m.pressure)}>{signedInt(m.pressure)}</span>
        <span className="text-zinc-500 ml-1.5">Δ5D {signedInt(m.pressureDelta.d5)}</span></div>
      <div>Rotation Score: <span className="text-zinc-200">{m.score}</span> · <span className="text-zinc-300">{m.classification}</span></div>
      <div className="text-zinc-400">
        5D {fmtPctS(m.ret['5D'])} · 1M {fmtPctS(m.ret['1M'])} · 3M {fmtPctS(m.ret['3M'])}
      </div>
      <div>vs SPY 1M: <span className={pctColor(m.rs['1M'])}>{fmtPctS(m.rs['1M'])}</span> · 3M: <span className={pctColor(m.rs['3M'])}>{fmtPctS(m.rs['3M'])}</span></div>
      {mtx && (
        <div className="text-zinc-400">RS {mtx.y.toFixed(1)} · RS momentum {mtx.x >= 0 ? '+' : ''}{mtx.x.toFixed(2)}</div>
      )}
      <div>Momentum: <MomentumBadge m={m.momentum} /></div>
      <div>Breadth: {m.breadth ? `${m.breadth.score}${m.breadth.change != null ? ` (${signedInt(m.breadth.change)})` : ''}` : 'unavailable'} · Volume: {m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A'}</div>
      {fromQ && toQ && (
        <div className="text-zinc-300 pt-0.5 border-t border-zinc-800">
          {fromQ === toQ ? <>Holding in <span className="font-semibold">{toQ}</span></> : <>{fromQ} → <span className="font-semibold">{toQ}</span></>}
        </div>
      )}
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

type SortKey = 'name' | 'ret1D' | 'ret5D' | 'ret1M' | 'ret3M' | 'ret6M' | 'rs5D' | 'rs1M' | 'rs3M' | 'breadth' | 'breadthD5' | 'volume' | 'pressure' | 'score';
type CardSort = 'pressure' | 'score' | 'ret' | 'rs';

export default function SectorRotation() {
  const [metrics, setMetrics]   = useState<SectorMetrics[]>([]);
  const [quotes, setQuotes]     = useState<Map<string, ConstituentQuote>>(new Map());
  const [conHists, setConHists] = useState<Map<string, number[]>>(new Map());
  const [histories, setHistories] = useState<Map<string, EtfHistory>>(new Map());
  const [spy, setSpy]           = useState<SpyQuote | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [updatedAt, setUpdated] = useState<Date | null>(null);
  const [missing, setMissing]   = useState<string[]>([]);

  const [tf, setTf]                 = useState<Timeframe>('1M');
  const [matrixTf, setMatrixTf]     = useState<MatrixTimeframe>('3M');
  const [cardSort, setCardSort]     = useState<CardSort>('pressure');
  const [sortKey, setSortKey]       = useState<SortKey>('pressure');
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc');
  const [classFilter, setClassFilter] = useState<Classification | 'ALL'>('ALL');
  const [fltOutperform, setFltOutperform] = useState(false);
  const [fltAccel, setFltAccel]           = useState(false);
  const [fltBreadth, setFltBreadth]       = useState(false);
  const [fltAbove50, setFltAbove50]       = useState(false);
  const [changeTf, setChangeTf]     = useState<'d1' | 'd5' | 'd20'>('d5');

  // Shared selected-sector state — every section reads/writes this one value
  const [selectedEtf, setSelectedEtf] = useState<string | null>(null);
  const [drawer, setDrawer]           = useState<{ ticker: string; currency: string } | null>(null);
  const drillRef = useRef<HTMLDivElement>(null);

  const scrollToDrill = useCallback(() => {
    // slight delay so the drill-down exists before scrolling
    setTimeout(() => drillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }, []);

  const selectSector = useCallback((etf: string) => {
    setSelectedEtf(prev => {
      if (prev === etf) { scrollToDrill(); return prev; } // second click → view stocks
      return etf;
    });
  }, [scrollToDrill]);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const [hist, cq, ch, spyQ] = await Promise.all([
        fetchAllHistories(force),
        fetchConstituentQuotes(force),
        fetchConstituentHistories(force),
        fetchSpyQuote(),
      ]);
      if (!hist.has(BENCHMARK_ETF)) {
        setError('Could not load SPY benchmark data. The rotation engine needs it — try Refresh.');
        setLoading(false);
        return;
      }
      const m = computeSectorMetrics(hist, cq, ch);
      setMetrics(m);
      setQuotes(cq);
      setConHists(ch);
      setHistories(hist);
      setSpy(spyQ);
      setMissing(SECTOR_ETFS.filter(s => !hist.has(s.etf)).map(s => s.etf));
      setUpdated(new Date());
    } catch (e) {
      console.error(e);
      setError('Failed to load sector data. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Sector requested from another tab (e.g. Watch List sector link)
  useEffect(() => {
    const pending = consumePendingSector();
    if (pending) setSelectedEtf(pending);
  }, []);

  const regime = useMemo(() => computeRegime(metrics), [metrics]);
  const opportunities = useMemo(() => computeOpportunities(metrics, quotes, conHists), [metrics, quotes, conHists]);

  const byPressure = useMemo(() => [...metrics].sort((a, b) => b.pressure - a.pressure), [metrics]);
  const topIn  = byPressure.filter(m => m.pressure > 0).slice(0, 3);
  const topOut = [...byPressure].reverse().filter(m => m.pressure < 0).slice(0, 3);
  const biggestChange = useMemo(() => {
    const withD = metrics.filter(m => m.pressureDelta.d5 != null);
    if (withD.length === 0) return null;
    return [...withD].sort((a, b) => Math.abs(b.pressureDelta.d5!) - Math.abs(a.pressureDelta.d5!))[0];
  }, [metrics]);

  const sortedCards = useMemo(() => {
    const arr = [...metrics];
    if (cardSort === 'pressure') arr.sort((a, b) => b.pressure - a.pressure);
    if (cardSort === 'score')    arr.sort((a, b) => b.score - a.score);
    if (cardSort === 'ret')      arr.sort((a, b) => (b.ret[tf] ?? -9) - (a.ret[tf] ?? -9));
    if (cardSort === 'rs')       arr.sort((a, b) => (b.rs['1M'] ?? -9) - (a.rs['1M'] ?? -9));
    return arr;
  }, [metrics, cardSort, tf]);

  const tableRows = useMemo(() => {
    let rows = [...metrics];
    if (classFilter !== 'ALL') rows = rows.filter(m => m.classification === classFilter);
    if (fltOutperform) rows = rows.filter(m => (m.rs['1M'] ?? -1) > 0);
    if (fltAccel)      rows = rows.filter(m => m.momentum === 'ACCELERATING');
    if (fltBreadth)    rows = rows.filter(m => (m.breadth?.score ?? 0) > 50);
    if (fltAbove50)    rows = rows.filter(m => m.above50 === true);
    const get = (m: SectorMetrics): number | string => {
      switch (sortKey) {
        case 'name':   return m.name;
        case 'ret1D':  return m.ret['1D'] ?? -99;
        case 'ret5D':  return m.ret['5D'] ?? -99;
        case 'ret1M':  return m.ret['1M'] ?? -99;
        case 'ret3M':  return m.ret['3M'] ?? -99;
        case 'ret6M':  return m.ret['6M'] ?? -99;
        case 'rs5D':   return m.rs['5D'] ?? -99;
        case 'rs1M':   return m.rs['1M'] ?? -99;
        case 'rs3M':   return m.rs['3M'] ?? -99;
        case 'breadth': return m.breadth?.score ?? -1;
        case 'breadthD5': return m.breadth?.change ?? -999;
        case 'volume': return m.volumeRatio ?? -1;
        case 'score':  return m.score;
        default:       return m.pressure;
      }
    };
    rows.sort((a, b) => {
      const av = get(a), bv = get(b);
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [metrics, classFilter, fltOutperform, fltAccel, fltBreadth, fltAbove50, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  }
  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey !== k ? <ChevronsUpDown size={10} className="inline opacity-40" />
    : sortDir === 'desc' ? <ChevronDown size={10} className="inline" /> : <ChevronUp size={10} className="inline" />;

  const drill = selectedEtf ? metrics.find(m => m.etf === selectedEtf) ?? null : null;
  const maxAbsPressure = Math.max(20, ...metrics.map(m => Math.abs(m.pressure)));

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <ArrowLeftRight size={16} className="text-blue-400" />
              Sector Rotation
            </h2>
            <p className="text-xs text-zinc-500 mt-1">Track where market leadership and capital are moving.</p>
          </div>
          <div className="flex items-center gap-4 text-xs tabular-nums flex-wrap">
            {spy && (
              <div>
                <span className="text-zinc-500">SPY </span>
                <span className="text-zinc-100 font-semibold">${spy.price.toFixed(2)}</span>
                <span className={`ml-1.5 font-medium ${spy.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {spy.changePct >= 0 ? '+' : ''}{spy.changePct.toFixed(2)}%
                </span>
              </div>
            )}
            <span className={`font-medium ${usMarketStatus() === 'OPEN' ? 'text-emerald-400' : 'text-zinc-500'}`}>
              Market: {usMarketStatus()}
            </span>
            {updatedAt && <span className="text-zinc-600">Updated {updatedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</span>}
            <button
              onClick={() => load(true)}
              disabled={loading}
              className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors px-2 py-1 rounded-lg hover:bg-zinc-800 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1 flex-wrap">
          {(['1D', '5D', '1M', '3M', '6M', '1Y'] as Timeframe[]).map(t => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${tf === t ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
            >
              {t}
            </button>
          ))}
          <span className="text-xs text-zinc-600 ml-2">display emphasis — scores always blend multiple timeframes</span>

          {/* selected-sector breadcrumb */}
          {drill && (
            <span className="ml-auto flex items-center gap-2 text-xs bg-blue-500/10 border border-blue-500/30 rounded-lg px-2.5 py-1">
              <span className="text-zinc-400">Selected:</span>
              <span className="font-semibold text-blue-300">{drill.name} — {drill.etf}</span>
              <button onClick={scrollToDrill} className="flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium">
                <List size={11} /> View Stocks
              </button>
              <button onClick={() => setSelectedEtf(null)} className="text-zinc-500 hover:text-zinc-300"><X size={11} /></button>
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-800/40 rounded-xl p-4 text-sm text-red-400 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => load(true)} className="text-xs bg-red-900/40 hover:bg-red-900/60 px-3 py-1.5 rounded-lg transition-colors">Retry</button>
        </div>
      )}

      {loading && (
        <div className="card py-10 text-center">
          <div className="inline-flex items-center gap-3 text-zinc-400 text-sm">
            <RefreshCw size={16} className="animate-spin text-blue-400" />
            Loading sector data (12 ETFs + constituents)…
          </div>
        </div>
      )}

      {!loading && !error && metrics.length > 0 && (
        <>
          {missing.length > 0 && (
            <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl px-4 py-2.5 text-xs text-amber-400">
              Data unavailable for: {missing.join(', ')} — these sectors are excluded from rankings this session.
            </div>
          )}

          {/* ── ROW 2: WHERE MONEY IS MOVING ─────────────────────────────────── */}
          <div className="card">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest flex items-center gap-2">
                Where Money Is Moving
                <InfoTip text="This view estimates market rotation using price, relative strength, momentum, volume and breadth. It does not represent reported dollar fund flows." />
              </h3>
              <span className="text-xs text-zinc-600">Rotation Pressure · −100 to +100</span>
            </div>
            <div className="text-xs text-zinc-600 mb-4">Estimated from price, relative strength, momentum, breadth &amp; volume — not literal fund flows</div>

            {/* summary trio */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
              <div className="bg-emerald-950/25 border border-emerald-900/40 rounded-xl p-3">
                <div className="text-xs font-semibold text-emerald-400 mb-2 flex items-center gap-1.5"><TrendingUp size={12} /> STRONGEST ROTATION IN</div>
                {topIn.length === 0 ? <div className="text-xs text-zinc-600">No sectors with positive pressure</div> : topIn.map((m, i) => (
                  <div key={m.etf} className="flex items-center justify-between text-xs py-0.5 tabular-nums">
                    <span className="text-zinc-300">{i + 1}. {m.name}</span>
                    <span className="text-emerald-400 font-semibold flex items-center gap-1">+{m.pressure} <TrendArrowIcon arrow={m.trendArrow} /></span>
                  </div>
                ))}
              </div>
              <div className="bg-red-950/25 border border-red-900/40 rounded-xl p-3">
                <div className="text-xs font-semibold text-red-400 mb-2 flex items-center gap-1.5"><TrendingDown size={12} /> STRONGEST ROTATION OUT</div>
                {topOut.length === 0 ? <div className="text-xs text-zinc-600">No sectors with negative pressure</div> : topOut.map((m, i) => (
                  <div key={m.etf} className="flex items-center justify-between text-xs py-0.5 tabular-nums">
                    <span className="text-zinc-300">{i + 1}. {m.name}</span>
                    <span className="text-red-400 font-semibold flex items-center gap-1">{m.pressure} <TrendArrowIcon arrow={m.trendArrow} /></span>
                  </div>
                ))}
              </div>
              <div className="bg-blue-950/25 border border-blue-900/40 rounded-xl p-3">
                <div className="text-xs font-semibold text-blue-400 mb-2">BIGGEST CHANGE (5D)</div>
                {biggestChange && biggestChange.pressureDelta.d5 != null ? (
                  <>
                    <div className="text-sm font-bold text-zinc-100">{biggestChange.name}</div>
                    <div className={`text-xs tabular-nums mt-0.5 font-semibold ${biggestChange.pressureDelta.d5 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {signedInt(biggestChange.pressureDelta.d5)} Rotation Pressure over 5 trading days
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 tabular-nums">
                      {biggestChange.pressureSeries.length > 6 ? signedInt(biggestChange.pressureSeries[biggestChange.pressureSeries.length - 6]) : '—'} → {signedInt(biggestChange.pressure)}
                    </div>
                  </>
                ) : <div className="text-xs text-zinc-600">N/A</div>}
              </div>
            </div>

            {/* diverging bars */}
            <div className="flex items-center justify-between text-xs font-semibold mb-2 px-1">
              <span className="text-red-400">← ROTATION OUT</span>
              <span className="text-emerald-400">ROTATION IN →</span>
            </div>
            <div className="space-y-1.5">
              {byPressure.map(m => {
                const widthPct = (Math.abs(m.pressure) / maxAbsPressure) * 100;
                const pos = m.pressure >= 0;
                const selected = selectedEtf === m.etf;
                return (
                  <div key={m.etf} className="relative group">
                    <button
                      onClick={() => selectSector(m.etf)}
                      className={`w-full flex items-center gap-2 rounded-lg px-1 py-0.5 transition-colors ${selected ? 'bg-blue-500/10 ring-1 ring-blue-500/40' : 'hover:bg-zinc-800/40'}`}
                    >
                      <span className={`w-24 text-right text-xs truncate shrink-0 ${selected ? 'text-blue-300 font-semibold' : 'text-zinc-400'}`}>{m.def.short}</span>
                      <PressureSpark values={m.pressureSeries} />
                      <div className="flex-1 flex items-center h-5">
                        <div className="w-1/2 flex justify-end">
                          {!pos && <div className="h-3.5 rounded-l bg-gradient-to-l from-red-500 to-red-500/40" style={{ width: `${widthPct}%` }} />}
                        </div>
                        <div className="w-px h-5 bg-zinc-700 shrink-0" />
                        <div className="w-1/2 flex justify-start">
                          {pos && <div className="h-3.5 rounded-r bg-gradient-to-r from-emerald-500 to-emerald-500/40" style={{ width: `${widthPct}%` }} />}
                        </div>
                      </div>
                      <span className={`w-14 text-right text-xs font-bold tabular-nums shrink-0 flex items-center justify-end gap-1 ${pressureColor(m.pressure)}`}>
                        {signedInt(m.pressure)} <TrendArrowIcon arrow={m.trendArrow} />
                      </span>
                      <span className={`w-14 text-right text-[11px] tabular-nums shrink-0 ${m.pressureDelta.d5 == null ? 'text-zinc-700' : m.pressureDelta.d5 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {m.pressureDelta.d5 != null ? `${signedInt(m.pressureDelta.d5)}/5D` : '—'}
                      </span>
                      <span className="w-12 text-right text-xs text-zinc-600 tabular-nums shrink-0 hidden lg:block">{fmtPctS(m.ret[tf])}</span>
                    </button>
                    <div className="hidden group-hover:block absolute z-30 left-32 top-full mt-1 bg-zinc-900 border border-zinc-700 rounded-xl p-3 shadow-xl w-72 pointer-events-none">
                      <SectorTooltipBody m={m} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 text-xs text-zinc-600 text-right">click a sector to select it everywhere · click again to view its stocks · {tf} return at right</div>
          </div>

          {/* ── ROW 3: Market Regime ─────────────────────────────────────────── */}
          {regime && (
            <div className="card py-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3 text-xs">
                <div>
                  <div className="text-zinc-500 mb-0.5">Market Regime</div>
                  <div className={`font-bold text-sm ${regime.regime === 'Risk-On' ? 'text-emerald-400' : regime.regime === 'Risk-Off' ? 'text-red-400' : 'text-amber-400'}`}>{regime.regime}</div>
                </div>
                <div><div className="text-zinc-500 mb-0.5">Leader</div><div className="font-semibold text-zinc-200">{regime.leader ?? '—'}</div></div>
                <div><div className="text-zinc-500 mb-0.5">Fastest Improving</div><div className="font-semibold text-blue-400">{regime.fastestImproving ?? '—'}</div></div>
                <div>
                  <div className="text-zinc-500 mb-0.5 flex items-center gap-1">Weakening Leader <InfoTip text="A sector with a still-high Rotation Score whose Rotation Pressure is negative or falling fast — a leader losing its bid." /></div>
                  <div className="font-semibold text-amber-400" title={regime.weakeningLeaderDetail ?? undefined}>{regime.weakeningLeader ?? 'None'}</div>
                  {regime.weakeningLeaderDetail && <div className="text-zinc-600 tabular-nums mt-0.5">{regime.weakeningLeaderDetail}</div>}
                </div>
                <div><div className="text-zinc-500 mb-0.5">Lagging</div><div className="font-semibold text-red-400">{regime.lagging ?? '—'}</div></div>
                <div>
                  <div className="text-zinc-500 mb-0.5 flex items-center gap-1">Breadth <InfoTip text="Percentage of the 11 sectors outperforming SPY over the last month." /></div>
                  <div className="font-semibold text-zinc-200 tabular-nums">{regime.breadthPct != null ? `${regime.breadthPct}% positive` : 'N/A'}</div>
                </div>
              </div>
              <div className="mt-2.5 pt-2.5 border-t border-zinc-800 text-xs text-zinc-500">
                <span className="text-zinc-600">Why:</span> {regime.reason}
              </div>
            </div>
          )}

          {/* ── ROW 4: Rotation Matrix ───────────────────────────────────────── */}
          <div className="card">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest flex items-center gap-2">
                Sector Rotation Matrix
                <InfoTip text="Y: relative strength vs SPY. X: momentum of relative strength. Sectors tend to rotate clockwise: Lagging → Improving → Leading → Weakening. Select or hover a sector to emphasize its trail." />
              </h3>
              <div className="flex items-center gap-1">
                {(['1M', '3M', '6M'] as MatrixTimeframe[]).map(t => (
                  <button key={t} onClick={() => setMatrixTf(t)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${matrixTf === t ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <RotationMatrix metrics={metrics} tf={matrixTf} selectedEtf={selectedEtf} onSelect={selectSector} />
            <div className="flex items-center justify-between text-xs text-zinc-600 mt-1 px-2">
              <span>← RS momentum falling</span>
              <span>trails = last ~4 weekly observations</span>
              <span>RS momentum rising →</span>
            </div>
          </div>

          {/* ── ROW 5: Sector scorecards ─────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest">Sector Scorecards</h3>
              <select value={cardSort} onChange={e => setCardSort(e.target.value as CardSort)} className="input-base text-xs w-44">
                <option value="pressure">Sort: Rotation Pressure</option>
                <option value="score">Sort: Rotation Score</option>
                <option value="ret">Sort: {tf} Return</option>
                <option value="rs">Sort: RS vs SPY (1M)</option>
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {sortedCards.map(m => {
                const selected = selectedEtf === m.etf;
                return (
                  <button key={m.etf} onClick={() => selectSector(m.etf)}
                    className={`card text-left transition-colors p-3.5 ${selected ? 'border-blue-500/60 bg-blue-500/5' : 'hover:border-zinc-600'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <div className="text-xs font-bold text-zinc-100 uppercase">{m.name}</div>
                        <div className="text-xs text-zinc-500 font-mono">{m.etf} · ${m.price.toFixed(2)}</div>
                      </div>
                      <span className={`text-xs font-bold border rounded px-1.5 py-0.5 ${classColor[m.classification]}`}>
                        {m.classification.toUpperCase()}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-1 text-xs tabular-nums mb-2">
                      {(['1D', '5D', '1M', '3M'] as Timeframe[]).map(t => (
                        <div key={t}>
                          <div className="text-zinc-600">{t}</div>
                          <div className={`font-medium ${pctColor(m.ret[t])} ${t === tf ? 'underline underline-offset-2' : ''}`}>{fmtPctS(m.ret[t])}</div>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between text-xs tabular-nums">
                      <span className="text-zinc-500">vs SPY <span className={pctColor(m.rs['1M'])}>{fmtPctS(m.rs['1M'])}</span></span>
                      <span className="text-zinc-500">Rot <span className="text-zinc-200 font-semibold">{m.score}</span></span>
                      <span className={`font-bold flex items-center gap-0.5 ${pressureColor(m.pressure)}`} title={`5D pressure change: ${signedInt(m.pressureDelta.d5)}`}>
                        {signedInt(m.pressure)} <TrendArrowIcon arrow={m.trendArrow} />
                        {m.pressureDelta.d5 != null && (
                          <span className={`text-[10px] font-medium ml-0.5 ${m.pressureDelta.d5 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{signedInt(m.pressureDelta.d5)}</span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs mt-1.5">
                      <span className="text-zinc-600">Vol {m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A'}</span>
                      <span className="text-zinc-600" title={breadthTitle(m)}>
                        Br {m.breadth ? <>{m.breadth.score}{m.breadth.change != null && <span className={m.breadth.change >= 0 ? 'text-emerald-600' : 'text-red-600'}> ({signedInt(m.breadth.change)})</span>}</> : '—'}
                      </span>
                      <MomentumBadge m={m.momentum} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── ROW 6: detailed table ────────────────────────────────────────── */}
          <div className="card overflow-hidden p-0">
            <div className="px-4 pt-4 pb-3 flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest">Sector Rotation Table</h3>
              <div className="flex items-center gap-1.5 flex-wrap text-xs">
                {(['ALL', 'Leading', 'Improving', 'Neutral', 'Weakening', 'Lagging'] as const).map(c => (
                  <button key={c} onClick={() => setClassFilter(c)}
                    className={`px-2 py-1 rounded-lg transition-colors ${classFilter === c ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}>
                    {c}
                  </button>
                ))}
                <span className="w-px h-4 bg-zinc-700 mx-1" />
                {[
                  { on: fltOutperform, set: setFltOutperform, label: '> SPY' },
                  { on: fltAccel, set: setFltAccel, label: 'Accelerating' },
                  { on: fltBreadth, set: setFltBreadth, label: 'Breadth 50+' },
                  { on: fltAbove50, set: setFltAbove50, label: '> 50DMA' },
                ].map(f => (
                  <button key={f.label} onClick={() => f.set(v => !v)}
                    className={`px-2 py-1 rounded-lg transition-colors ${f.on ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/40 text-zinc-500">
                    {([
                      ['name', 'Sector'], ['ret1D', '1D'], ['ret5D', '5D'], ['ret1M', '1M'], ['ret3M', '3M'], ['ret6M', '6M'],
                      ['rs5D', 'vs SPY 5D'], ['rs1M', 'vs SPY 1M'], ['rs3M', 'vs SPY 3M'],
                      ['breadth', 'Breadth'], ['breadthD5', 'Br Δ5D'], ['volume', 'Vol'], ['pressure', 'Pressure'], ['score', 'Score'],
                    ] as [SortKey, string][]).map(([k, label]) => (
                      <th key={k} className={`th cursor-pointer select-none whitespace-nowrap ${k === 'name' ? 'text-left' : 'text-right'}`} onClick={() => toggleSort(k)}>
                        {label} <SortIcon k={k} />
                      </th>
                    ))}
                    <th className="th text-right">Momentum</th>
                    <th className="th text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {tableRows.map(m => {
                    const selected = selectedEtf === m.etf;
                    return (
                      <tr key={m.etf} className={`tr-hover cursor-pointer ${selected ? 'bg-blue-500/5' : ''}`} onClick={() => selectSector(m.etf)}>
                        <td className="td">
                          <span className={`font-semibold ${selected ? 'text-blue-300' : 'text-zinc-200'}`}>{m.name}</span>
                          <span className="text-zinc-600 font-mono ml-1.5">{m.etf}</span>
                          <span className="text-zinc-600 ml-1.5 tabular-nums">${m.price.toFixed(2)}</span>
                        </td>
                        {(['1D', '5D', '1M', '3M', '6M'] as Timeframe[]).map(t => (
                          <td key={t} className={`td text-right tabular-nums ${pctColor(m.ret[t])}`}>{fmtPctS(m.ret[t])}</td>
                        ))}
                        {(['5D', '1M', '3M'] as const).map(t => (
                          <td key={t} className={`td text-right tabular-nums ${pctColor(m.rs[t])}`}>{fmtPctS(m.rs[t])}</td>
                        ))}
                        <td className="td text-right tabular-nums text-zinc-300" title={breadthTitle(m)}>{m.breadth?.score ?? <span className="text-zinc-600">unavail.</span>}</td>
                        <td className={`td text-right tabular-nums ${m.breadth?.change == null ? 'text-zinc-600' : m.breadth.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {m.breadth?.change != null ? signedInt(m.breadth.change) : '—'}
                        </td>
                        <td className="td text-right tabular-nums text-zinc-300">{m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A'}</td>
                        <td className={`td text-right tabular-nums font-bold ${pressureColor(m.pressure)}`}>
                          <span className="inline-flex items-center gap-1">{signedInt(m.pressure)} <TrendArrowIcon arrow={m.trendArrow} /></span>
                          {m.pressureDelta.d5 != null && (
                            <div className={`text-[10px] font-medium ${m.pressureDelta.d5 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>Δ {signedInt(m.pressureDelta.d5)}</div>
                          )}
                        </td>
                        <td className="td text-right tabular-nums font-semibold text-zinc-200">{m.score}</td>
                        <td className="td text-right"><MomentumBadge m={m.momentum} /></td>
                        <td className="td text-right">
                          <span className={`text-xs font-bold border rounded px-1.5 py-0.5 ${classColor[m.classification]}`}>{m.classification}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {tableRows.length === 0 && (
                    <tr><td colSpan={17} className="td text-center text-zinc-600 py-6">No sectors match the current filters</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── ROW 7: Biggest Rotation Changes ──────────────────────────────── */}
          <div className="card">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest flex items-center gap-2">
                Biggest Rotation Changes
                <InfoTip text="Sectors ranked by the CHANGE in stored Rotation Pressure — where conditions are shifting fastest, regardless of absolute level." />
              </h3>
              <div className="flex items-center gap-1">
                {([['d1', '1 Day'], ['d5', '5 Days'], ['d20', '20 Days']] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setChangeTf(k)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${changeTf === k ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[...metrics]
                .filter(m => m.pressureDelta[changeTf] != null)
                .sort((a, b) => Math.abs(b.pressureDelta[changeTf]!) - Math.abs(a.pressureDelta[changeTf]!))
                .slice(0, 6)
                .map(m => {
                  const d = m.pressureDelta[changeTf]!;
                  const n = changeTf === 'd1' ? 1 : changeTf === 'd5' ? 5 : 20;
                  const from = m.pressureSeries.length > n ? m.pressureSeries[m.pressureSeries.length - 1 - n] : null;
                  return (
                    <button key={m.etf} onClick={() => selectSector(m.etf)}
                      className={`flex items-center justify-between border rounded-lg px-3 py-2 transition-colors text-left ${selectedEtf === m.etf ? 'bg-blue-500/10 border-blue-500/40' : 'bg-zinc-800/40 hover:bg-zinc-800/70 border-zinc-800'}`}>
                      <div>
                        <div className="text-xs font-semibold text-zinc-200">{m.name}</div>
                        <div className="text-xs text-zinc-600 tabular-nums">{from != null ? signedInt(from) : '—'} → {signedInt(m.pressure)}</div>
                      </div>
                      <span className={`text-sm font-bold tabular-nums ${d >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{signedInt(d)}</span>
                    </button>
                  );
                })}
            </div>
          </div>

          {/* ── ROW 8: Rotation Signals ──────────────────────────────────────── */}
          {metrics.some(m => m.signal) && (
            <div className="card">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest mb-3">Rotation Signals</h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {byPressure.filter(m => m.signal).map(m => {
                  const s = m.signal!;
                  const col = s.direction === 'in' ? 'text-emerald-400 border-l-emerald-500' : s.direction === 'out' ? 'text-red-400 border-l-red-500' : 'text-blue-400 border-l-blue-500';
                  const arrow = s.direction === 'in' ? '↑' : s.direction === 'out' ? '↓' : '→';
                  const selected = selectedEtf === m.etf;
                  return (
                    <button key={m.etf} onClick={() => selectSector(m.etf)}
                      className={`text-left bg-zinc-800/30 border border-zinc-800 border-l-4 rounded-lg p-3 transition-colors ${col.split(' ')[1]} ${selected ? 'ring-1 ring-blue-500/40' : 'hover:bg-zinc-800/50'}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-zinc-100">{m.name} — {m.etf}</span>
                        <span className={`text-xs font-bold ${col.split(' ')[0]}`}>{arrow} {s.label}</span>
                      </div>
                      <div className="text-xs text-zinc-500 mb-1.5 tabular-nums">Rotation Pressure: <span className={pressureColor(m.pressure)}>{signedInt(m.pressure)}</span></div>
                      <ul className="space-y-0.5">
                        {s.reasons.map((r, i) => <li key={i} className="text-xs text-zinc-400">• {r}</li>)}
                      </ul>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── ROW 9: Rotation Opportunities ────────────────────────────────── */}
          {opportunities.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest mb-1">Rotation Opportunities</h3>
              <div className="text-xs text-zinc-600 mb-3">Informational — not buy/sell recommendations</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {opportunities.map(o => (
                  <button key={`${o.etf}-${o.category}`} onClick={() => selectSector(o.etf)}
                    className={`card p-3.5 text-left transition-colors ${selectedEtf === o.etf ? 'border-blue-500/60 bg-blue-500/5' : 'hover:border-zinc-600'}`}>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-xs font-bold text-zinc-100">{o.name} <span className="text-zinc-600 font-mono">{o.etf}</span></span>
                      <span className={`text-[10px] font-bold whitespace-nowrap ${o.direction === 'in' ? 'text-emerald-400' : 'text-red-400'}`}>{o.category}</span>
                    </div>
                    <div className="text-xs text-zinc-500 tabular-nums mb-1">
                      Score {o.score} · Pressure <span className={pressureColor(o.pressure)}>{signedInt(o.pressure)}</span>
                      {o.pressureDelta5 != null && <span className={o.pressureDelta5 >= 0 ? 'text-emerald-600' : 'text-red-600'}> (Δ5D {signedInt(o.pressureDelta5)})</span>}
                    </div>
                    <div className="text-xs text-zinc-500 tabular-nums mb-1.5">
                      Breadth {o.breadth ?? '—'}{o.breadthChange != null && <span className={o.breadthChange >= 0 ? 'text-emerald-600' : 'text-red-600'}> ({signedInt(o.breadthChange)})</span>}
                      {' · '}<MomentumBadge m={o.momentum} />
                    </div>
                    {o.reasons.slice(0, 3).map((r, i) => <div key={i} className="text-xs text-zinc-500">• {r}</div>)}
                    {o.participants.length > 0 && (
                      <div className="text-xs text-zinc-400 mt-1.5">Participating: <span className="font-mono text-blue-400">{o.participants.join(' · ')}</span></div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── ROW 10: Drill-down ───────────────────────────────────────────── */}
          <div ref={drillRef}>
            {drill ? (
              <SectorDrillDown
                m={drill}
                quotes={quotes}
                conHists={conHists}
                sectorCloses={histories.get(drill.etf)?.closes ?? null}
                spyCloses={histories.get(BENCHMARK_ETF)?.closes ?? null}
                onClose={() => setSelectedEtf(null)}
                onOpenTicker={(ticker) => setDrawer({ ticker, currency: 'USD' })}
              />
            ) : (
              <div className="card py-6 text-center text-xs text-zinc-600">
                Select a sector anywhere above to load its stocks here.
              </div>
            )}
          </div>
        </>
      )}

      {drawer && (
        <FundamentalsDrawer ticker={drawer.ticker} currency={drawer.currency} onClose={() => setDrawer(null)} />
      )}
    </div>
  );
}

// ─── Rotation Matrix (recharts scatter with quadrants + trails) ──────────────

const MATRIX_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6366f1', '#14b8a6'];

function RotationMatrix({ metrics, tf, selectedEtf, onSelect }: {
  metrics: SectorMetrics[];
  tf: MatrixTimeframe;
  selectedEtf: string | null;
  onSelect: (etf: string) => void;
}) {
  const [hoverEtf, setHoverEtf] = useState<string | null>(null);
  const focusEtf = hoverEtf ?? selectedEtf;

  const series = metrics.map((m, i) => ({
    m,
    color: MATRIX_COLORS[i % MATRIX_COLORS.length],
    data: [
      ...m.matrix[tf].trail.map(p => ({ ...p, etf: m.etf, isLast: false })),
      { x: m.matrix[tf].x, y: m.matrix[tf].y, etf: m.etf, isLast: true },
    ],
  }));

  const allX = series.flatMap(s => s.data.map(d => d.x));
  const allY = series.flatMap(s => s.data.map(d => d.y));
  const xMax = Math.max(2, ...allX.map(Math.abs)) * 1.15;
  const yMax = Math.max(2, ...allY.map(Math.abs)) * 1.15;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderShape = (color: string, etf: string) => (props: any) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return <g />;
    const focused = focusEtf === etf;
    const muted = focusEtf != null && !focused;

    if (!payload.isLast) {
      // trail point: small, subdued; emphasized on focus, faded when muted
      const r = focused ? 2.5 : 1.5;
      const op = muted ? 0.08 : focused ? 0.55 : 0.22;
      return <circle cx={cx} cy={cy} r={r} fill={color} fillOpacity={op} />;
    }
    const dotR = focused ? 7 : 5.5;
    const dotOp = muted ? 0.35 : 1;
    const labelFill = muted ? '#52525b' : '#e4e4e7';
    return (
      <g style={{ cursor: 'pointer' }}
        onClick={() => onSelect(etf)}
        onMouseEnter={() => setHoverEtf(etf)}
        onMouseLeave={() => setHoverEtf(h => h === etf ? null : h)}>
        <circle cx={cx} cy={cy} r={dotR} fill={color} fillOpacity={dotOp} stroke="#18181b" strokeWidth={1.5} />
        <text x={cx + dotR + 3} y={cy + 3.5} fill={labelFill} fontSize={focused ? 12 : 11} fontWeight={700}>{etf}</text>
      </g>
    );
  };

  return (
    <div className="h-96 relative">
      <span className="absolute top-2 left-14 text-xs font-bold text-blue-500/60 z-10">IMPROVING</span>
      <span className="absolute top-2 right-4 text-xs font-bold text-emerald-500/60 z-10">LEADING</span>
      <span className="absolute bottom-8 left-14 text-xs font-bold text-red-500/60 z-10">LAGGING</span>
      <span className="absolute bottom-8 right-4 text-xs font-bold text-amber-500/60 z-10">WEAKENING</span>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 12, right: 40, bottom: 8, left: -18 }}>
          <XAxis type="number" dataKey="x" domain={[-xMax, xMax]} tick={{ fill: '#71717a', fontSize: 10 }} stroke="#3f3f46" tickFormatter={(v: number) => v.toFixed(1)}>
            <Label value="RS Momentum" position="insideBottom" offset={-4} fill="#52525b" fontSize={10} />
          </XAxis>
          <YAxis type="number" dataKey="y" domain={[-yMax, yMax]} tick={{ fill: '#71717a', fontSize: 10 }} stroke="#3f3f46" tickFormatter={(v: number) => v.toFixed(0)}>
            <Label value="RS vs SPY" angle={-90} position="insideLeft" offset={28} fill="#52525b" fontSize={10} />
          </YAxis>
          <ReferenceLine x={0} stroke="#3f3f46" />
          <ReferenceLine y={0} stroke="#3f3f46" />
          <ReTooltip
            cursor={false}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content={({ payload }: any) => {
              const p = payload?.[0]?.payload;
              if (!p?.isLast) return null;
              const m = metrics.find(x => x.etf === p.etf);
              if (!m) return null;
              return (
                <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 shadow-xl">
                  <SectorTooltipBody m={m} tf={tf} />
                </div>
              );
            }}
          />
          {series.map(s => {
            const focused = focusEtf === s.m.etf;
            const muted = focusEtf != null && !focused;
            return (
              <Scatter key={s.m.etf} data={s.data} fill={s.color}
                line={{ stroke: s.color, strokeWidth: focused ? 1.5 : 0.75, strokeOpacity: muted ? 0.05 : focused ? 0.6 : 0.15 }}
                shape={renderShape(s.color, s.m.etf)} isAnimationActive={false} />
            );
          })}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Sector drill-down ───────────────────────────────────────────────────────

function fmtCap(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  return `$${(n / 1e6).toFixed(0)}M`;
}

function MaDots({ r }: { r: ConstituentRow }) {
  const dot = (v: boolean | null, label: string) => (
    <span
      title={`${label}: ${v == null ? 'N/A' : v ? 'above' : 'below'}`}
      className={`inline-block w-2 h-2 rounded-full ${v == null ? 'bg-zinc-700' : v ? 'bg-emerald-500' : 'bg-red-500/70'}`}
    />
  );
  return <span className="inline-flex items-center gap-1">{dot(r.above20, '20DMA')}{dot(r.above50, '50DMA')}{dot(r.above200, '200DMA')}</span>;
}

type ConSortKey = 'symbol' | 'price' | 'marketCap' | 'ret1D' | 'ret5D' | 'ret1M' | 'ret3M' | 'rsVsSector1M' | 'volRatio' | 'revenueGrowth' | 'epsGrowth' | 'forwardPE' | 'netMargin' | 'participation';

interface FilterDef { key: string; label: string; on: boolean; set: (v: boolean | ((p: boolean) => boolean)) => void }

function SectorDrillDown({ m, quotes, conHists, sectorCloses, spyCloses, onClose, onOpenTicker }: {
  m: SectorMetrics;
  quotes: Map<string, ConstituentQuote>;
  conHists: Map<string, number[]>;
  sectorCloses: number[] | null;
  spyCloses: number[] | null;
  onClose: () => void;
  onOpenTicker: (ticker: string) => void;
}) {
  const [funds, setFunds] = useState<Map<string, ConstituentFundamentals>>(new Map());
  const [fundsLoading, setFundsLoading] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<ConSortKey>('participation');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // All quality filters OFF by default — the drill-down must never open empty
  const [fProfit, setFProfit]     = useState(false);
  const [fCap, setFCap]           = useState(false);
  const [fRev, setFRev]           = useState(false);
  const [fEps, setFEps]           = useState(false);
  const [fAbove20, setFAbove20]   = useState(false);
  const [fAbove50, setFAbove50]   = useState(false);
  const [fAbove200, setFAbove200] = useState(false);
  const [fHighRs, setFHighRs]     = useState(false);
  const [fVol, setFVol]           = useState(false);

  const filters: FilterDef[] = [
    { key: 'profit',   label: 'Profitable',     on: fProfit,   set: setFProfit },
    { key: 'cap',      label: 'Cap > $2B',      on: fCap,      set: setFCap },
    { key: 'rev',      label: '+Rev Growth',    on: fRev,      set: setFRev },
    { key: 'eps',      label: '+EPS Growth',    on: fEps,      set: setFEps },
    { key: 'a20',      label: '> 20DMA',        on: fAbove20,  set: setFAbove20 },
    { key: 'a50',      label: '> 50DMA',        on: fAbove50,  set: setFAbove50 },
    { key: 'a200',     label: '> 200DMA',       on: fAbove200, set: setFAbove200 },
    { key: 'rs',       label: 'High Rel Strength', on: fHighRs, set: setFHighRs },
    { key: 'vol',      label: 'High Volume',    on: fVol,      set: setFVol },
  ];
  const activeFilters = filters.filter(f => f.on);
  const clearFilters = () => filters.forEach(f => f.set(false));

  // Reset lazy fundamentals when the sector changes
  useEffect(() => {
    let live = true;
    setFundsLoading(true);
    Promise.all(m.def.constituents.map(async t => ({ t, f: await fetchFundamentals(t) })))
      .then(rows => {
        if (!live) return;
        const map = new Map<string, ConstituentFundamentals>();
        rows.forEach(({ t, f }) => { if (f) map.set(t, f); });
        setFunds(map);
      })
      .finally(() => { if (live) setFundsLoading(false); });
    return () => { live = false; };
  }, [m.def]);

  async function addToWatch(ticker: string) {
    const q = quotes.get(ticker);
    const closes = conHists.get(ticker);
    const item: WatchItem = {
      id: newId(),
      ticker,
      conviction: 'MEDIUM' as Conviction,
      notes: `From Sector Rotation — ${m.name} (${m.etf}), pressure ${signedInt(m.pressure)}`,
      watch_price: q?.price ?? (closes ? closes[closes.length - 1] : null),
      watch_date: new Date().toISOString().split('T')[0],
      analyst_target: null,
      target_entry: null,
      created_at: nowIso(),
    };
    try {
      await storage.insert('watch_items', item);
      setAdded(prev => new Set(prev).add(ticker));
    } catch { /* likely duplicate — ignore */ }
  }

  const baseRows = useMemo(
    () => computeConstituentRows(m.def, sectorCloses, spyCloses, quotes, conHists),
    [m.def, sectorCloses, spyCloses, quotes, conHists],
  );

  const rows = useMemo(() => {
    let rs = [...baseRows];
    if (fProfit)   rs = rs.filter(r => (r.epsTTM ?? -1) > 0);
    if (fCap)      rs = rs.filter(r => (r.marketCap ?? 0) > 2e9);
    if (fRev)      rs = rs.filter(r => (funds.get(r.symbol)?.revenueGrowth ?? -1) > 0);
    if (fEps)      rs = rs.filter(r => (funds.get(r.symbol)?.epsGrowth ?? -1) > 0);
    if (fAbove20)  rs = rs.filter(r => r.above20 === true);
    if (fAbove50)  rs = rs.filter(r => r.above50 === true);
    if (fAbove200) rs = rs.filter(r => r.above200 === true);
    if (fHighRs)   rs = rs.filter(r => (r.rsVsSector1M ?? -1) > 0);
    if (fVol)      rs = rs.filter(r => (r.volRatio ?? 0) > VOLUME_LEVELS.elevated);

    const get = (r: ConstituentRow): number | string => {
      switch (sortKey) {
        case 'symbol':        return r.symbol;
        case 'price':         return r.price ?? -1;
        case 'ret1D':         return r.ret1D ?? -99;
        case 'ret5D':         return r.ret5D ?? -99;
        case 'ret1M':         return r.ret1M ?? -99;
        case 'ret3M':         return r.ret3M ?? -99;
        case 'rsVsSector1M':  return r.rsVsSector1M ?? -99;
        case 'volRatio':      return r.volRatio ?? -1;
        case 'revenueGrowth': return funds.get(r.symbol)?.revenueGrowth ?? -999;
        case 'epsGrowth':     return funds.get(r.symbol)?.epsGrowth ?? -999;
        case 'forwardPE':     return r.forwardPE ?? 9999;
        case 'netMargin':     return funds.get(r.symbol)?.netMargin ?? -999;
        case 'participation': return r.participation ?? -1;
        default:              return r.marketCap ?? -1;
      }
    };
    rs.sort((a, b) => {
      const av = get(a), bv = get(b);
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rs;
  }, [baseRows, funds, fProfit, fCap, fRev, fEps, fAbove20, fAbove50, fAbove200, fHighRs, fVol, sortKey, sortDir]);

  function toggle(k: ConSortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  }
  const SIcon = ({ k }: { k: ConSortKey }) =>
    sortKey !== k ? <ChevronsUpDown size={10} className="inline opacity-40" />
    : sortDir === 'desc' ? <ChevronDown size={10} className="inline" /> : <ChevronUp size={10} className="inline" />;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest">
          {m.name} — <span className="font-mono text-blue-400">{m.etf}</span> Drill-Down
        </h3>
        <button onClick={onClose} className="btn-ghost p-1.5"><X size={14} /></button>
      </div>

      {/* sector stats */}
      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2 mb-4 text-xs tabular-nums">
        {[
          ['Price', `$${m.price.toFixed(2)}`, 'text-zinc-100'],
          ['Pressure', `${signedInt(m.pressure)}${m.pressureDelta.d5 != null ? ` (Δ${signedInt(m.pressureDelta.d5)})` : ''}`, pressureColor(m.pressure)],
          ['Score', String(m.score), 'text-zinc-100'],
          ['1M', fmtPctS(m.ret['1M']), pctColor(m.ret['1M'])],
          ['3M', fmtPctS(m.ret['3M']), pctColor(m.ret['3M'])],
          ['vs SPY 1M', fmtPctS(m.rs['1M']), pctColor(m.rs['1M'])],
          ['Breadth', m.breadth ? `${m.breadth.score}${m.breadth.change != null ? ` (${signedInt(m.breadth.change)})` : ''}` : 'unavail.', 'text-zinc-100'],
          ['Volume', m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A', 'text-zinc-100'],
          ['Status', m.classification, classColor[m.classification].split(' ')[0]],
        ].map(([label, value, cls]) => (
          <div key={label as string} className="bg-zinc-800/50 rounded-lg p-2">
            <div className="text-zinc-500">{label}</div>
            <div className={`font-semibold mt-0.5 ${cls}`}>{value}</div>
          </div>
        ))}
      </div>

      {m.breadth && m.breadth.source === 'history' && (
        <div className="text-xs text-zinc-500 mb-4">
          Breadth across {m.breadth.count} tracked names:
          {m.breadth.above20Pct != null && <> {m.breadth.above20Pct}% &gt;20DMA ·</>}
          {m.breadth.above50Pct != null && <> {m.breadth.above50Pct}% &gt;50DMA ·</>}
          {m.breadth.above200Pct != null && <> {m.breadth.above200Pct}% &gt;200DMA ·</>}
          {m.breadth.pos5DPct != null && <> {m.breadth.pos5DPct}% positive 5D ·</>}
          {m.breadth.pos20DPct != null && <> {m.breadth.pos20DPct}% positive 20D</>}
        </div>
      )}

      {/* quality filters — all OFF by default */}
      <div className="flex items-center gap-1.5 flex-wrap text-xs mb-3">
        <span className="text-zinc-600 mr-1">Quality filters:</span>
        {filters.map(f => (
          <button key={f.key} onClick={() => f.set(v => !v)}
            className={`px-2 py-1 rounded-lg transition-colors ${f.on ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}>
            {f.label}
          </button>
        ))}
        {activeFilters.length > 0 && (
          <button onClick={clearFilters} className="px-2 py-1 rounded-lg text-amber-400 hover:bg-zinc-800 transition-colors font-medium">
            Clear Filters ({activeFilters.length})
          </button>
        )}
        {fundsLoading && <span className="text-zinc-600 ml-2 flex items-center gap-1"><RefreshCw size={10} className="animate-spin" /> loading fundamentals…</span>}
      </div>

      {/* constituents table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/40 text-zinc-500">
              {([
                ['symbol', 'Ticker'], ['participation', 'Part.'], ['price', 'Price'], ['marketCap', 'Mkt Cap'],
                ['ret1D', '1D'], ['ret5D', '5D'], ['ret1M', '1M'], ['ret3M', '3M'],
                ['rsVsSector1M', 'vs Sector 1M'], ['volRatio', 'Vol'],
              ] as [ConSortKey, string][]).map(([k, label]) => (
                <th key={k} className={`th cursor-pointer select-none whitespace-nowrap ${k === 'symbol' ? 'text-left' : 'text-right'}`} onClick={() => toggle(k)}>
                  {k === 'participation'
                    ? <span title="Participation Score (0–100): how strongly this stock is participating in the sector's move — relative strength vs the sector ETF, momentum, volume, and trend position.">{label} <SIcon k={k} /></span>
                    : <>{label} <SIcon k={k} /></>}
                </th>
              ))}
              <th className="th text-center">MA<span className="text-zinc-700 ml-0.5">20/50/200</span></th>
              {([
                ['revenueGrowth', 'Rev Gr'], ['epsGrowth', 'EPS Gr'], ['forwardPE', 'Fwd P/E'], ['netMargin', 'Margin'],
              ] as [ConSortKey, string][]).map(([k, label]) => (
                <th key={k} className="th text-right cursor-pointer select-none whitespace-nowrap" onClick={() => toggle(k)}>
                  {label} <SIcon k={k} />
                </th>
              ))}
              <th className="th text-right">Earnings</th>
              <th className="th text-right">Prof.</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map(r => {
              const f = funds.get(r.symbol) ?? null;
              return (
                <tr key={r.symbol} className="tr-hover">
                  <td className="td">
                    <button onClick={() => onOpenTicker(r.symbol)}
                      className="font-mono font-bold text-blue-400 hover:text-blue-300 hover:underline underline-offset-2">
                      {r.symbol}
                    </button>
                    <div className="text-zinc-600 truncate max-w-[130px]">{r.name}</div>
                  </td>
                  <td className="td text-right tabular-nums">
                    {r.participation == null ? <span className="text-zinc-600">—</span> : (
                      <span className={`font-bold ${r.participation >= 70 ? 'text-emerald-400' : r.participation >= 40 ? 'text-zinc-200' : 'text-red-400'}`}>{r.participation}</span>
                    )}
                  </td>
                  <td className="td text-right tabular-nums text-zinc-200">{r.price != null ? `$${r.price.toFixed(2)}` : '—'}</td>
                  <td className="td text-right tabular-nums text-zinc-300">{fmtCap(r.marketCap)}</td>
                  <td className={`td text-right tabular-nums ${pctColor(r.ret1D)}`}>{fmtPctS(r.ret1D, 2)}</td>
                  <td className={`td text-right tabular-nums ${pctColor(r.ret5D)}`}>{fmtPctS(r.ret5D)}</td>
                  <td className={`td text-right tabular-nums ${pctColor(r.ret1M)}`}>{fmtPctS(r.ret1M)}</td>
                  <td className={`td text-right tabular-nums ${pctColor(r.ret3M)}`}>{fmtPctS(r.ret3M)}</td>
                  <td className={`td text-right tabular-nums ${pctColor(r.rsVsSector1M)}`}>{fmtPctS(r.rsVsSector1M)}</td>
                  <td className="td text-right tabular-nums text-zinc-300">{r.volRatio != null ? `${r.volRatio.toFixed(2)}x` : 'N/A'}</td>
                  <td className="td text-center"><MaDots r={r} /></td>
                  <td className={`td text-right tabular-nums ${f?.revenueGrowth == null ? 'text-zinc-600' : f.revenueGrowth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{f?.revenueGrowth != null ? `${f.revenueGrowth.toFixed(1)}%` : 'N/A'}</td>
                  <td className={`td text-right tabular-nums ${f?.epsGrowth == null ? 'text-zinc-600' : f.epsGrowth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{f?.epsGrowth != null ? `${f.epsGrowth.toFixed(1)}%` : 'N/A'}</td>
                  <td className="td text-right tabular-nums text-zinc-300">{r.forwardPE != null ? `${r.forwardPE.toFixed(1)}x` : 'N/A'}</td>
                  <td className="td text-right tabular-nums text-zinc-300">{f?.netMargin != null ? `${f.netMargin.toFixed(1)}%` : 'N/A'}</td>
                  <td className="td text-right tabular-nums text-zinc-400">
                    {r.earningsTs != null ? new Date(r.earningsTs * 1000).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '—'}
                  </td>
                  <td className="td text-right">
                    {r.epsTTM == null ? <span className="text-zinc-600">—</span>
                      : r.epsTTM > 0 ? <span className="text-emerald-400">Yes</span>
                      : <span className="text-red-400">No</span>}
                  </td>
                  <td className="td text-right whitespace-nowrap">
                    <button
                      onClick={() => addToWatch(r.symbol)}
                      disabled={added.has(r.symbol)}
                      title="Add to Watch List"
                      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors ${added.has(r.symbol) ? 'text-emerald-500' : 'text-zinc-500 hover:text-blue-400 hover:bg-zinc-800'}`}
                    >
                      <Eye size={11} /> {added.has(r.symbol) ? 'Added' : 'Watch'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={19} className="td text-center py-8">
                  <div className="text-zinc-400 text-sm mb-2">No stocks match the current filters.</div>
                  {activeFilters.length > 0 && (
                    <>
                      <div className="text-zinc-600 text-xs mb-3">Active: {activeFilters.map(f => f.label).join(' · ')}</div>
                      <button onClick={clearFilters} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors">
                        Clear Filters
                      </button>
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-xs text-zinc-600 flex items-center gap-1">
        <AlertTriangle size={10} className="text-zinc-700" />
        Top {m.def.constituents.length} holdings tracked (centralized mapping — full index membership isn't available on the current data tier). Click a ticker for the fundamentals drawer.
      </div>
    </div>
  );
}
