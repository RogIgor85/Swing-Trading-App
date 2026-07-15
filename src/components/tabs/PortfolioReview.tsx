import { useState } from 'react';
import {
  RefreshCw, TrendingUp, TrendingDown, Minus, AlertTriangle,
  CheckCircle, XCircle, Star, Shield, Zap, Target, BarChart3,
} from 'lucide-react';
import { storage } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import type { Holding, FinnhubQuote, FinnhubMetrics, FinnhubProfile } from '../../types';

const MANUAL_PRICES_KEY = 'swing_manual_prices';
const LIVE_PRICES_KEY   = 'swing_live_prices';
const USD_CAD_RATE      = 1.38;

type Rating = 'STRONG HOLD' | 'HOLD' | 'TRIM' | 'WATCH' | 'EXIT';

interface StockReview {
  ticker: string;
  companyName: string;
  sector: string;
  account: string;
  currency: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  targetPrice: number | null;
  pnl: number;
  pnlPct: number;
  allocationPct: number;
  rating: Rating;
  ratingScore: number;
  pros: string[];
  cons: string[];
  action: string;
  flags: string[];
  metrics: FinnhubMetrics['metric'] | null;
  quote: FinnhubQuote | null;
}

interface ReviewResult {
  reviews: StockReview[];
  portfolioScore: number;
  totalPnLCAD: number;
  totalCostCAD: number;
  warnings: string[];
  generatedAt: string;
}

// ─── scoring engine ──────────────────────────────────────────────────────────

