import { useState, useMemo } from 'react';
import {
  RefreshCw, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, XCircle,
  Star, Shield, Zap, BarChart3, Minus, Info, Flag,
} from 'lucide-react';
import { storage } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { getUsdCad } from '../../lib/fx';
import { fetchQuote, fetchPortfolioHistories, purgeStaleCaches } from '../../lib/portfolio/portfolioData';
import { resolveSectors } from '../../lib/watch/watchSectorContext';
import { fetchAllHistories, fetchConstituentQuotes, fetchConstituentHistories } from '../../lib/sector/sectorData';
import { computeSectorMetrics } from '../../lib/sector/sectorEngine';
import type { SectorMetrics } from '../../lib/sector/sectorEngine';
import { describePressure, PRESSURE_HELP } from '../../lib/sector/pressureHelp';
import { loadSectorOverrides } from '../../lib/portfolio/sectorOverrides';
import { loadReviewFlags, setThesisBroken } from '../../lib/review/reviewFlags';
import { computePortfolioYtd } from '../../lib/review/portfolioReturn';
import {
  computeCompanyQuality, computeEtfQuality, computeEtfPositionFit, computeEtfOverlap,
  etfRoleOf, computePositionFit, deriveStatus, buildAction,
  computePortfolioHealth, computeMarketAlignment, buildAlerts, sectorLabelFor,
  isBroadEtf, isGrowthEtf, positionTypeFor,
} from '../../lib/review/reviewEngine';
import type { PositionReview, CompanyQuality } from '../../lib/review/reviewEngine';
import {
  REVIEW_STATUS_STYLE, PORTFOLIO_HEALTH_HELP, MARKET_ALIGNMENT_HELP, COMPANY_QUALITY_HELP,
  POSITION_FIT_HELP, PORTFOLIO_YTD_HELP, EXPOSURE_THRESHOLDS,
} from '../../config/reviewConfig';
import { SECTOR_NAME_BY_ETF } from '../../config/portfolioConfig';
import type { Holding, FinnhubMetrics } from '../../types';

const USD_CAD_FALLBACK = 1.38;

// ─── formatting ──────────────────────────────────────────────────────────────

const fmtPctS = (x: number | null | undefined, d = 1): string =>
  x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const pctColor = (x: number | null | undefined): string =>
  x == null ? 'text-zinc-600' : x >= 0 ? 'text-emerald-400' : 'text-red-400';
const signedInt = (n: number | null | undefined): string =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n}`;
const fmtMoney = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-CA', { maximumFractionDigits: 0 })}`;
const fmt2 = (n: number, d = 2) =>
  n.toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });

function InfoTip({ text }: { text: string }) {
  return <span title={text} className="inline-flex text-zinc-600 hover:text-zinc-400 cursor-help align-middle"><Info size={11} /></span>;
}

function statusIcon(s: PositionReview['status']) {
  if (s === 'CORE')        return <Shield size={14} className="text-violet-400" />;
  if (s === 'STRONG HOLD') return <CheckCircle size={14} className="text-emerald-400" />;
  if (s === 'HOLD')        return <Shield size={14} className="text-blue-400" />;
  if (s === 'WATCH')       return <AlertTriangle size={14} className="text-amber-400" />;
  if (s === 'TRIM')        return <Minus size={14} className="text-orange-400" />;
  if (s === 'REVIEW')      return <AlertTriangle size={14} className="text-orange-300" />;
  return <XCircle size={14} className="text-red-400" />;
}

function ScoreBar({ score, tone = 'blue' }: { score: number; tone?: 'blue' | 'violet' }) {
  const pct = (score / 10) * 100;
  const color =
    tone === 'violet' ? 'bg-violet-500'
    : score >= 7.5 ? 'bg-emerald-500' : score >= 6 ? 'bg-blue-500'
    : score >= 4.5 ? 'bg-amber-500' : score >= 3 ? 'bg-orange-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-400 w-7 text-right tabular-nums">{score.toFixed(1)}</span>
    </div>
  );
}

interface ReviewResult {
  reviews: PositionReview[];
  health: ReturnType<typeof computePortfolioHealth>;
  alignment: ReturnType<typeof computeMarketAlignment>;
  alerts: string[];
  totalPnLCAD: number;
  totalCostCAD: number;
  ytd: ReturnType<typeof computePortfolioYtd>;
  benchmarks: { spyYtd: number | null; tsxYtd: number | null };
  annualDividendsCAD: number;
  uniqueUnderlying: number;
  generatedAt: string;
}

// ─── component ───────────────────────────────────────────────────────────────

