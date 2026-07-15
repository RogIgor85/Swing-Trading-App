import { useState } from 'react';
import {
  RefreshCw, TrendingUp, TrendingDown, AlertTriangle,
  CheckCircle, XCircle, Star, Shield, Zap, BarChart3, Minus,
} from 'lucide-react';
import { storage } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import type { Holding, FinnhubQuote, FinnhubMetrics, FinnhubProfile } from '../../types';

const MANUAL_PRICES_KEY = 'swing_manual_prices';
const LIVE_PRICES_KEY   = 'swing_live_prices';
const USD_CAD_RATE      = 1.38;

type Rating = 'STRONG HOLD' | 'HOLD' | 'TRIM' | 'WATCH' | 'EXIT';

function baseTickerKey(t: string) {
  return t.replace(/\.(TO|V|TSX|HK|L|AX)$/i, '').toUpperCase();
}

// Detect if two company names refer to the same company (share significant words)
function namesMatch(a: string, b: string): boolean {
  const clean = (s: string) =>
    s.toLowerCase().replace(/\b(inc|corp|ltd|co|plc|lp|llc|the|and|of|company|limited)\b\.?/g, '').trim();
  const ca = clean(a);
  const cb = clean(b);
  const words = ca.split(/\s+/).filter(w => w.length > 3);
  return words.some(w => cb.includes(w));
}

interface PositionData {
  holding: Holding;
  currentPrice: number;
  pnl: number;
  pnlPct: number;
  cadValue: number;
  costCAD: number;
  quote: FinnhubQuote | null;
}

interface GroupReview {
  base: string;
  displayTicker: string;    // actual ticker for single-account, base for multi
  companyName: string;
  sector: string;
  positions: PositionData[];
  totalCadValue: number;
  totalPnLCAD: number;
  totalCostCAD: number;
  allocationPct: number;
  rating: Rating;
  ratingScore: number;
  pros: string[];
  cons: string[];
  action: string;
  flags: string[];
  metrics: FinnhubMetrics['metric'] | null;
}

interface ReviewResult {
  groups: GroupReview[];
  portfolioScore: number;
  totalPnLCAD: number;
  totalCostCAD: number;
  warnings: string[];
  generatedAt: string;
}

// ─── scoring engine ──────────────────────────────────────────────────────────