function generateReview(
  h: Holding,
  currentPrice: number,
  allocationPct: number,
  quote: FinnhubQuote | null,
  metricsRaw: FinnhubMetrics['metric'] | null,
  profile: FinnhubProfile | null,
): StockReview {
  const pros: string[] = [];
  const cons: string[] = [];
  const flags: string[] = [];
  let score = 5;

  const pnl    = (currentPrice - h.avg_cost) * h.shares;
  const pnlPct = h.avg_cost > 0 ? ((currentPrice - h.avg_cost) / h.avg_cost) * 100 : 0;
  const m      = metricsRaw;

  // ── P&L vs entry ──────────────────────────────────────────────────────────
  if (pnlPct >= 25) {
    pros.push(`Up ${pnlPct.toFixed(1)}% from entry — substantial gain`);
    score += 2;
  } else if (pnlPct >= 10) {
    pros.push(`Up ${pnlPct.toFixed(1)}% from entry`);
    score += 1.5;
  } else if (pnlPct >= 3) {
    pros.push(`Up ${pnlPct.toFixed(1)}% from entry`);
    score += 0.5;
  } else if (pnlPct >= 0) {
    pros.push(`Slightly above entry (+${pnlPct.toFixed(1)}%)`);
  } else if (pnlPct >= -10) {
    cons.push(`Down ${Math.abs(pnlPct).toFixed(1)}% from entry`);
    score -= 1;
  } else if (pnlPct >= -20) {
    cons.push(`Down ${Math.abs(pnlPct).toFixed(1)}% from entry — consider stop loss`);
    score -= 1.5;
    flags.push(`Loss >10%`);
  } else {
    cons.push(`Down ${Math.abs(pnlPct).toFixed(1)}% from entry — significant drawdown`);
    score -= 2.5;
    flags.push(`Loss >20% — review thesis`);
  }

  // ── Target price proximity ────────────────────────────────────────────────
  if (h.target_price && h.target_price > 0) {
    const pctToTarget = ((h.target_price - currentPrice) / currentPrice) * 100;
    if (currentPrice >= h.target_price) {
      flags.push(`At/above sell target $${h.target_price}`);
      cons.push(`Price has reached your sell target ($${h.target_price}) — consider taking profits`);
      score -= 0.5;
    } else if (pctToTarget < 5) {
      flags.push(`Near sell target ($${h.target_price})`);
      pros.push(`Within ${pctToTarget.toFixed(1)}% of sell target — approaching objective`);
    } else {
      pros.push(`${pctToTarget.toFixed(1)}% upside to sell target ($${h.target_price})`);
      score += 0.3;
    }
  }

  // ── 52-week range position ────────────────────────────────────────────────
  if (m?.['52WeekHigh'] && m?.['52WeekLow']) {
    const hi = m['52WeekHigh'], lo = m['52WeekLow'];
    const range = hi - lo;
    const pos   = range > 0 ? ((currentPrice - lo) / range) * 100 : 50;
    if (pos >= 80) {
      pros.push(`Near 52-week high (${pos.toFixed(0)}% of range) — strong momentum`);
      score += 1;
    } else if (pos >= 55) {
      pros.push(`Upper half of 52-week range (${pos.toFixed(0)}%)`);
      score += 0.5;
    } else if (pos <= 20) {
      cons.push(`Near 52-week low (${pos.toFixed(0)}% of range) — weak trend`);
      score -= 1.5;
      flags.push(`Near 52W low`);
    } else if (pos <= 40) {
      cons.push(`Lower portion of 52-week range (${pos.toFixed(0)}%)`);
      score -= 0.5;
    }
  }

  // ── Beta / volatility ─────────────────────────────────────────────────────
  if (m?.beta != null) {
    const b = m.beta;
    if (b < 0.8) {
      pros.push(`Low volatility (Beta ${b.toFixed(2)}) — stable, defensive stock`);
      score += 0.5;
    } else if (b > 2.2) {
      cons.push(`Very high volatility (Beta ${b.toFixed(2)}) — large swing risk`);
      score -= 1;
      flags.push(`High Beta: ${b.toFixed(2)}`);
    } else if (b > 1.6) {
      cons.push(`Above-average volatility (Beta ${b.toFixed(2)})`);
      score -= 0.5;
    }
  }

  // ── EPS growth ────────────────────────────────────────────────────────────
  if (m?.epsGrowth3Y != null) {
    const g = m.epsGrowth3Y;
    if (g > 25) {
      pros.push(`Strong EPS growth: ${g.toFixed(1)}% (3-year CAGR)`);
      score += 1;
    } else if (g > 10) {
      pros.push(`Solid EPS growth: ${g.toFixed(1)}% (3-year CAGR)`);
      score += 0.5;
    } else if (g < -5) {
      cons.push(`Declining earnings: ${g.toFixed(1)}% EPS growth (3-year)`);
      score -= 1;
    } else if (g < 0) {
      cons.push(`Flat/negative EPS growth: ${g.toFixed(1)}% (3-year)`);
      score -= 0.5;
    }
  }

  // ── Revenue growth ────────────────────────────────────────────────────────
  if (m?.revenueGrowth3Y != null) {
    const g = m.revenueGrowth3Y;
    if (g > 15) {
      pros.push(`Strong revenue growth: ${g.toFixed(1)}% (3-year CAGR)`);
      score += 0.5;
    } else if (g < -3) {
      cons.push(`Declining revenue: ${g.toFixed(1)}% (3-year)`);
      score -= 0.5;
    }
  }

  // ── Gross margin ──────────────────────────────────────────────────────────
  if (m?.grossMarginTTM != null) {
    const gm = m.grossMarginTTM;
    if (gm > 65) {
      pros.push(`Exceptional gross margin (${gm.toFixed(1)}%) — strong pricing power`);
      score += 1;
    } else if (gm > 40) {
      pros.push(`Healthy gross margin (${gm.toFixed(1)}%)`);
      score += 0.5;
    } else if (gm < 15) {
      cons.push(`Thin gross margin (${gm.toFixed(1)}%) — commoditized / price-competitive`);
      score -= 0.5;
    }
  }

  // ── Debt / equity ─────────────────────────────────────────────────────────
  if (m?.debtEquityAnnual != null) {
    const de = m.debtEquityAnnual;
    if (de < 0.3) {
      pros.push(`Low leverage (D/E: ${de.toFixed(2)}) — strong balance sheet`);
      score += 0.5;
    } else if (de > 2.0) {
      cons.push(`High leverage (D/E: ${de.toFixed(2)}) — financial risk in rising rate env.`);
      score -= 1;
      flags.push(`High D/E: ${de.toFixed(2)}`);
    } else if (de > 1.2) {
      cons.push(`Elevated debt (D/E: ${de.toFixed(2)})`);
      score -= 0.5;
    }
  }

  // ── ROE ───────────────────────────────────────────────────────────────────
  if (m?.roeTTM != null) {
    const roe = m.roeTTM;
    if (roe > 25) {
      pros.push(`High ROE (${roe.toFixed(1)}%) — excellent capital efficiency`);
      score += 0.5;
    } else if (roe < 0) {
      cons.push(`Negative ROE (${roe.toFixed(1)}%) — not generating returns on equity`);
      score -= 1;
    } else if (roe < 5) {
      cons.push(`Low ROE (${roe.toFixed(1)}%) — poor capital efficiency`);
      score -= 0.3;
    }
  }

  // ── Valuation (P/E) ───────────────────────────────────────────────────────
  if (m?.peBasicExclExtraTTM != null) {
    const pe = m.peBasicExclExtraTTM;
    if (pe > 0 && pe < 12) {
      pros.push(`Attractive valuation (P/E: ${pe.toFixed(1)}x) — potential value play`);
      score += 0.5;
    } else if (pe > 70) {
      cons.push(`Expensive valuation (P/E: ${pe.toFixed(1)}x) — priced for perfection`);
      score -= 0.5;
    } else if (pe < 0) {
      cons.push(`Negative earnings (P/E: N/A) — unprofitable on trailing basis`);
      score -= 0.5;
    }
  }

  // ── Concentration ─────────────────────────────────────────────────────────
  if (allocationPct > 30) {
    flags.push(`${allocationPct.toFixed(1)}% portfolio weight`);
    cons.push(`Overweight position (${allocationPct.toFixed(1)}% of portfolio) — concentration risk`);
    score -= 0.5;
  } else if (allocationPct > 20) {
    flags.push(`${allocationPct.toFixed(1)}% portfolio weight`);
  }

  // ── Day move ──────────────────────────────────────────────────────────────
  if (quote?.dp != null) {
    if (quote.dp > 5) {
      pros.push(`Up ${quote.dp.toFixed(2)}% today — strong momentum`);
    } else if (quote.dp < -5) {
      cons.push(`Down ${Math.abs(quote.dp).toFixed(2)}% today — significant selling`);
      flags.push(`Down ${Math.abs(quote.dp).toFixed(1)}% today`);
    }
  }

  // ── Clamp score ───────────────────────────────────────────────────────────
  score = Math.round(Math.min(10, Math.max(1, score)) * 10) / 10;

  let rating: Rating;
  let action: string;

  if (score >= 7.5) {
    rating = 'STRONG HOLD';
    action = 'High-conviction position. Consider adding on pullbacks to key support. Maintain or increase allocation.';
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

  return {
    ticker: h.ticker,
    companyName: profile?.name ?? h.ticker,
    sector: h.sector,
    account: h.account,
    currency: h.currency,
    shares: h.shares,
    avgCost: h.avg_cost,
    currentPrice,
    targetPrice: h.target_price,
    pnl,
    pnlPct,
    allocationPct,
    rating,
    ratingScore: score,
    pros,
    cons,
    action,
    flags,
    metrics: metricsRaw,
    quote,
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

function scoreBar(score: number) {
  const pct = (score / 10) * 100;
  const color =
    score >= 7.5 ? 'bg-emerald-500'
    : score >= 6 ? 'bg-blue-500'
    : score >= 4.5 ? 'bg-amber-500'
    : score >= 3 ? 'bg-orange-500'
    : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-400 w-6 text-right">{score.toFixed(1)}</span>
    </div>
  );
}

function fmt2(n: number, d = 2) {
  return n.toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtCAD(n: number) {
  return `$${Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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

      const manualPrices: Record<string, number> =
        JSON.parse(localStorage.getItem(MANUAL_PRICES_KEY) ?? '{}');
      const livePricesCache: Record<string, { price: number }> =
        JSON.parse(localStorage.getItem(LIVE_PRICES_KEY) ?? '{}');

      setProgress({ current: 0, total: holdings.length });

      const results = await Promise.allSettled(
        holdings.map(async (h) => {
          const finnhubTicker = h.ticker.replace(/\.TO$/i, '');

          const [qRes, mRes, pRes] = await Promise.allSettled([
            finnhub.quote(finnhubTicker),
            finnhub.metrics(finnhubTicker),
            finnhub.profile(finnhubTicker),
          ]);

          const quote   = qRes.status === 'fulfilled' ? qRes.value   : null;
          const metrics = mRes.status === 'fulfilled' ? mRes.value?.metric ?? null : null;
          const profile = pRes.status === 'fulfilled' ? pRes.value   : null;

          const livePrice = quote?.c && quote.c > 0 ? quote.c : null;
          const currentPrice =
            manualPrices[h.ticker]
            ?? livePrice
            ?? livePricesCache[h.ticker]?.price
            ?? h.avg_cost;

          const mktValue   = h.shares * currentPrice;
          const cadValue   = h.currency === 'USD' ? mktValue * USD_CAD_RATE : mktValue;
          const costCAD    = h.shares * h.avg_cost * (h.currency === 'USD' ? USD_CAD_RATE : 1);

          setProgress(p => ({ ...p, current: p.current + 1 }));
          return { h, quote, metrics, profile, currentPrice, cadValue, costCAD };
        })
      );

      type HoldingData = {
        h: Holding;
        quote: FinnhubQuote | null;
        metrics: FinnhubMetrics['metric'] | null;
        profile: FinnhubProfile | null;
        currentPrice: number;
        cadValue: number;
        costCAD: number;
      };

      const fulfilled = (results
        .filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<HoldingData>[])
        .map(r => r.value);

      const totalValueCAD = fulfilled.reduce((s, r) => s + r.cadValue, 0);
      const totalCostCAD  = fulfilled.reduce((s, r) => s + r.costCAD, 0);

      const reviews: StockReview[] = fulfilled.map(({ h, quote, metrics, profile, currentPrice, cadValue }) => {
        const allocationPct = totalValueCAD > 0 ? (cadValue / totalValueCAD) * 100 : 0;
        return generateReview(h, currentPrice, allocationPct, quote, metrics, profile);
      });

      reviews.sort((a, b) => b.ratingScore - a.ratingScore);

      const totalPnLCAD     = totalValueCAD - totalCostCAD;
      const portfolioScore  = reviews.reduce((s, r) => s + r.ratingScore, 0) / reviews.length;

      const warnings: string[] = [];
      const exitCount  = reviews.filter(r => r.rating === 'EXIT').length;
      const watchCount = reviews.filter(r => r.rating === 'WATCH').length;
      const trimCount  = reviews.filter(r => r.rating === 'TRIM').length;
      const heaviest   = reviews.reduce((a, b) => a.allocationPct > b.allocationPct ? a : b);
      if (exitCount  > 0) warnings.push(`${exitCount} position${exitCount > 1 ? 's' : ''} flagged for EXIT`);
      if (watchCount > 0) warnings.push(`${watchCount} position${watchCount > 1 ? 's' : ''} on WATCH`);
      if (trimCount  > 0) warnings.push(`${trimCount} position${trimCount > 1 ? 's' : ''} suggest TRIM`);
      if (heaviest.allocationPct > 30) warnings.push(`${heaviest.ticker} is ${heaviest.allocationPct.toFixed(1)}% of portfolio — concentration risk`);

      setResult({
        reviews,
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

  // ── portfolio score label ────────────────────────────────────────────────
  function portfolioLabel(score: number) {
    if (score >= 7.5) return { text: 'STRONG', color: 'text-emerald-400' };
    if (score >= 6)   return { text: 'HEALTHY', color: 'text-blue-400' };
    if (score >= 4.5) return { text: 'MIXED', color: 'text-amber-400' };
    if (score >= 3)   return { text: 'AT RISK', color: 'text-orange-400' };
    return { text: 'CRITICAL', color: 'text-red-400' };
  }

  return (
    <div className="space-y-5">

      {/* ── Header card ───────────────────────────────────────────────────── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <BarChart3 size={16} className="text-blue-400" />
              Portfolio Review
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              Rule-based analysis of every position — fundamentals, technicals, risk &amp; allocation
            </p>
          </div>
          <button
            onClick={runReview}
            disabled={loading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading
              ? `Analyzing ${progress.current} / ${progress.total}…`
              : 'Run Full Review'}
          </button>
        </div>

        {/* factors legend */}
        <div className="mt-4 flex flex-wrap gap-3 text-xs text-zinc-500">
          {[
            ['P&L Position', 'entry vs current price'],
            ['52W Range', 'technical strength'],
            ['Beta / Risk', 'volatility profile'],
            ['Growth', 'EPS & revenue trends'],
            ['Margins & ROE', 'quality metrics'],
            ['Valuation', 'P/E ratio'],
            ['Leverage', 'debt/equity'],
            ['Concentration', 'portfolio weight'],
          ].map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
              <span className="text-zinc-400">{k}</span>
              <span className="hidden sm:inline">· {v}</span>
            </span>
          ))}
        </div>
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <div className="bg-red-950/40 border border-red-800/40 rounded-xl p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Loading skeleton ──────────────────────────────────────────────── */}
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

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {result && !loading && (
        <>
          {/* Portfolio summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Overall health */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 col-span-2 sm:col-span-1">
              <div className="text-xs text-zinc-500 mb-1">Portfolio Health</div>
              <div className={`text-2xl font-bold ${portfolioLabel(result.portfolioScore).color}`}>
                {portfolioLabel(result.portfolioScore).text}
              </div>
              <div className="mt-2">{scoreBar(result.portfolioScore)}</div>
              <div className="text-xs text-zinc-600 mt-1">avg score {result.portfolioScore.toFixed(1)} / 10</div>
            </div>

            {/* Total P&L */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-1">Total P&amp;L (CAD)</div>
              <div className={`text-xl font-bold ${result.totalPnLCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.totalPnLCAD >= 0 ? '+' : '-'}{fmtCAD(result.totalPnLCAD)}
              </div>
              <div className={`text-xs mt-1 ${result.totalPnLCAD >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {result.totalCostCAD > 0
                  ? `${result.totalPnLCAD >= 0 ? '+' : ''}${fmt2((result.totalPnLCAD / result.totalCostCAD) * 100, 1)}% on cost`
                  : '—'}
              </div>
            </div>

            {/* Rating distribution */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2">Rating Breakdown</div>
              <div className="space-y-1">
                {(['STRONG HOLD', 'HOLD', 'TRIM', 'WATCH', 'EXIT'] as Rating[]).map(r => {
                  const count = result.reviews.filter(x => x.rating === r).length;
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

            {/* Warnings */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1.5">
                <AlertTriangle size={11} className="text-amber-500" />
                Alerts
              </div>
              {result.warnings.length === 0 ? (
                <div className="text-xs text-zinc-600">No critical alerts</div>
              ) : (
                <ul className="space-y-1">
                  {result.warnings.map((w, i) => (
                    <li key={i} className="text-xs text-amber-400">{w}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Per-stock cards */}
          <div className="space-y-4">
            {result.reviews.map(r => (
              <div
                key={r.ticker}
                className={`bg-zinc-900 border border-zinc-800 border-l-4 ${ratingBorder(r.rating)} rounded-xl p-5`}
              >
                {/* Stock header */}
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold text-zinc-100">{r.ticker}</span>
                      {r.companyName !== r.ticker && (
                        <span className="text-sm text-zinc-500 truncate">{r.companyName}</span>
                      )}
                      {r.flags.map((f, i) => (
                        <span key={i} className="text-xs bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <AlertTriangle size={10} className="text-amber-500" />
                          {f}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap text-xs text-zinc-500">
                      <span>{r.sector || '—'}</span>
                      <span>·</span>
                      <span>{r.account}</span>
                      <span>·</span>
                      <span>{r.currency}</span>
                      <span>·</span>
                      <span>{r.allocationPct.toFixed(1)}% of portfolio</span>
                    </div>
                  </div>

                  {/* Rating badge */}
                  <div className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 ${ratingColor(r.rating)}`}>
                    {ratingIcon(r.rating)}
                    <span className="text-xs font-semibold">{r.rating}</span>
                  </div>
                </div>

                {/* Score bar */}
                <div className="mt-3">
                  {scoreBar(r.ratingScore)}
                </div>

                {/* Key metrics row */}
                <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {[
                    { label: 'Price', value: `$${fmt2(r.currentPrice)}` },
                    { label: 'Avg Cost', value: `$${fmt2(r.avgCost)}` },
                    {
                      label: 'P&L',
                      value: `${r.pnlPct >= 0 ? '+' : ''}${fmt2(r.pnlPct, 1)}%`,
                      color: r.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400',
                    },
                    { label: 'Shares', value: Math.round(r.shares).toLocaleString() },
                    { label: 'Mkt Val', value: `$${(r.currentPrice * r.shares).toLocaleString('en-CA', { maximumFractionDigits: 0 })}` },
                    r.targetPrice
                      ? { label: 'Target', value: `$${fmt2(r.targetPrice)}` }
                      : { label: 'Beta', value: r.metrics?.beta != null ? r.metrics.beta.toFixed(2) : '—' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-zinc-800/60 rounded-lg p-2">
                      <div className="text-xs text-zinc-500">{label}</div>
                      <div className={`text-xs font-medium mt-0.5 ${color ?? 'text-zinc-200'}`}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Pros / Cons */}
                <div className="mt-4 grid sm:grid-cols-2 gap-3">
                  {/* Pros */}
                  <div>
                    <div className="text-xs font-medium text-emerald-500 flex items-center gap-1.5 mb-2">
                      <TrendingUp size={12} /> What's Going Well
                    </div>
                    {r.pros.length === 0 ? (
                      <p className="text-xs text-zinc-600 italic">No notable positives at this time</p>
                    ) : (
                      <ul className="space-y-1">
                        {r.pros.map((p, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                            <CheckCircle size={11} className="text-emerald-500 mt-0.5 shrink-0" />
                            {p}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Cons */}
                  <div>
                    <div className="text-xs font-medium text-red-500 flex items-center gap-1.5 mb-2">
                      <TrendingDown size={12} /> Areas of Concern
                    </div>
                    {r.cons.length === 0 ? (
                      <p className="text-xs text-zinc-600 italic">No notable concerns at this time</p>
                    ) : (
                      <ul className="space-y-1">
                        {r.cons.map((c, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                            <XCircle size={11} className="text-red-500 mt-0.5 shrink-0" />
                            {c}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Suggested action */}
                <div className="mt-4 bg-zinc-800/40 border border-zinc-700/40 rounded-lg p-3 flex items-start gap-2">
                  <Zap size={12} className="text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <span className="text-xs font-medium text-blue-400">Suggested Action: </span>
                    <span className="text-xs text-zinc-300">{r.action}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="text-xs text-zinc-600 text-center pb-2">
            Generated {result.generatedAt} · Based on live Finnhub data · For informational purposes only — not financial advice
          </div>
        </>
      )}

      {/* Empty state */}
      {!result && !loading && !error && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center">
          <Star size={32} className="text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">Click <strong className="text-zinc-400">Run Full Review</strong> to analyze every position in your portfolio.</p>
          <p className="text-zinc-600 text-xs mt-1">Fetches live data for all holdings — takes ~10–20 seconds.</p>
        </div>
      )}
    </div>
  );
}