export default function PortfolioReview() {
  const [result, setResult]   = useState<ReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError]     = useState<string | null>(null);
  const [flags, setFlags]     = useState(loadReviewFlags);
  const [showHealth, setShowHealth] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function runReview() {
    setLoading(true); setResult(null); setError(null);
    purgeStaleCaches();
    try {
      const holdings = await storage.getAll<Holding>('holdings');
      if (holdings.length === 0) {
        setError('No holdings found. Add positions in the Portfolio tab first.');
        setLoading(false); return;
      }
      setProgress({ current: 0, total: holdings.length });

      const tickers = holdings.map(h => h.ticker.toUpperCase());
      const bases = [...new Set(tickers.map(t => t.replace(/\.(TO|V|TSX|CN|NEO|VN)$/i, '')))];

      const fx = await getUsdCad().catch(() => USD_CAD_FALLBACK);

      // Prices, history and shared sector data in parallel
      const [quotes, histories, detected, sh, sq, sc] = await Promise.all([
        Promise.all(holdings.map(async h => {
          const q = await fetchQuote(h.ticker);
          setProgress(p => ({ ...p, current: p.current + 1 }));
          return [h.ticker, q] as const;
        })),
        fetchPortfolioHistories(tickers),
        resolveSectors(tickers),
        fetchAllHistories(), fetchConstituentQuotes(), fetchConstituentHistories(),
      ]);
      const quoteMap = new Map(quotes);
      const sectorMetrics = new Map(computeSectorMetrics(sh, sq, sc).map(m => [m.etf, m]));
      const overrides = loadSectorOverrides();

      // Company fundamentals — one fetch per underlying, shared across accounts
      type MetricEntry = { base: string; metric: FinnhubMetrics['metric'] | null };
      const metricResults = await Promise.allSettled(
        bases.map(async (b): Promise<MetricEntry> => ({ base: b, metric: (await finnhub.metrics(b))?.metric ?? null }))
      );
      const metricsByBase = new Map<string, FinnhubMetrics['metric'] | null>();
      for (const r of metricResults) {
        if (r.status === 'fulfilled') metricsByBase.set(r.value.base, r.value.metric);
      }

      // ── position values and combined exposure per underlying ──────────────
      const baseOf = (t: string) => t.toUpperCase().replace(/\.(TO|V|TSX|CN|NEO|VN)$/i, '');
      const rows = holdings.map(h => {
        const q = quoteMap.get(h.ticker) ?? null;
        const price = q?.price ?? h.avg_cost;
        const native = h.shares * price;
        const cadValue = h.currency === 'USD' ? native * fx : native;
        const costCAD = h.shares * h.avg_cost * (h.currency === 'USD' ? fx : 1);
        return { h, price, native, cadValue, costCAD, base: baseOf(h.ticker) };
      });
      const totalCAD = rows.reduce((s, r) => s + r.cadValue, 0) || 1;

      const combinedExposure = new Map<string, number>();
      const siblingCount = new Map<string, number>();
      for (const r of rows) {
        combinedExposure.set(r.base, (combinedExposure.get(r.base) ?? 0) + (r.cadValue / totalCAD) * 100);
        siblingCount.set(r.base, (siblingCount.get(r.base) ?? 0) + 1);
      }

      // Shared Company Quality per underlying (identical in every account)
      const directNames = new Set(rows.filter(r => positionTypeFor(r.h.ticker) === 'Individual Stock').map(r => r.base));
      const qualityByBase = new Map<string, CompanyQuality>();
      for (const r of rows) {
        if (qualityByBase.has(r.base)) continue;
        qualityByBase.set(
          r.base,
          positionTypeFor(r.h.ticker) !== 'Individual Stock'
            // Product quality only — overlap is handled in Position Fit
            ? computeEtfQuality(r.h.ticker)
            : computeCompanyQuality(metricsByBase.get(r.base) ?? null),
        );
      }

      // ── build one review per HOLDING (accounts stay separate) ─────────────
      const reviews: PositionReview[] = rows.map(({ h, price, native, cadValue, base }) => {
        const closes = histories.get(h.ticker.toUpperCase());
        const ret = (n: number) => {
          if (!closes || closes.length < n + 1) return null;
          const start = closes[closes.length - 1 - n];
          return start > 0 ? closes[closes.length - 1] / start - 1 : null;
        };
        const ret1M = ret(21), ret3M = ret(63);

        const override = overrides[h.ticker.toUpperCase()];
        const detectedEtf = override
          ? Object.entries(SECTOR_NAME_BY_ETF).find(([, n]) => n === override)?.[0] ?? null
          : detected[h.ticker.toUpperCase()] ?? null;
        const { etf: sectorEtf, label: sectorLabel } = sectorLabelFor(h.ticker, detectedEtf);
        const sector = sectorEtf ? sectorMetrics.get(sectorEtf) ?? null : null;
        const rsVsSector1M = ret1M != null && sector?.ret['1M'] != null ? ret1M - sector.ret['1M']! : null;

        const quality = qualityByBase.get(base)!;
        const positionPct = (cadValue / totalCAD) * 100;
        const combined = combinedExposure.get(base) ?? positionPct;
        const broad = isBroadEtf(h.ticker);
        const growth = isGrowthEtf(h.ticker);
        const pnlPct = h.avg_cost > 0 ? ((price - h.avg_cost) / h.avg_cost) * 100 : null;
        const targetRemainingPct = h.target_price && h.target_price > 0 && price > 0
          ? ((h.target_price - price) / price) * 100 : null;

        // Funds are fitted on portfolio criteria (overlap, role, size, style),
        // stocks on the company-oriented model.
        const overlapPct = quality.isEtf ? computeEtfOverlap(h.ticker, directNames) : null;
        const styleExposurePct = quality.isEtf
          ? rows.filter(x => {
              const t = positionTypeFor(x.h.ticker);
              if (t === 'Growth/Index ETF') return true;
              if (t !== 'Individual Stock') return false;
              const e = overrides[x.h.ticker.toUpperCase()] ? null : detected[x.h.ticker.toUpperCase()];
              return e === 'XLK' || e === 'XLC' || e === 'XLY';
            }).reduce((s, x) => s + (x.cadValue / totalCAD) * 100, 0)
          : null;

        const fit = quality.isEtf
          ? computeEtfPositionFit({
              ticker: h.ticker, overlapPct, positionPct,
              styleExposurePct, correlation: null, ret3M,
              sectorPressure: sector?.pressure ?? null,
            })
          : computePositionFit({
              companyQuality: quality.score, rsVsSector1M, ret3M,
              positionPct, combinedExposurePct: combined,
              sectorPressure: sector?.pressure ?? null,
              targetRemainingPct, isEtf: false, isBroadEtf: false,
            });

        const { status, flags: statusFlags } = deriveStatus({
          fit: fit.score, quality, combinedExposurePct: combined, pnlPct, rsVsSector1M,
          isEtf: quality.isEtf, isBroadEtf: broad,
          thesisBroken: !!flags[h.ticker.toUpperCase()]?.thesis_broken,
        });

        // Position-level observations (business observations live on quality)
        const pros: string[] = [...quality.pros];
        const cons: string[] = [...quality.cons];
        if (!quality.isEtf) {
          if (rsVsSector1M != null && rsVsSector1M > 0.05) pros.push(`Outperforming ${sectorLabel} by ${fmtPctS(rsVsSector1M)} over 1M`);
          if (rsVsSector1M != null && rsVsSector1M < -0.05) cons.push(`Lagging ${sectorLabel} by ${fmtPctS(Math.abs(rsVsSector1M))} over 1M`);
          if (pnlPct != null && pnlPct >= 25) pros.push(`Up ${pnlPct.toFixed(1)}% in this account`);
          if (pnlPct != null && pnlPct <= -20) cons.push(`Down ${Math.abs(pnlPct).toFixed(1)}% in this account`);
        } else if (overlapPct != null && overlapPct >= 25) {
          // Portfolio-fit concern, explicitly not a product-quality concern
          cons.push(`Overlaps ~${overlapPct.toFixed(0)}% of its index weight with directly held names — a portfolio fit concern, not a fund quality issue`);
        }
        if (combined >= EXPOSURE_THRESHOLDS.overweight && !broad && !quality.isEtf) {
          cons.push(`Combined exposure across accounts is ${combined.toFixed(1)}% of the portfolio`);
        }
        if (sector && sector.pressure <= -22) cons.push(`${sectorLabel} rotation pressure ${signedInt(sector.pressure)}`);
        if (sector && sector.pressure >= 22) pros.push(`${sectorLabel} rotation pressure ${signedInt(sector.pressure)}`);

        const action = buildAction({
          status, flags: statusFlags, companyName: base, quality,
          combinedExposurePct: combined, siblingCount: siblingCount.get(base) ?? 1,
          pnlPct, rsVsSector1M, sectorLabel, sectorPressure: sector?.pressure ?? null,
          isBroadEtf: broad, isGrowthEtf: growth, overlapPct,
        });

        return {
          holding: h, ticker: h.ticker, base, companyName: base,
          account: h.account, currency: h.currency,
          positionType: positionTypeFor(h.ticker), isEtf: quality.isEtf,
          companyQuality: quality, combinedExposurePct: combined,
          siblingCount: siblingCount.get(base) ?? 1,
          positionPct, positionFit: fit.score, fitComponents: fit.components,
          status, flags: statusFlags, pros, cons, action,
          sectorEtf, sectorLabel, sector, rsVsSector1M, ret1M, ret3M,
          currentPrice: price, pnlPct,
          marketValueNative: native, marketValueCAD: cadValue,
          targetRemainingPct,
        };
      });

      reviews.sort((a, b) => b.combinedExposurePct - a.combinedExposurePct || b.positionFit - a.positionFit);

      // ── portfolio-level ───────────────────────────────────────────────────
      const totalCostCAD = rows.reduce((s, r) => s + r.costCAD, 0);
      const totalPnLCAD = totalCAD - totalCostCAD;

      const broadPct  = reviews.filter(r => isBroadEtf(r.ticker)).reduce((s, r) => s + r.positionPct, 0);
      const growthPct = reviews.filter(r => isGrowthEtf(r.ticker)).reduce((s, r) => s + r.positionPct, 0);

      // Value-weighted tactical inputs
      const rsRows = reviews.filter(r => r.rsVsSector1M != null);
      const avgRs = rsRows.length > 0
        ? rsRows.reduce((s, r) => s + r.rsVsSector1M! * r.positionPct, 0) / (rsRows.reduce((s, r) => s + r.positionPct, 0) || 1)
        : null;
      const trendRows = reviews.filter(r => r.ret3M != null);
      const avgTrend3M = trendRows.length > 0
        ? trendRows.reduce((s, r) => s + r.ret3M! * r.positionPct, 0) / (trendRows.reduce((s, r) => s + r.positionPct, 0) || 1)
        : null;
      const pressureRows = reviews.filter(r => r.sector);
      const avgPressure = pressureRows.length > 0
        ? pressureRows.reduce((s, r) => s + r.sector!.pressure * r.positionPct, 0) /
          (pressureRows.reduce((s, r) => s + r.positionPct, 0) || 1)
        : null;

      // Largest sector weight (diversified/specialty funds are not a sector)
      const sectorTotals = new Map<string, number>();
      for (const r of reviews) {
        if (!r.sectorEtf) continue;
        sectorTotals.set(r.sectorLabel, (sectorTotals.get(r.sectorLabel) ?? 0) + r.positionPct);
      }
      // base ticker → a representative real ticker, so concentration rules can
      // tell a broad core fund apart from a single company
      const representativeTicker = new Map<string, string>();
      for (const r of rows) if (!representativeTicker.has(r.base)) representativeTicker.set(r.base, r.h.ticker);

      const health = computePortfolioHealth({
        reviews, combinedExposure, representativeTicker, sectorTotals,
        broadEtfPct: broadPct,
        growthEtfPct: growthPct,
        avgRs, avgSectorPressure: avgPressure,
      });

      const sectorNotes = [...sectorTotals.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([label]) => {
          const m = reviews.find(r => r.sectorLabel === label)?.sector;
          return m ? `${label}: pressure ${signedInt(m.pressure)} ${m.classification.toLowerCase()}` : null;
        })
        .filter((x): x is string => x != null);

      const alignment = computeMarketAlignment({
        avgSectorPressure: avgPressure, avgRs, avgTrend3M,
        regime: null, sectorNotes,
      });

      const alerts = buildAlerts(reviews, combinedExposure, representativeTicker, growthPct);

      // Same-period benchmark comparison
      const ytd = computePortfolioYtd(rows.map(r => ({
        ticker: r.h.ticker,
        marketValue: r.cadValue,
        closes: histories.get(r.h.ticker.toUpperCase()),
        purchaseDate: r.h.purchase_date,
      })));
      const spyH = sh.get('SPY');
      const benchYtd = (h?: { closes: number[]; timestamps: number[] }) => {
        if (!h) return null;
        const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
        const i = h.timestamps.findIndex(t => t >= jan1);
        if (i < 0 || i >= h.closes.length - 1) return null;
        return h.closes[h.closes.length - 1] / h.closes[i] - 1;
      };
      const tsxH = await fetch(`/api/yahoo?ticker=XIC.TO&history=1`).then(r => r.json()).catch(() => null);
      const benchmarks = {
        spyYtd: benchYtd(spyH),
        tsxYtd: tsxH?.closes ? benchYtd(tsxH) : null,
      };

      const annualDividendsCAD = rows.reduce((s, r) => {
        const dy = metricsByBase.get(r.base)?.dividendYieldIndicatedAnnual;
        return dy && dy > 0 ? s + r.cadValue * (dy / 100) : s;
      }, 0);

      setResult({
        reviews, health, alignment, alerts, totalPnLCAD, totalCostCAD, ytd, benchmarks,
        annualDividendsCAD, uniqueUnderlying: combinedExposure.size,
        generatedAt: new Date().toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }),
      });
    } catch (e) {
      console.error(e);
      setError('Failed to load portfolio data. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  function toggleThesisBroken(ticker: string, broken: boolean) {
    setFlags(setThesisBroken(ticker, broken));
  }

  const statusCounts = useMemo(() => {
    if (!result) return [];
    const order: PositionReview['status'][] = ['CORE', 'STRONG HOLD', 'HOLD', 'WATCH', 'TRIM', 'REVIEW', 'EXIT'];
    return order
      .map(s => ({ status: s, count: result.reviews.filter(r => r.status === s).length }))
      .filter(x => x.count > 0);
  }, [result]);

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <BarChart3 size={16} className="text-blue-400" />
              Portfolio Review
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              One review per holding — the same company shares a quality score, each account gets its own position fit
            </p>
          </div>
          <button onClick={runReview} disabled={loading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? `Analyzing ${progress.current} / ${progress.total}…` : 'Run Full Review'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-800/40 rounded-xl p-4 text-sm text-red-400 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={runReview} className="text-xs bg-red-900/40 hover:bg-red-900/60 px-3 py-1.5 rounded-lg">Retry</button>
        </div>
      )}

      {loading && (
        <div className="card py-10 text-center">
          <div className="inline-flex items-center gap-3 text-zinc-400 text-sm">
            <RefreshCw size={16} className="animate-spin text-blue-400" />
            Fetching prices, fundamentals and rotation data…
          </div>
          <div className="mt-4 h-1.5 bg-zinc-800 rounded-full overflow-hidden max-w-sm mx-auto">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }} />
          </div>
        </div>
      )}

      {result && !loading && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 col-span-2 sm:col-span-1">
              <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                Portfolio Health <InfoTip text={PORTFOLIO_HEALTH_HELP} />
              </div>
              {result.health ? (
                <>
                  <div className={`text-2xl font-bold ${
                    result.health.score >= 8.5 ? 'text-emerald-400' : result.health.score >= 7 ? 'text-emerald-500'
                    : result.health.score >= 5.5 ? 'text-amber-400' : result.health.score >= 4 ? 'text-orange-400' : 'text-red-400'}`}>
                    {result.health.label}
                  </div>
                  <div className="mt-2"><ScoreBar score={result.health.score} /></div>
                  <div className="text-xs text-zinc-600 mt-1">structural quality</div>
                  {result.alignment && (
                    <div className="mt-2 pt-2 border-t border-zinc-800">
                      <div className="text-xs text-zinc-500 flex items-center gap-1">
                        Market Alignment <InfoTip text={MARKET_ALIGNMENT_HELP} />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-sm font-semibold ${
                          result.alignment.score >= 6.5 ? 'text-emerald-400'
                          : result.alignment.score >= 4.5 ? 'text-amber-400' : 'text-red-400'}`}>
                          {result.alignment.score.toFixed(1)}
                        </span>
                        <span className="text-xs text-zinc-500">{result.alignment.label}</span>
                      </div>
                    </div>
                  )}
                  <button onClick={() => setShowHealth(v => !v)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 mt-2 underline underline-offset-2 decoration-dotted">
                    {showHealth ? 'Hide' : 'Show'} breakdown
                  </button>
                </>
              ) : <div className="text-zinc-600 text-sm">N/A</div>}
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-1">Total P&amp;L (CAD)</div>
              <div className={`text-xl font-bold ${result.totalPnLCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.totalPnLCAD >= 0 ? '+' : '-'}{fmtMoney(result.totalPnLCAD)}
              </div>
              <div className={`text-xs mt-1 ${result.totalPnLCAD >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {result.totalCostCAD > 0 ? `${result.totalPnLCAD >= 0 ? '+' : ''}${fmt2((result.totalPnLCAD / result.totalCostCAD) * 100, 1)}% on cost (lifetime)` : '—'}
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2">
                Rating Breakdown
                <span className="text-zinc-600"> · {result.reviews.length} holdings</span>
              </div>
              <div className="space-y-1">
                {statusCounts.map(({ status, count }) => (
                  <div key={status} className="flex items-center gap-2">
                    {statusIcon(status)}
                    <span className="text-xs text-zinc-400 flex-1">{status}</span>
                    <span className="text-xs font-medium text-zinc-300">{count}</span>
                  </div>
                ))}
              </div>
              <div className="text-xs text-zinc-600 mt-2 pt-2 border-t border-zinc-800">
                {result.reviews.length} holdings · {result.uniqueUnderlying} underlying
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1.5">
                <AlertTriangle size={11} className="text-amber-500" /> Alerts
              </div>
              {result.alerts.length === 0
                ? <div className="text-xs text-zinc-600">No critical alerts</div>
                : <ul className="space-y-1">{result.alerts.map((a, i) => <li key={i} className="text-xs text-amber-400">{a}</li>)}</ul>}
            </div>
          </div>

          {/* Health breakdown */}
          {showHealth && result.health && (
            <div className="card space-y-4">
              <div>
                <div className="text-sm font-semibold text-zinc-100 mb-1">
                  Portfolio Health {result.health.score.toFixed(1)} / 10 — {result.health.label}
                </div>
                <div className="text-xs text-zinc-600 mb-3">
                  Structural measure. Tactical factors carry 10% combined; benchmark performance is excluded entirely.
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-600 border-b border-zinc-800">
                        <th className="text-left font-medium pb-1.5">Component</th>
                        <th className="text-right font-medium pb-1.5">Score</th>
                        <th className="text-right font-medium pb-1.5">Weight</th>
                        <th className="text-right font-medium pb-1.5">Contribution</th>
                        <th className="text-left font-medium pb-1.5 pl-4">Basis</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/50">
                      {result.health.components.map(c => {
                        const totalW = result.health!.components.reduce((s, x) => s + x.weight, 0);
                        return (
                          <tr key={c.key}>
                            <td className="py-1.5 text-zinc-300">{c.label}</td>
                            <td className="py-1.5 text-right tabular-nums text-zinc-200 font-medium">{c.score.toFixed(2)}</td>
                            <td className="py-1.5 text-right tabular-nums text-zinc-500">× {c.weight}%</td>
                            <td className="py-1.5 text-right tabular-nums text-zinc-300">= {(c.score * c.weight / totalW).toFixed(2)}</td>
                            <td className="py-1.5 pl-4 text-zinc-500">{c.detail}</td>
                          </tr>
                        );
                      })}
                      <tr className="border-t-2 border-zinc-700">
                        <td className="py-2 text-zinc-100 font-semibold">Final Portfolio Health</td>
                        <td />
                        <td />
                        <td className="py-2 text-right tabular-nums text-zinc-100 font-bold">{result.health.score.toFixed(1)}</td>
                        <td className="py-2 pl-4 text-zinc-400">{result.health.label}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="text-xs text-zinc-600 mt-2">
                  Weighted by CAD market value. Score rounded to one decimal using standard rounding; the label is derived from that same rounded value.
                </div>
              </div>

              {/* Concentration sub-scores — each a distinct, non-overlapping risk */}
              <div className="pt-1">
                <div className="text-xs font-medium text-zinc-300 mb-1.5">
                  Concentration detail
                  <span className="text-zinc-600 font-normal"> — the largest holding is scored once, then excluded from the breadth and sector terms</span>
                </div>
                <div className="space-y-0.5">
                  {result.health.penalties.map(p => (
                    <div key={p.factor} className="flex items-center gap-3 text-xs">
                      <span className="text-zinc-400 w-48 flex-shrink-0">{p.factor}</span>
                      <span className="text-zinc-200 w-10 text-right tabular-nums">{p.score.toFixed(2)}</span>
                      <span className="text-zinc-600 w-12 text-right tabular-nums">× {p.weight}%</span>
                      <span className="text-zinc-500 flex-1">{p.basis}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4 pt-1">
                <div>
                  <div className="text-xs font-medium text-emerald-400 mb-1.5">Positive Drivers</div>
                  {result.health.positives.length === 0
                    ? <div className="text-xs text-zinc-600">—</div>
                    : <ul className="space-y-0.5">{result.health.positives.map((p, i) => (
                        <li key={i} className="text-xs text-zinc-400">• {p}</li>))}</ul>}
                </div>
                <div>
                  <div className="text-xs font-medium text-orange-400 mb-1.5">Negative Drivers</div>
                  {result.health.risks.length === 0
                    ? <div className="text-xs text-zinc-600">No material structural risks detected</div>
                    : <ul className="space-y-0.5">{result.health.risks.map((r, i) => (
                        <li key={i} className="text-xs text-zinc-400">• {r}</li>))}</ul>}
                </div>
              </div>

              {result.alignment && (
                <div className="pt-3 border-t border-zinc-800">
                  <div className="text-sm font-semibold text-zinc-100 mb-1">
                    Market Alignment {result.alignment.score.toFixed(1)} / 10 — {result.alignment.label}
                  </div>
                  <div className="text-xs text-zinc-600 mb-2">
                    Tactical read on current conditions. Can change quickly without implying the portfolio is unhealthy.
                  </div>
                  <div className="space-y-1.5">
                    {result.alignment.components.map(c => (
                      <div key={c.label} className="flex items-center gap-3 text-xs">
                        <span className="text-zinc-300 w-48 flex-shrink-0">{c.label}</span>
                        <span className="text-zinc-400 w-10 text-right tabular-nums font-medium">{c.score.toFixed(1)}</span>
                        <span className="text-zinc-600 w-10 text-right tabular-nums">×{c.weight}%</span>
                        <div className="w-28"><ScoreBar score={c.score} /></div>
                        <span className="text-zinc-500 flex-1">{c.detail}</span>
                      </div>
                    ))}
                  </div>
                  {result.alignment.notes.length > 0 && (
                    <div className="mt-2 text-xs text-zinc-500">{result.alignment.notes.join(' · ')}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Benchmarks + dividends */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1">
                vs Benchmarks (year to date) <InfoTip text={PORTFOLIO_YTD_HELP} />
              </div>
              {result.ytd.value == null ? (
                <div className="text-xs text-zinc-500">
                  Current-holdings YTD return unavailable — not enough price history.
                  Benchmark comparison hidden rather than comparing mismatched periods.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-6 flex-wrap">
                    <div>
                      <div className="text-xs text-zinc-500">Current Holdings YTD</div>
                      <div className={`text-lg font-bold ${pctColor(result.ytd.value)}`}>{fmtPctS(result.ytd.value)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-zinc-500">S&amp;P 500 (SPY)</div>
                      <div className={`text-lg font-bold ${pctColor(result.benchmarks.spyYtd)}`}>{fmtPctS(result.benchmarks.spyYtd)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-zinc-500">TSX (XIC)</div>
                      <div className={`text-lg font-bold ${pctColor(result.benchmarks.tsxYtd)}`}>{fmtPctS(result.benchmarks.tsxYtd)}</div>
                    </div>
                  </div>
                  <div className="text-xs text-zinc-600 mt-2">
                    Price return of securities currently held, {result.ytd.periodStart} → today
                    {result.ytd.coverage < 0.99 ? ` · ${(result.ytd.coverage * 100).toFixed(0)}% of value covered` : ''}.
                    Does not account for positions sold, added to or reduced during the year — not a true portfolio return.
                    Excluded from Portfolio Health.
                  </div>
                </>
              )}
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2">Est. Annual Dividend Income</div>
              <div className="text-lg font-bold text-emerald-400">
                {result.annualDividendsCAD > 0 ? `${fmtMoney(result.annualDividendsCAD)} CAD / yr` : '—'}
              </div>
              <div className="text-xs text-zinc-600 mt-2">
                {result.annualDividendsCAD > 0
                  ? `≈ ${fmtMoney(result.annualDividendsCAD / 12)} per month at current indicated yields`
                  : 'No dividend-paying holdings detected'}
              </div>
            </div>
          </div>

          {/* Position cards — one per holding, accounts never merged */}
          <div className="space-y-4">
            {result.reviews.map(r => {
              const style = REVIEW_STATUS_STYLE[r.status];
              const key = `${r.ticker}-${r.account}`;
              const isOpen = expanded === key;
              const broken = !!flags[r.ticker.toUpperCase()]?.thesis_broken;
              return (
                <div key={key} className={`bg-zinc-900 border border-zinc-800 border-l-4 ${style.border} rounded-xl p-5`}>
                  {/* Header */}
                  <div className="flex items-start gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-base font-bold text-zinc-100">{r.ticker}</span>
                        <span className="text-sm text-zinc-500">{r.companyName}</span>
                        {r.isEtf && etfRoleOf(r.ticker) && (
                          <span className="text-xs bg-violet-500/10 text-violet-300 border border-violet-500/30 px-1.5 py-0.5 rounded font-semibold"
                            title="Intended role of this fund in the portfolio — SATELLITE is not inferior to CORE, just a different job">
                            {etfRoleOf(r.ticker)}
                          </span>
                        )}
                        {r.siblingCount > 1 && (
                          <span className="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded">
                            also held in {r.siblingCount - 1} other account{r.siblingCount > 2 ? 's' : ''}
                          </span>
                        )}
                        {r.flags.map(f => (
                          <span key={f} className="text-xs bg-amber-500/10 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded font-semibold">
                            {f}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500 flex-wrap">
                        <span className="text-zinc-400 font-medium">{r.account}</span>
                        <span>·</span>
                        <span>{r.currency}</span>
                        <span>·</span>
                        <span>{r.sectorLabel}</span>
                        <span>·</span>
                        <span>{r.positionPct.toFixed(1)}% of portfolio</span>
                        {r.siblingCount > 1 && (
                          <>
                            <span>·</span>
                            <span className="text-zinc-400">
                              combined {r.companyName} exposure {r.combinedExposurePct.toFixed(1)}%
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 ${style.badge}`}>
                      {statusIcon(r.status)}
                      <span className="text-xs font-semibold">{r.status}</span>
                    </div>
                  </div>

                  {/* Two scores */}
                  <div className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-2">
                    <div>
                      <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                        {r.isEtf ? 'ETF Quality / Role' : 'Company Quality'} <InfoTip text={COMPANY_QUALITY_HELP} />
                        {r.siblingCount > 1 && <span className="text-zinc-700">shared</span>}
                      </div>
                      <ScoreBar score={r.companyQuality.score} tone="violet" />
                    </div>
                    <div>
                      <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                        Position Fit <InfoTip text={POSITION_FIT_HELP} />
                        <span className="text-zinc-700">this account</span>
                      </div>
                      <ScoreBar score={r.positionFit} />
                    </div>
                  </div>

                  {/* Metrics row */}
                  <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {[
                      { label: `Price (${r.currency})`, value: r.currentPrice != null ? `$${fmt2(r.currentPrice)}` : '—' },
                      { label: 'Avg Cost', value: `$${fmt2(r.holding.avg_cost)}` },
                      { label: 'P&L', value: r.pnlPct != null ? `${r.pnlPct >= 0 ? '+' : ''}${fmt2(r.pnlPct, 1)}%` : '—',
                        color: r.pnlPct != null ? (r.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400') : undefined },
                      { label: 'Shares', value: Math.round(r.holding.shares).toLocaleString() },
                      { label: 'Mkt Val', value: `$${Math.round(r.marketValueNative).toLocaleString()}` },
                      { label: r.holding.target_price ? 'To Target' : 'vs Sector 1M',
                        value: r.holding.target_price
                          ? (r.targetRemainingPct != null ? `${r.targetRemainingPct >= 0 ? '+' : ''}${fmt2(r.targetRemainingPct, 1)}%` : '—')
                          : fmtPctS(r.rsVsSector1M),
                        color: r.holding.target_price ? undefined : (r.rsVsSector1M != null ? (r.rsVsSector1M >= 0 ? 'text-emerald-400' : 'text-red-400') : undefined) },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="bg-zinc-800/60 rounded-lg p-2">
                        <div className="text-xs text-zinc-500">{label}</div>
                        <div className={`text-xs font-medium mt-0.5 ${color ?? 'text-zinc-200'}`}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Market context */}
                  {r.sector && (
                    <div className="mt-2 flex items-center gap-3 text-xs flex-wrap">
                      <span className="text-zinc-500">{r.sectorLabel}</span>
                      <span title={describePressure(r.sector.pressure, r.sector.pressureDelta.d5)}
                        className={r.sector.pressure >= 22 ? 'text-emerald-400' : r.sector.pressure <= -22 ? 'text-red-400' : 'text-zinc-400'}>
                        Pressure {signedInt(r.sector.pressure)}{' '}
                        {r.sector.trendArrow === 'up' ? '↑' : r.sector.trendArrow === 'down' ? '↓' : '→'}
                        <span className="text-zinc-600 ml-1">{r.sector.classification}</span>
                      </span>
                      {r.rsVsSector1M != null && (
                        <span className="text-zinc-500">
                          {r.base} vs {r.sectorEtf} 1M:{' '}
                          <span className={r.rsVsSector1M >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtPctS(r.rsVsSector1M)}</span>
                        </span>
                      )}
                      <InfoTip text={PRESSURE_HELP} />
                    </div>
                  )}

                  {/* Pros / cons */}
                  <div className="mt-4 grid sm:grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs font-medium text-emerald-500 flex items-center gap-1.5 mb-2">
                        <TrendingUp size={12} /> What's Going Well
                      </div>
                      {r.pros.length === 0
                        ? <p className="text-xs text-zinc-600 italic">No notable positives</p>
                        : <ul className="space-y-1">{r.pros.map((p, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                              <CheckCircle size={11} className="text-emerald-500 mt-0.5 shrink-0" />{p}
                            </li>))}</ul>}
                    </div>
                    <div>
                      <div className="text-xs font-medium text-red-500 flex items-center gap-1.5 mb-2">
                        <TrendingDown size={12} /> Areas of Concern
                      </div>
                      {r.cons.length === 0
                        ? <p className="text-xs text-zinc-600 italic">No notable concerns</p>
                        : <ul className="space-y-1">{r.cons.map((c, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                              <XCircle size={11} className="text-red-500 mt-0.5 shrink-0" />{c}
                            </li>))}</ul>}
                    </div>
                  </div>

                  {/* Action */}
                  <div className="mt-4 bg-zinc-800/40 border border-zinc-700/40 rounded-lg p-3 flex items-start gap-2">
                    <Zap size={12} className="text-blue-400 mt-0.5 shrink-0" />
                    <div>
                      <span className="text-xs font-medium text-blue-400">Suggested Action: </span>
                      <span className="text-xs text-zinc-300">{r.action}</span>
                    </div>
                  </div>

                  {/* Score detail + thesis marker */}
                  <div className="mt-2 flex items-center gap-4 flex-wrap">
                    <button onClick={() => setExpanded(isOpen ? null : key)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 decoration-dotted">
                      {isOpen ? 'Hide' : 'Show'} score detail
                    </button>
                    <button
                      onClick={() => toggleThesisBroken(r.ticker, !broken)}
                      className={`text-xs flex items-center gap-1 transition-colors ${broken ? 'text-red-400 hover:text-red-300' : 'text-zinc-600 hover:text-zinc-400'}`}
                      title="EXIT is only ever produced by this explicit marker — never inferred from a loss">
                      <Flag size={10} /> {broken ? 'Thesis marked broken — undo' : 'Mark thesis broken'}
                    </button>
                  </div>

                  {isOpen && (
                    <div className="mt-3 pt-3 border-t border-zinc-800 grid sm:grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs font-medium text-zinc-300 mb-2">
                          {r.isEtf ? 'ETF Quality / Role' : 'Company Quality'} {r.companyQuality.score.toFixed(1)} / 10
                          {r.companyQuality.coverage < 1 && !r.isEtf && (
                            <span className="text-zinc-600 ml-1">({(r.companyQuality.coverage * 100).toFixed(0)}% data coverage)</span>
                          )}
                        </div>
                        {r.companyQuality.components.map(c => (
                          <div key={c.label} className="flex items-center gap-2 text-xs py-0.5">
                            <span className="text-zinc-500 flex-1">{c.label}</span>
                            <span className="text-zinc-300 tabular-nums">{c.display}</span>
                            <span className={`w-8 text-right tabular-nums ${c.score == null ? 'text-zinc-700' : 'text-zinc-500'}`}>
                              {c.score == null ? 'n/a' : c.score.toFixed(1)}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="text-xs font-medium text-zinc-300 mb-2">Position Fit {r.positionFit.toFixed(1)} / 10</div>
                        {r.fitComponents.map(c => (
                          <div key={c.label} className="flex items-center gap-2 text-xs py-0.5">
                            <span className="text-zinc-500 flex-1">{c.label}</span>
                            <span className="text-zinc-300 tabular-nums">{c.display}</span>
                            <span className="w-8 text-right tabular-nums text-zinc-500">{c.score.toFixed(1)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="text-xs text-zinc-600 text-center pb-2">
            Generated {result.generatedAt} · Informational portfolio review — not financial advice
          </div>
        </>
      )}

      {!result && !loading && !error && (
        <div className="card p-12 text-center">
          <Star size={32} className="text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">Click <strong className="text-zinc-400">Run Full Review</strong> to analyze every holding.</p>
          <p className="text-zinc-600 text-xs mt-1">Each account holding is reviewed separately; the same company shares one quality score.</p>
        </div>
      )}
    </div>
  );
}