function generateGroupReview(
  base: string,
  displayTicker: string,
  companyName: string,
  positions: PositionData[],
  allocationPct: number,
  metrics: FinnhubMetrics['metric'] | null,
): GroupReview {
  const pros: string[] = [];
  const cons: string[] = [];
  const flags: string[] = [];
  let score = 5;

  const totalCadValue = positions.reduce((s, p) => s + p.cadValue, 0);
  const totalCostCAD  = positions.reduce((s, p) => s + p.costCAD, 0);
  const totalPnLCAD   = totalCadValue - totalCostCAD;
  const totalPnLPct   = totalCostCAD > 0 ? (totalPnLCAD / totalCostCAD) * 100 : 0;
  const m = metrics;

  // ── Combined P&L ──────────────────────────────────────────────────────────
  if (totalPnLPct >= 25) {
    pros.push(`Up ${totalPnLPct.toFixed(1)}% on combined position — substantial gain`);
    score += 2;
  } else if (totalPnLPct >= 10) {
    pros.push(`Up ${totalPnLPct.toFixed(1)}% on combined position`);
    score += 1.5;
  } else if (totalPnLPct >= 3) {
    pros.push(`Up ${totalPnLPct.toFixed(1)}% from cost basis`);
    score += 0.5;
  } else if (totalPnLPct >= 0) {
    pros.push(`Slightly above cost basis (+${totalPnLPct.toFixed(1)}%)`);
  } else if (totalPnLPct >= -10) {
    cons.push(`Down ${Math.abs(totalPnLPct).toFixed(1)}% combined`);
    score -= 1;
  } else if (totalPnLPct >= -20) {
    cons.push(`Down ${Math.abs(totalPnLPct).toFixed(1)}% combined — consider stop loss`);
    score -= 1.5;
    flags.push('Loss >10%');
  } else {
    cons.push(`Down ${Math.abs(totalPnLPct).toFixed(1)}% combined — significant drawdown`);
    score -= 2.5;
    flags.push('Loss >20% — review thesis');
  }

  // ── Per-position target price ─────────────────────────────────────────────
  for (const p of positions) {
    const tp = p.holding.target_price;
    if (!tp || tp <= 0) continue;
    const price = p.currentPrice;
    const pctToTarget   = ((tp - price) / price) * 100;
    const pctAboveTarget = ((price - tp) / tp) * 100;

    if (price >= tp) {
      if (pctAboveTarget > 100) {
        // Target is very stale — skip silently, no alarm
      } else {
        flags.push(`${p.holding.ticker}: at sell target $${tp}`);
        cons.push(`${p.holding.ticker}: price has reached sell target ($${tp}) — consider taking profits`);
        score -= 0.5;
      }
    } else if (pctToTarget < 5) {
      flags.push(`${p.holding.ticker}: near sell target $${tp}`);
      pros.push(`${p.holding.ticker}: within ${pctToTarget.toFixed(1)}% of sell target ($${tp})`);
    } else {
      pros.push(`${p.holding.ticker}: ${pctToTarget.toFixed(1)}% upside to sell target ($${tp})`);
      score += 0.3;
    }
  }

  // ── 52-week range ─────────────────────────────────────────────────────────
  if (m?.['52WeekHigh'] && m?.['52WeekLow']) {
    const hi = m['52WeekHigh'], lo = m['52WeekLow'];
    const primaryPrice = positions[0].currentPrice;
    const range = hi - lo;
    const pos = range > 0 ? ((primaryPrice - lo) / range) * 100 : 50;
    if (pos >= 80) {
      pros.push(`Near 52-week high (${pos.toFixed(0)}% of range) — strong momentum`);
      score += 1;
    } else if (pos >= 55) {
      pros.push(`Upper half of 52-week range (${pos.toFixed(0)}%)`);
      score += 0.5;
    } else if (pos <= 20) {
      cons.push(`Near 52-week low (${pos.toFixed(0)}% of range) — weak trend`);
      score -= 1.5;
      flags.push('Near 52W low');
    } else if (pos <= 40) {
      cons.push(`Lower portion of 52-week range (${pos.toFixed(0)}%)`);
      score -= 0.5;
    }
  }

  // ── Beta ──────────────────────────────────────────────────────────────────
  if (m?.beta != null) {
    const b = m.beta;
    if (b < 0.8) { pros.push(`Low volatility (Beta ${b.toFixed(2)}) — stable, defensive stock`); score += 0.5; }
    else if (b > 2.2) { cons.push(`Very high volatility (Beta ${b.toFixed(2)}) — large swing risk`); score -= 1; flags.push(`High Beta: ${b.toFixed(2)}`); }
    else if (b > 1.6) { cons.push(`Above-average volatility (Beta ${b.toFixed(2)})`); score -= 0.5; }
  }

  // ── EPS growth ────────────────────────────────────────────────────────────
  if (m?.epsGrowth3Y != null) {
    const g = m.epsGrowth3Y;
    if (g > 25) { pros.push(`Strong EPS growth: ${g.toFixed(1)}% (3-year CAGR)`); score += 1; }
    else if (g > 10) { pros.push(`Solid EPS growth: ${g.toFixed(1)}% (3-year CAGR)`); score += 0.5; }
    else if (g < -5) { cons.push(`Declining earnings: ${g.toFixed(1)}% EPS growth (3-year)`); score -= 1; }
    else if (g < 0) { cons.push(`Flat/negative EPS growth: ${g.toFixed(1)}% (3-year)`); score -= 0.5; }
  }

  // ── Revenue growth ────────────────────────────────────────────────────────
  if (m?.revenueGrowth3Y != null) {
    const g = m.revenueGrowth3Y;
    if (g > 15) { pros.push(`Strong revenue growth: ${g.toFixed(1)}% (3-year CAGR)`); score += 0.5; }
    else if (g < -3) { cons.push(`Declining revenue: ${g.toFixed(1)}% (3-year)`); score -= 0.5; }
  }

  // ── Gross margin ──────────────────────────────────────────────────────────
  if (m?.grossMarginTTM != null) {
    const gm = m.grossMarginTTM;
    if (gm > 65) { pros.push(`Exceptional gross margin (${gm.toFixed(1)}%) — strong pricing power`); score += 1; }
    else if (gm > 40) { pros.push(`Healthy gross margin (${gm.toFixed(1)}%)`); score += 0.5; }
    else if (gm < 15) { cons.push(`Thin gross margin (${gm.toFixed(1)}%) — commoditized`); score -= 0.5; }
  }

  // ── Debt / equity ─────────────────────────────────────────────────────────
  if (m?.debtEquityAnnual != null) {
    const de = m.debtEquityAnnual;
    if (de < 0.3) { pros.push(`Low leverage (D/E: ${de.toFixed(2)}) — strong balance sheet`); score += 0.5; }
    else if (de > 2.0) { cons.push(`High leverage (D/E: ${de.toFixed(2)}) — financial risk`); score -= 1; flags.push(`High D/E: ${de.toFixed(2)}`); }
    else if (de > 1.2) { cons.push(`Elevated debt (D/E: ${de.toFixed(2)})`); score -= 0.5; }
  }

  // ── ROE ───────────────────────────────────────────────────────────────────
  if (m?.roeTTM != null) {
    const roe = m.roeTTM;
    if (roe > 25) { pros.push(`High ROE (${roe.toFixed(1)}%) — excellent capital efficiency`); score += 0.5; }
    else if (roe < 0) { cons.push(`Negative ROE (${roe.toFixed(1)}%) — not generating equity returns`); score -= 1; }
    else if (roe < 5) { cons.push(`Low ROE (${roe.toFixed(1)}%)`); score -= 0.3; }
  }

  // ── P/E ───────────────────────────────────────────────────────────────────
  if (m?.peBasicExclExtraTTM != null) {
    const pe = m.peBasicExclExtraTTM;
    if (pe > 0 && pe < 12) { pros.push(`Attractive valuation (P/E: ${pe.toFixed(1)}x)`); score += 0.5; }
    else if (pe > 70) { cons.push(`Expensive valuation (P/E: ${pe.toFixed(1)}x) — priced for perfection`); score -= 0.5; }
    else if (pe < 0) { cons.push(`Negative earnings (P/E: N/A) — unprofitable on trailing basis`); score -= 0.5; }
  }

  // ── Concentration ─────────────────────────────────────────────────────────
  if (allocationPct > 30) {
    flags.push(`${allocationPct.toFixed(1)}% of portfolio`);
    cons.push(`Overweight (${allocationPct.toFixed(1)}% of portfolio) — concentration risk`);
    score -= 0.5;
  } else if (allocationPct > 20) {
    flags.push(`${allocationPct.toFixed(1)}% of portfolio`);
  }

  score = Math.round(Math.min(10, Math.max(1, score)) * 10) / 10;

  let rating: Rating;
  let action: string;
  if (score >= 7.5) {
    rating = 'STRONG HOLD';
    action = 'High-conviction position. Consider adding on pullbacks. Maintain or increase allocation.';
  } else if (score >= 6) {
    rating = 'HOLD';
    action = 'Continue holding. Set a trailing stop 8–10% below current price to protect gains.';
  } else if (score >= 4.5) {
    rating = 'TRIM';
    action = 'Consider reducing position by 25–50% to lock in gains or limit further downside.';
  } else if (score >= 3) {
    rating = 'WATCH';
    action = 'Monitor closely. Revisit original thesis. Be prepared to exit if price breaks below key support.';
  } else {
    rating = 'EXIT';
    action = 'Thesis may be broken. Consider exiting to redeploy capital into higher-conviction opportunities.';
  }

  const sector = (positions.find(p => p.holding.currency === 'USD') ?? positions[0]).holding.sector;

  return {
    base,
    displayTicker,
    companyName,
    sector,
    positions,
    totalCadValue,
    totalPnLCAD,
    totalCostCAD,
    allocationPct,
    rating,
    ratingScore: score,
    pros,
    cons,
    action,
    flags,
    metrics,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function ratingColor(r: Rating) {
  if (r === 'STRONG HOLD') return 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10';
  if (r === 'HOLD')        return 'text-blue-400 border-blue-500/40 bg-blue-500/10';
  if (r === 'TRIM')        return 'text-amber-400 border-amber-500/40 bg-amber-500/10';
  if (r === 'WATCH')       return 'text-orange-400 border-orange-500/40 bg-orange-500/10';
  return 'text-red-400 border-red-500/40 bg-red-500/10';
}
function ratingBorder(r: Rating) {
  if (r === 'STRONG HOLD') return 'border-l-emerald-500';
  if (r === 'HOLD')        return 'border-l-blue-500';
  if (r === 'TRIM')        return 'border-l-amber-500';
  if (r === 'WATCH')       return 'border-l-orange-500';
  return 'border-l-red-500';
}
function ratingIcon(r: Rating) {
  if (r === 'STRONG HOLD') return <CheckCircle size={14} className="text-emerald-400" />;
  if (r === 'HOLD')        return <Shield size={14} className="text-blue-400" />;
  if (r === 'TRIM')        return <Minus size={14} className="text-amber-400" />;
  if (r === 'WATCH')       return <AlertTriangle size={14} className="text-orange-400" />;
  return <XCircle size={14} className="text-red-400" />;
}

function ScoreBar({ score }: { score: number }) {
  const pct   = (score / 10) * 100;
  const color = score >= 7.5 ? 'bg-emerald-500' : score >= 6 ? 'bg-blue-500' : score >= 4.5 ? 'bg-amber-500' : score >= 3 ? 'bg-orange-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-400 w-6 text-right">{score.toFixed(1)}</span>
    </div>
  );
}

function fmtMoney(n: number) {
  return `$${Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmt2(n: number, d = 2) {
  return n.toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ─── main component ──────────────────────────────────────────────────────────

export default function PortfolioReview() {
  const [result, setResult]     = useState<ReviewResult | null>(null);
  const [loading, setLoading]   = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError]       = useState<string | null>(null);

  async function runReview() {
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const holdings = await storage.getAll<Holding>('holdings');
      if (holdings.length === 0) {
        setError('No holdings found. Add some positions in the Portfolio tab first.');
        setLoading(false);
        return;
      }

      const manualPrices: Record<string, number>             = JSON.parse(localStorage.getItem(MANUAL_PRICES_KEY) ?? '{}');
      const livePricesCache: Record<string, { price: number }> = JSON.parse(localStorage.getItem(LIVE_PRICES_KEY) ?? '{}');

      setProgress({ current: 0, total: holdings.length });

      type RawData = {
        holding: Holding;
        quote: FinnhubQuote | null;
        metrics: FinnhubMetrics['metric'] | null;
        profile: FinnhubProfile | null;
        companyName: string;     // correct name (Yahoo-verified for .TO tickers)
        currentPrice: number;
        cadValue: number;
        costCAD: number;
      };

      const rawResults = await Promise.allSettled(
        holdings.map(async (h): Promise<RawData> => {
          const isCAD = /\.TO$/i.test(h.ticker);
          const ft    = baseTickerKey(h.ticker);   // e.g. MSFT, T, SHOP

          const [qRes, mRes, pRes, yRes] = await Promise.allSettled([
            finnhub.quote(ft),
            finnhub.metrics(ft),
            finnhub.profile(ft),
            isCAD ? fetchYahoo(h.ticker) : Promise.resolve(null),
          ]);

          const quote      = qRes.status === 'fulfilled' ? qRes.value : null;
          const metricsRaw = mRes.status === 'fulfilled' ? mRes.value?.metric ?? null : null;
          const profile    = pRes.status === 'fulfilled' ? pRes.value : null;
          const yahoo      = yRes.status === 'fulfilled' ? yRes.value : null;

          // Prefer Yahoo company name for .TO tickers (avoids e.g. T.TO → "AT&T")
          const yahooName = (yahoo as Awaited<ReturnType<typeof fetchYahoo>> | null)?.price?.longName
                         ?? (yahoo as Awaited<ReturnType<typeof fetchYahoo>> | null)?.price?.shortName
                         ?? null;

          // Validate Finnhub metrics: if Finnhub and Yahoo names don't match,
          // Finnhub is returning data for a different company (ticker collision)
          let validMetrics = metricsRaw;
          if (isCAD && yahooName && profile?.name) {
            if (!namesMatch(profile.name, yahooName)) {
              validMetrics = null;  // e.g. AT&T metrics for Telus — discard
            }
          }

          const companyName = yahooName ?? profile?.name ?? h.ticker;

          const livePrice    = quote?.c && quote.c > 0 ? quote.c : null;
          const currentPrice = manualPrices[h.ticker] ?? livePrice ?? livePricesCache[h.ticker]?.price ?? h.avg_cost;
          const mktValue     = h.shares * currentPrice;
          const cadValue     = h.currency === 'USD' ? mktValue * USD_CAD_RATE : mktValue;
          const costCAD      = h.shares * h.avg_cost * (h.currency === 'USD' ? USD_CAD_RATE : 1);

          setProgress(p => ({ ...p, current: p.current + 1 }));
          return { holding: h, quote, metrics: validMetrics, profile, companyName, currentPrice, cadValue, costCAD };
        })
      );

      const rows: RawData[] = rawResults
        .filter((r): r is PromiseFulfilledResult<RawData> => r.status === 'fulfilled')
        .map(r => r.value);

      const totalPortfolioCAD = rows.reduce((s, r) => s + r.cadValue, 0);

      // Group by base ticker (MSFT.TO + MSFT → one card)
      const groupMap = new Map<string, RawData[]>();
      for (const row of rows) {
        const key = baseTickerKey(row.holding.ticker);
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key)!.push(row);
      }

      const groups: GroupReview[] = [];
      for (const [base, members] of groupMap.entries()) {
        const groupCadValue = members.reduce((s, m) => s + m.cadValue, 0);
        const allocationPct = totalPortfolioCAD > 0 ? (groupCadValue / totalPortfolioCAD) * 100 : 0;

        // For display: single account → show actual ticker (e.g. T.TO, SHOP.TO)
        //              multiple accounts → show base (e.g. MSFT)
        const displayTicker = members.length === 1 ? members[0].holding.ticker : base;

        // Company name: prefer USD member's name (Finnhub better for US), fallback to first
        const primary     = members.find(m => m.holding.currency === 'USD') ?? members[0];
        const companyName = primary.companyName || base;

        const positions: PositionData[] = members.map(m => ({
          holding:      m.holding,
          currentPrice: m.currentPrice,
          pnl:          (m.currentPrice - m.holding.avg_cost) * m.holding.shares,
          pnlPct:       m.holding.avg_cost > 0 ? ((m.currentPrice - m.holding.avg_cost) / m.holding.avg_cost) * 100 : 0,
          cadValue:     m.cadValue,
          costCAD:      m.costCAD,
          quote:        m.quote,
        }));

        const group = generateGroupReview(
          base,
          displayTicker,
          companyName,
          positions,
          allocationPct,
          primary.metrics,
        );
        groups.push(group);
      }

      groups.sort((a, b) => b.ratingScore - a.ratingScore);

      const totalPnLCAD    = rows.reduce((s, r) => s + (r.cadValue - r.costCAD), 0);
      const totalCostCAD   = rows.reduce((s, r) => s + r.costCAD, 0);
      const portfolioScore = groups.reduce((s, g) => s + g.ratingScore, 0) / groups.length;

      const warnings: string[] = [];
      const exitCnt  = groups.filter(g => g.rating === 'EXIT').length;
      const watchCnt = groups.filter(g => g.rating === 'WATCH').length;
      const trimCnt  = groups.filter(g => g.rating === 'TRIM').length;
      const heaviest = groups.reduce((a, b) => a.allocationPct > b.allocationPct ? a : b);
      if (exitCnt  > 0) warnings.push(`${exitCnt} position${exitCnt > 1 ? 's' : ''} flagged for EXIT`);
      if (watchCnt > 0) warnings.push(`${watchCnt} position${watchCnt > 1 ? 's' : ''} on WATCH`);
      if (trimCnt  > 0) warnings.push(`${trimCnt} position${trimCnt > 1 ? 's' : ''} suggest TRIM`);
      if (heaviest.allocationPct > 30) warnings.push(`${heaviest.displayTicker} is ${heaviest.allocationPct.toFixed(1)}% of portfolio`);

      setResult({
        groups,
        portfolioScore,
        totalPnLCAD,
        totalCostCAD,
        warnings,
        generatedAt: new Date().toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }),
      });
    } catch (e) {
      setError('Failed to load portfolio data. Check your connection and try again.');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  function portfolioLabel(score: number) {
    if (score >= 7.5) return { text: 'STRONG',  color: 'text-emerald-400' };
    if (score >= 6)   return { text: 'HEALTHY', color: 'text-blue-400'   };
    if (score >= 4.5) return { text: 'MIXED',   color: 'text-amber-400'  };
    if (score >= 3)   return { text: 'AT RISK', color: 'text-orange-400' };
    return { text: 'CRITICAL', color: 'text-red-400' };
  }

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <BarChart3 size={16} className="text-blue-400" />
              Portfolio Review
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              Rule-based analysis of every position — same company across accounts grouped into one card
            </p>
          </div>
          <button
            onClick={runReview}
            disabled={loading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? `Analyzing ${progress.current} / ${progress.total}…` : 'Run Full Review'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-800/40 rounded-xl p-4 text-sm text-red-400">{error}</div>
      )}

      {loading && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center">
          <div className="inline-flex items-center gap-3 text-zinc-400 text-sm">
            <RefreshCw size={16} className="animate-spin text-blue-400" />
            Fetching live data and calculating scores…
          </div>
          <div className="mt-4 h-1.5 bg-zinc-800 rounded-full overflow-hidden max-w-sm mx-auto">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }}
            />
          </div>
        </div>
      )}

      {result && !loading && (
        <>
          {/* Summary bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 col-span-2 sm:col-span-1">
              <div className="text-xs text-zinc-500 mb-1">Portfolio Health</div>
              <div className={`text-2xl font-bold ${portfolioLabel(result.portfolioScore).color}`}>
                {portfolioLabel(result.portfolioScore).text}
              </div>
              <div className="mt-2"><ScoreBar score={result.portfolioScore} /></div>
              <div className="text-xs text-zinc-600 mt-1">avg {result.portfolioScore.toFixed(1)} / 10</div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-1">Total P&amp;L (CAD)</div>
              <div className={`text-xl font-bold ${result.totalPnLCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.totalPnLCAD >= 0 ? '+' : '-'}{fmtMoney(result.totalPnLCAD)}
              </div>
              <div className={`text-xs mt-1 ${result.totalPnLCAD >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {result.totalCostCAD > 0 ? `${result.totalPnLCAD >= 0 ? '+' : ''}${fmt2((result.totalPnLCAD / result.totalCostCAD) * 100, 1)}% on cost` : '—'}
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2">Rating Breakdown</div>
              <div className="space-y-1">
                {(['STRONG HOLD', 'HOLD', 'TRIM', 'WATCH', 'EXIT'] as Rating[]).map(r => {
                  const count = result.groups.filter(g => g.rating === r).length;
                  if (count === 0) return null;
                  return (
                    <div key={r} className="flex items-center gap-2">
                      {ratingIcon(r)}
                      <span className="text-xs text-zinc-400 flex-1">{r}</span>
                      <span className="text-xs font-medium text-zinc-300">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1.5">
                <AlertTriangle size={11} className="text-amber-500" /> Alerts
              </div>
              {result.warnings.length === 0
                ? <div className="text-xs text-zinc-600">No critical alerts</div>
                : <ul className="space-y-1">{result.warnings.map((w, i) => <li key={i} className="text-xs text-amber-400">{w}</li>)}</ul>
              }
            </div>
          </div>

          {/* Per-company cards */}
          <div className="space-y-4">
            {result.groups.map(g => (
              <div
                key={g.base}
                className={`bg-zinc-900 border border-zinc-800 border-l-4 ${ratingBorder(g.rating)} rounded-xl p-5`}
              >
                {/* Card header */}
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold text-zinc-100">{g.displayTicker}</span>
                      {g.companyName !== g.displayTicker && (
                        <span className="text-sm text-zinc-500">{g.companyName}</span>
                      )}
                      {g.flags.map((f, i) => (
                        <span key={i} className="text-xs bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <AlertTriangle size={10} className="text-amber-500" />
                          {f}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500 flex-wrap">
                      <span>{g.sector || '—'}</span>
                      <span>·</span>
                      <span>{g.positions.length > 1 ? `${g.positions.length} accounts` : g.positions[0].holding.account}</span>
                      <span>·</span>
                      <span>{g.allocationPct.toFixed(1)}% of portfolio</span>
                    </div>
                  </div>
                  <div className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 ${ratingColor(g.rating)}`}>
                    {ratingIcon(g.rating)}
                    <span className="text-xs font-semibold">{g.rating}</span>
                  </div>
                </div>

                <div className="mt-3"><ScoreBar score={g.ratingScore} /></div>

                {/* Positions table */}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-500 border-b border-zinc-800">
                        <th className="text-left pb-1.5 font-medium">Ticker</th>
                        <th className="text-left pb-1.5 font-medium">Account</th>
                        <th className="text-left pb-1.5 font-medium">Curr</th>
                        <th className="text-right pb-1.5 font-medium">Shares</th>
                        <th className="text-right pb-1.5 font-medium">Avg Cost</th>
                        <th className="text-right pb-1.5 font-medium">Price</th>
                        <th className="text-right pb-1.5 font-medium">P&amp;L</th>
                        <th className="text-right pb-1.5 font-medium">Mkt Val</th>
                        <th className="text-right pb-1.5 font-medium">Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.positions.map((p, i) => (
                        <tr key={i} className="border-b border-zinc-800/50 last:border-0">
                          <td className="py-1.5 font-medium text-zinc-300">{p.holding.ticker}</td>
                          <td className="py-1.5 text-zinc-400">{p.holding.account}</td>
                          <td className="py-1.5 text-zinc-400">{p.holding.currency}</td>
                          <td className="py-1.5 text-right text-zinc-300">{Math.round(p.holding.shares).toLocaleString()}</td>
                          <td className="py-1.5 text-right text-zinc-300">${fmt2(p.holding.avg_cost)}</td>
                          <td className="py-1.5 text-right text-zinc-300">${fmt2(p.currentPrice)}</td>
                          <td className={`py-1.5 text-right font-medium ${p.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {p.pnlPct >= 0 ? '+' : ''}{fmt2(p.pnlPct, 1)}%
                          </td>
                          <td className="py-1.5 text-right text-zinc-300">
                            ${(p.currentPrice * p.holding.shares).toLocaleString('en-CA', { maximumFractionDigits: 0 })}
                          </td>
                          <td className="py-1.5 text-right text-zinc-400">
                            {p.holding.target_price ? `$${fmt2(p.holding.target_price)}` : '—'}
                          </td>
                        </tr>
                      ))}
                      {g.positions.length > 1 && (
                        <tr className="text-zinc-400 font-medium">
                          <td colSpan={6} className="pt-2 text-xs">Combined</td>
                          <td className={`pt-2 text-right text-xs font-medium ${g.totalPnLCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {g.totalPnLCAD >= 0 ? '+' : '-'}{fmtMoney(g.totalPnLCAD)} CAD
                          </td>
                          <td className="pt-2 text-right text-xs text-zinc-300">{fmtMoney(g.totalCadValue)} CAD</td>
                          <td />
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pros / Cons */}
                <div className="mt-4 grid sm:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs font-medium text-emerald-500 flex items-center gap-1.5 mb-2">
                      <TrendingUp size={12} /> What's Going Well
                    </div>
                    {g.pros.length === 0
                      ? <p className="text-xs text-zinc-600 italic">No notable positives at this time</p>
                      : <ul className="space-y-1">{g.pros.map((p, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                            <CheckCircle size={11} className="text-emerald-500 mt-0.5 shrink-0" />
                            {p}
                          </li>
                        ))}</ul>
                    }
                  </div>
                  <div>
                    <div className="text-xs font-medium text-red-500 flex items-center gap-1.5 mb-2">
                      <TrendingDown size={12} /> Areas of Concern
                    </div>
                    {g.cons.length === 0
                      ? <p className="text-xs text-zinc-600 italic">No notable concerns at this time</p>
                      : <ul className="space-y-1">{g.cons.map((c, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                            <XCircle size={11} className="text-red-500 mt-0.5 shrink-0" />
                            {c}
                          </li>
                        ))}</ul>
                    }
                  </div>
                </div>

                {/* Suggested action */}
                <div className="mt-4 bg-zinc-800/40 border border-zinc-700/40 rounded-lg p-3 flex items-start gap-2">
                  <Zap size={12} className="text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <span className="text-xs font-medium text-blue-400">Suggested Action: </span>
                    <span className="text-xs text-zinc-300">{g.action}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="text-xs text-zinc-600 text-center pb-2">
            Generated {result.generatedAt} · For informational purposes only — not financial advice
          </div>
        </>
      )}

      {!result && !loading && !error && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center">
          <Star size={32} className="text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">
            Click <strong className="text-zinc-400">Run Full Review</strong> to analyze every position.
          </p>
          <p className="text-zinc-600 text-xs mt-1">Holdings of the same company across accounts are grouped into one card.</p>
        </div>
      )}
    </div>
  );
}
