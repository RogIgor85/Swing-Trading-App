import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  RefreshCw, ArrowLeftRight, ArrowUp, ArrowDown, ArrowRight, AlertTriangle,
  Info, TrendingUp, TrendingDown, Eye, X, ChevronUp, ChevronDown, ChevronsUpDown,
} from 'lucide-react';
import {
  ScatterChart, Scatter, XAxis, YAxis, ReferenceLine, Tooltip as ReTooltip,
  ResponsiveContainer, Label,
} from 'recharts';
import { storage, newId, nowIso } from '../../lib/storage';
import FundamentalsDrawer from '../FundamentalsDrawer';
import {
  fetchAllHistories, fetchConstituentQuotes, fetchSpyQuote, fetchFundamentals,
  usMarketStatus,
} from '../../lib/sector/sectorData';
import type { ConstituentQuote, SpyQuote, ConstituentFundamentals } from '../../lib/sector/sectorData';
import {
  computeSectorMetrics, computeRegime, computeOpportunities,
} from '../../lib/sector/sectorEngine';
import type { SectorMetrics, MarketRegime, Opportunity, Classification } from '../../lib/sector/sectorEngine';
import { SECTOR_ETFS, VOLUME_LEVELS } from '../../config/sectorConfig';
import type { Timeframe, MatrixTimeframe } from '../../config/sectorConfig';
import type { WatchItem, Conviction } from '../../types';

// ─── formatting helpers ──────────────────────────────────────────────────────

const fmtPctS = (x: number | null | undefined, d = 1): string =>
  x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;

const pctColor = (x: number | null | undefined): string =>
  x == null ? 'text-zinc-600' : x >= 0 ? 'text-emerald-400' : 'text-red-400';

const pressureColor = (p: number): string =>
  p >= 22 ? 'text-emerald-400' : p <= -22 ? 'text-red-400' : 'text-zinc-300';

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
function SectorTooltipBody({ m }: { m: SectorMetrics }) {
  return (
    <div className="text-xs space-y-1 tabular-nums">
      <div className="font-bold text-zinc-100">{m.name} — {m.etf}</div>
      <div>Rotation Pressure: <span className={pressureColor(m.pressure)}>{m.pressure >= 0 ? '+' : ''}{m.pressure}</span></div>
      <div>Rotation Score: <span className="text-zinc-200">{m.score}</span> · <span className="text-zinc-300">{m.classification}</span></div>
      <div className="text-zinc-400">
        1D {fmtPctS(m.ret['1D'])} · 5D {fmtPctS(m.ret['5D'])} · 1M {fmtPctS(m.ret['1M'])} · 3M {fmtPctS(m.ret['3M'])}
      </div>
      <div>vs SPY 1M: <span className={pctColor(m.rs['1M'])}>{fmtPctS(m.rs['1M'])}</span> · 3M: <span className={pctColor(m.rs['3M'])}>{fmtPctS(m.rs['3M'])}</span></div>
      <div>Momentum: <MomentumBadge m={m.momentum} /></div>
      <div>Breadth: {m.breadth ? `${m.breadth.score}` : 'N/A'} · Volume: {m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A'}</div>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

type SortKey = 'name' | 'ret1D' | 'ret5D' | 'ret1M' | 'ret3M' | 'ret6M' | 'rs5D' | 'rs1M' | 'rs3M' | 'breadth' | 'volume' | 'pressure' | 'score';
type CardSort = 'pressure' | 'score' | 'ret' | 'rs';

export default function SectorRotation() {
  const [metrics, setMetrics]   = useState<SectorMetrics[]>([]);
  const [quotes, setQuotes]     = useState<Map<string, ConstituentQuote>>(new Map());
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

  const [drillEtf, setDrillEtf]     = useState<string | null>(null);
  const [drawer, setDrawer]         = useState<{ ticker: string; currency: string } | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const [hist, cq, spyQ] = await Promise.all([
        fetchAllHistories(force),
        fetchConstituentQuotes(force),
        fetchSpyQuote(),
      ]);
      if (!hist.has('SPY')) {
        setError('Could not load SPY benchmark data. The rotation engine needs it — try Refresh.');
        setLoading(false);
        return;
      }
      const m = computeSectorMetrics(hist, cq);
      setMetrics(m);
      setQuotes(cq);
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

  const regime = useMemo(() => computeRegime(metrics), [metrics]);
  const opportunities = useMemo(() => computeOpportunities(metrics, quotes), [metrics, quotes]);

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

  const drill = drillEtf ? metrics.find(m => m.etf === drillEtf) ?? null : null;

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
        {/* Timeframe emphasis control */}
        <div className="mt-3 flex items-center gap-1">
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
                      {biggestChange.pressureDelta.d5 >= 0 ? '+' : ''}{biggestChange.pressureDelta.d5} Rotation Pressure over 5 trading days
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 tabular-nums">
                      {biggestChange.pressureSeries.length > 6 ? biggestChange.pressureSeries[biggestChange.pressureSeries.length - 6] : '—'} → {biggestChange.pressure}
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
                return (
                  <div key={m.etf} className="relative group">
                    <button
                      onClick={() => setDrillEtf(m.etf)}
                      className="w-full flex items-center gap-2 hover:bg-zinc-800/40 rounded-lg px-1 py-0.5 transition-colors"
                    >
                      <span className="w-24 text-right text-xs text-zinc-400 truncate shrink-0">{m.def.short}</span>
                      <PressureSpark values={m.pressureSeries} />
                      {/* bar area */}
                      <div className="flex-1 flex items-center h-5">
                        <div className="w-1/2 flex justify-end">
                          {!pos && <div className="h-3.5 rounded-l bg-gradient-to-l from-red-500 to-red-500/40" style={{ width: `${widthPct}%` }} />}
                        </div>
                        <div className="w-px h-5 bg-zinc-700 shrink-0" />
                        <div className="w-1/2 flex justify-start">
                          {pos && <div className="h-3.5 rounded-r bg-gradient-to-r from-emerald-500 to-emerald-500/40" style={{ width: `${widthPct}%` }} />}
                        </div>
                      </div>
                      <span className={`w-16 text-right text-xs font-bold tabular-nums shrink-0 flex items-center justify-end gap-1 ${pressureColor(m.pressure)}`}>
                        {m.pressure >= 0 ? '+' : ''}{m.pressure} <TrendArrowIcon arrow={m.trendArrow} />
                      </span>
                      <span className="w-14 text-right text-xs text-zinc-600 tabular-nums shrink-0 hidden sm:block">{fmtPctS(m.ret[tf])}</span>
                    </button>
                    {/* hover tooltip */}
                    <div className="hidden group-hover:block absolute z-30 left-32 top-full mt-1 bg-zinc-900 border border-zinc-700 rounded-xl p-3 shadow-xl w-72 pointer-events-none">
                      <SectorTooltipBody m={m} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 text-xs text-zinc-600 text-right">click any sector to open its drill-down · {tf} return shown at right</div>
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
                <div><div className="text-zinc-500 mb-0.5">Weakening Leader</div><div className="font-semibold text-amber-400">{regime.weakeningLeader ?? 'None'}</div></div>
                <div><div className="text-zinc-500 mb-0.5">Lagging</div><div className="font-semibold text-red-400">{regime.lagging ?? '—'}</div></div>
                <div>
                  <div className="text-zinc-500 mb-0.5 flex items-center gap-1">Breadth <InfoTip text="Percentage of the 11 sectors outperforming SPY over the last month." /></div>
                  <div className="font-semibold text-zinc-200 tabular-nums">{regime.breadthPct != null ? `${regime.breadthPct}% positive` : 'N/A'}</div>
                </div>
              </div>
            </div>
          )}

          {/* ── ROW 4: Rotation Matrix ───────────────────────────────────────── */}
          <div className="card">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest flex items-center gap-2">
                Sector Rotation Matrix
                <InfoTip text="Y: relative strength vs SPY. X: momentum of relative strength. Sectors tend to rotate clockwise: Lagging → Improving → Leading → Weakening." />
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
            <RotationMatrix metrics={metrics} tf={matrixTf} onSelect={setDrillEtf} />
            <div className="flex items-center justify-between text-xs text-zinc-600 mt-1 px-2">
              <span>← RS momentum falling</span>
              <span>trails = last ~7 weekly observations</span>
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
              {sortedCards.map(m => (
                <button key={m.etf} onClick={() => setDrillEtf(m.etf)}
                  className="card text-left hover:border-zinc-600 transition-colors p-3.5">
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
                    <span className={`font-bold flex items-center gap-0.5 ${pressureColor(m.pressure)}`}>
                      {m.pressure >= 0 ? '+' : ''}{m.pressure} <TrendArrowIcon arrow={m.trendArrow} />
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs mt-1.5">
                    <span className="text-zinc-600">Vol {m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A'}</span>
                    <span className="text-zinc-600">Br {m.breadth?.score ?? 'N/A'}</span>
                    <MomentumBadge m={m.momentum} />
                  </div>
                </button>
              ))}
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
                      ['breadth', 'Breadth'], ['volume', 'Vol'], ['pressure', 'Pressure'], ['score', 'Score'],
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
                  {tableRows.map(m => (
                    <tr key={m.etf} className="tr-hover cursor-pointer" onClick={() => setDrillEtf(m.etf)}>
                      <td className="td">
                        <span className="font-semibold text-zinc-200">{m.name}</span>
                        <span className="text-zinc-600 font-mono ml-1.5">{m.etf}</span>
                        <span className="text-zinc-600 ml-1.5 tabular-nums">${m.price.toFixed(2)}</span>
                      </td>
                      {(['1D', '5D', '1M', '3M', '6M'] as Timeframe[]).map(t => (
                        <td key={t} className={`td text-right tabular-nums ${pctColor(m.ret[t])}`}>{fmtPctS(m.ret[t])}</td>
                      ))}
                      {(['5D', '1M', '3M'] as const).map(t => (
                        <td key={t} className={`td text-right tabular-nums ${pctColor(m.rs[t])}`}>{fmtPctS(m.rs[t])}</td>
                      ))}
                      <td className="td text-right tabular-nums text-zinc-300">{m.breadth?.score ?? 'N/A'}</td>
                      <td className="td text-right tabular-nums text-zinc-300">{m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A'}</td>
                      <td className={`td text-right tabular-nums font-bold ${pressureColor(m.pressure)}`}>
                        <span className="inline-flex items-center gap-1">{m.pressure >= 0 ? '+' : ''}{m.pressure} <TrendArrowIcon arrow={m.trendArrow} /></span>
                      </td>
                      <td className="td text-right tabular-nums font-semibold text-zinc-200">{m.score}</td>
                      <td className="td text-right"><MomentumBadge m={m.momentum} /></td>
                      <td className="td text-right">
                        <span className={`text-xs font-bold border rounded px-1.5 py-0.5 ${classColor[m.classification]}`}>{m.classification}</span>
                      </td>
                    </tr>
                  ))}
                  {tableRows.length === 0 && (
                    <tr><td colSpan={16} className="td text-center text-zinc-600 py-6">No sectors match the current filters</td></tr>
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
                <InfoTip text="Sectors ranked by the CHANGE in Rotation Pressure — where conditions are shifting fastest, regardless of absolute level." />
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
                    <button key={m.etf} onClick={() => setDrillEtf(m.etf)}
                      className="flex items-center justify-between bg-zinc-800/40 hover:bg-zinc-800/70 border border-zinc-800 rounded-lg px-3 py-2 transition-colors text-left">
                      <div>
                        <div className="text-xs font-semibold text-zinc-200">{m.name}</div>
                        <div className="text-xs text-zinc-600 tabular-nums">{from != null ? `${from >= 0 ? '+' : ''}${from}` : '—'} → {m.pressure >= 0 ? '+' : ''}{m.pressure}</div>
                      </div>
                      <span className={`text-sm font-bold tabular-nums ${d >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{d >= 0 ? '+' : ''}{d}</span>
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
                  return (
                    <div key={m.etf} className={`bg-zinc-800/30 border border-zinc-800 border-l-4 rounded-lg p-3 ${col.split(' ')[1]}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-zinc-100">{m.name} — {m.etf}</span>
                        <span className={`text-xs font-bold ${col.split(' ')[0]}`}>{arrow} {s.label}</span>
                      </div>
                      <div className="text-xs text-zinc-500 mb-1.5 tabular-nums">Rotation Pressure: <span className={pressureColor(m.pressure)}>{m.pressure >= 0 ? '+' : ''}{m.pressure}</span></div>
                      <ul className="space-y-0.5">
                        {s.reasons.map((r, i) => <li key={i} className="text-xs text-zinc-400">• {r}</li>)}
                      </ul>
                    </div>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {opportunities.map(o => (
                  <button key={`${o.etf}-${o.category}`} onClick={() => setDrillEtf(o.etf)}
                    className="card p-3.5 text-left hover:border-zinc-600 transition-colors">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-bold text-zinc-100">{o.name} <span className="text-zinc-600 font-mono">{o.etf}</span></span>
                      <span className={`text-xs font-bold ${o.direction === 'in' ? 'text-emerald-400' : 'text-red-400'}`}>{o.category}</span>
                    </div>
                    <div className="text-xs text-zinc-500 tabular-nums mb-1.5">Score {o.score} · Pressure <span className={pressureColor(o.pressure)}>{o.pressure >= 0 ? '+' : ''}{o.pressure}</span></div>
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
          {drill && (
            <SectorDrillDown
              m={drill}
              quotes={quotes}
              onClose={() => setDrillEtf(null)}
              onOpenTicker={(ticker) => setDrawer({ ticker, currency: 'USD' })}
            />
          )}
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

function RotationMatrix({ metrics, tf, onSelect }: {
  metrics: SectorMetrics[];
  tf: MatrixTimeframe;
  onSelect: (etf: string) => void;
}) {
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
  const renderShape = (color: string) => (props: any) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return <g />;
    if (!payload.isLast) return <circle cx={cx} cy={cy} r={2} fill={color} fillOpacity={0.35} />;
    return (
      <g style={{ cursor: 'pointer' }} onClick={() => onSelect(payload.etf)}>
        <circle cx={cx} cy={cy} r={6} fill={color} stroke="#18181b" strokeWidth={1.5} />
        <text x={cx + 9} y={cy + 3.5} fill="#e4e4e7" fontSize={11} fontWeight={700}>{payload.etf}</text>
      </g>
    );
  };

  return (
    <div className="h-96 relative">
      {/* quadrant labels */}
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
                  <SectorTooltipBody m={m} />
                </div>
              );
            }}
          />
          {series.map(s => (
            <Scatter key={s.m.etf} data={s.data} fill={s.color}
              line={{ stroke: s.color, strokeWidth: 1, strokeOpacity: 0.25 }}
              shape={renderShape(s.color)} isAnimationActive={false} />
          ))}
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

type ConSortKey = 'symbol' | 'price' | 'marketCap' | 'changePct' | 'volRatio' | 'vs50' | 'vs200' | 'revenueGrowth' | 'epsGrowth' | 'forwardPE' | 'netMargin';

function SectorDrillDown({ m, quotes, onClose, onOpenTicker }: {
  m: SectorMetrics;
  quotes: Map<string, ConstituentQuote>;
  onClose: () => void;
  onOpenTicker: (ticker: string) => void;
}) {
  const [funds, setFunds] = useState<Map<string, ConstituentFundamentals>>(new Map());
  const [fundsLoading, setFundsLoading] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<ConSortKey>('marketCap');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [fProfit, setFProfit]   = useState(false);
  const [fCap, setFCap]         = useState(false);
  const [fRev, setFRev]         = useState(false);
  const [fEps, setFEps]         = useState(false);
  const [fAbove50, setFAbove50] = useState(false);
  const [fAbove200, setFAbove200] = useState(false);
  const [fVol, setFVol]         = useState(false);

  // Lazy-load fundamentals for this sector's constituents (cached 12h each)
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
    const item: WatchItem = {
      id: newId(),
      ticker,
      conviction: 'MEDIUM' as Conviction,
      notes: `From Sector Rotation — ${m.name} (${m.etf}), pressure ${m.pressure >= 0 ? '+' : ''}${m.pressure}`,
      watch_price: q?.price ?? null,
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

  const rows = useMemo(() => {
    let rs = m.def.constituents
      .map(t => {
        const q = quotes.get(t);
        const f = funds.get(t) ?? null;
        const volRatio = q?.volume != null && q?.avgVolume3M ? q.volume / q.avgVolume3M : null;
        const vs50  = q?.price != null && q?.ma50  ? (q.price / q.ma50 - 1) * 100 : null;
        const vs200 = q?.price != null && q?.ma200 ? (q.price / q.ma200 - 1) * 100 : null;
        return { t, q, f, volRatio, vs50, vs200 };
      })
      .filter(r => r.q != null);

    if (fProfit)   rs = rs.filter(r => (r.q!.epsTTM ?? -1) > 0);
    if (fCap)      rs = rs.filter(r => (r.q!.marketCap ?? 0) > 2e9);
    if (fRev)      rs = rs.filter(r => (r.f?.revenueGrowth ?? -1) > 0);
    if (fEps)      rs = rs.filter(r => (r.f?.epsGrowth ?? -1) > 0);
    if (fAbove50)  rs = rs.filter(r => (r.vs50 ?? -1) > 0);
    if (fAbove200) rs = rs.filter(r => (r.vs200 ?? -1) > 0);
    if (fVol)      rs = rs.filter(r => (r.volRatio ?? 0) > VOLUME_LEVELS.elevated);

    const get = (r: typeof rs[number]): number | string => {
      switch (sortKey) {
        case 'symbol':        return r.t;
        case 'price':         return r.q!.price ?? -1;
        case 'changePct':     return r.q!.changePct ?? -99;
        case 'volRatio':      return r.volRatio ?? -1;
        case 'vs50':          return r.vs50 ?? -999;
        case 'vs200':         return r.vs200 ?? -999;
        case 'revenueGrowth': return r.f?.revenueGrowth ?? -999;
        case 'epsGrowth':     return r.f?.epsGrowth ?? -999;
        case 'forwardPE':     return r.q!.forwardPE ?? 9999;
        case 'netMargin':     return r.f?.netMargin ?? -999;
        default:              return r.q!.marketCap ?? -1;
      }
    };
    rs.sort((a, b) => {
      const av = get(a), bv = get(b);
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rs;
  }, [m.def, quotes, funds, fProfit, fCap, fRev, fEps, fAbove50, fAbove200, fVol, sortKey, sortDir]);

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
          ['Pressure', `${m.pressure >= 0 ? '+' : ''}${m.pressure}`, pressureColor(m.pressure)],
          ['Score', String(m.score), 'text-zinc-100'],
          ['1M', fmtPctS(m.ret['1M']), pctColor(m.ret['1M'])],
          ['3M', fmtPctS(m.ret['3M']), pctColor(m.ret['3M'])],
          ['vs SPY 1M', fmtPctS(m.rs['1M']), pctColor(m.rs['1M'])],
          ['Breadth', m.breadth ? String(m.breadth.score) : 'N/A', 'text-zinc-100'],
          ['Volume', m.volumeRatio != null ? `${m.volumeRatio.toFixed(2)}x` : 'N/A', 'text-zinc-100'],
          ['Status', m.classification, classColor[m.classification].split(' ')[0]],
        ].map(([label, value, cls]) => (
          <div key={label as string} className="bg-zinc-800/50 rounded-lg p-2">
            <div className="text-zinc-500">{label}</div>
            <div className={`font-semibold mt-0.5 ${cls}`}>{value}</div>
          </div>
        ))}
      </div>

      {m.breadth && (
        <div className="text-xs text-zinc-500 mb-4">
          Top-holdings breadth ({m.breadth.count} names): {m.breadth.above50Pct}% above 50DMA · {m.breadth.above200Pct}% above 200DMA · {m.breadth.positiveTodayPct}% positive today
          {m.breadth.change != null && <> · change {m.breadth.change >= 0 ? '+' : ''}{m.breadth.change} vs last snapshot</>}
        </div>
      )}

      {/* quality filters */}
      <div className="flex items-center gap-1.5 flex-wrap text-xs mb-3">
        <span className="text-zinc-600 mr-1">Quality filters:</span>
        {[
          { on: fProfit, set: setFProfit, label: 'Profitable' },
          { on: fCap, set: setFCap, label: 'Cap > $2B' },
          { on: fRev, set: setFRev, label: '+Rev Growth' },
          { on: fEps, set: setFEps, label: '+EPS Growth' },
          { on: fAbove50, set: setFAbove50, label: '> 20/50DMA' },
          { on: fAbove200, set: setFAbove200, label: '> 200DMA' },
          { on: fVol, set: setFVol, label: 'High Volume' },
        ].map(f => (
          <button key={f.label} onClick={() => f.set(v => !v)}
            className={`px-2 py-1 rounded-lg transition-colors ${f.on ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}>
            {f.label}
          </button>
        ))}
        {fundsLoading && <span className="text-zinc-600 ml-2 flex items-center gap-1"><RefreshCw size={10} className="animate-spin" /> loading fundamentals…</span>}
      </div>

      {/* constituents table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/40 text-zinc-500">
              {([
                ['symbol', 'Ticker'], ['price', 'Price'], ['marketCap', 'Mkt Cap'], ['changePct', '1D'],
                ['volRatio', 'Vol Ratio'], ['vs50', 'vs 50DMA'], ['vs200', 'vs 200DMA'],
                ['revenueGrowth', 'Rev Gr (3Y)'], ['epsGrowth', 'EPS Gr (3Y)'], ['forwardPE', 'Fwd P/E'], ['netMargin', 'Margin'],
              ] as [ConSortKey, string][]).map(([k, label]) => (
                <th key={k} className={`th cursor-pointer select-none whitespace-nowrap ${k === 'symbol' ? 'text-left' : 'text-right'}`} onClick={() => toggle(k)}>
                  {label} <SIcon k={k} />
                </th>
              ))}
              <th className="th text-right">Earnings</th>
              <th className="th text-right">Profitable</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map(({ t, q, f, volRatio, vs50, vs200 }) => (
              <tr key={t} className="tr-hover">
                <td className="td">
                  <button onClick={() => onOpenTicker(t)}
                    className="font-mono font-bold text-blue-400 hover:text-blue-300 hover:underline underline-offset-2">
                    {t}
                  </button>
                  <div className="text-zinc-600 truncate max-w-[140px]">{q!.name}</div>
                </td>
                <td className="td text-right tabular-nums text-zinc-200">{q!.price != null ? `$${q!.price.toFixed(2)}` : '—'}</td>
                <td className="td text-right tabular-nums text-zinc-300">{fmtCap(q!.marketCap)}</td>
                <td className={`td text-right tabular-nums ${q!.changePct == null ? 'text-zinc-600' : q!.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {q!.changePct != null ? `${q!.changePct >= 0 ? '+' : ''}${q!.changePct.toFixed(2)}%` : '—'}
                </td>
                <td className="td text-right tabular-nums text-zinc-300">{volRatio != null ? `${volRatio.toFixed(2)}x` : '—'}</td>
                <td className={`td text-right tabular-nums ${vs50 == null ? 'text-zinc-600' : vs50 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{vs50 != null ? `${vs50 >= 0 ? '+' : ''}${vs50.toFixed(1)}%` : '—'}</td>
                <td className={`td text-right tabular-nums ${vs200 == null ? 'text-zinc-600' : vs200 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{vs200 != null ? `${vs200 >= 0 ? '+' : ''}${vs200.toFixed(1)}%` : '—'}</td>
                <td className={`td text-right tabular-nums ${f?.revenueGrowth == null ? 'text-zinc-600' : f.revenueGrowth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{f?.revenueGrowth != null ? `${f.revenueGrowth.toFixed(1)}%` : 'N/A'}</td>
                <td className={`td text-right tabular-nums ${f?.epsGrowth == null ? 'text-zinc-600' : f.epsGrowth >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{f?.epsGrowth != null ? `${f.epsGrowth.toFixed(1)}%` : 'N/A'}</td>
                <td className="td text-right tabular-nums text-zinc-300">{q!.forwardPE != null ? `${q!.forwardPE.toFixed(1)}x` : 'N/A'}</td>
                <td className="td text-right tabular-nums text-zinc-300">{f?.netMargin != null ? `${f.netMargin.toFixed(1)}%` : 'N/A'}</td>
                <td className="td text-right tabular-nums text-zinc-400">
                  {q!.earningsTs != null ? new Date(q!.earningsTs * 1000).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '—'}
                </td>
                <td className="td text-right">
                  {q!.epsTTM == null ? <span className="text-zinc-600">—</span>
                    : q!.epsTTM > 0 ? <span className="text-emerald-400">Yes</span>
                    : <span className="text-red-400">No</span>}
                </td>
                <td className="td text-right whitespace-nowrap">
                  <button
                    onClick={() => addToWatch(t)}
                    disabled={added.has(t)}
                    title="Add to Watch List"
                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors ${added.has(t) ? 'text-emerald-500' : 'text-zinc-500 hover:text-blue-400 hover:bg-zinc-800'}`}
                  >
                    <Eye size={11} /> {added.has(t) ? 'Added' : 'Watch'}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={14} className="td text-center text-zinc-600 py-6">No constituents match the current quality filters</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-xs text-zinc-600 flex items-center gap-1">
        <AlertTriangle size={10} className="text-zinc-700" />
        Top {m.def.constituents.length} holdings shown (static snapshot). Click a ticker for the full fundamentals drawer.
      </div>
    </div>
  );
}
