import { useState } from 'react';
import {
  RefreshCw, TrendingUp, TrendingDown, AlertTriangle,
  CheckCircle, XCircle, Star, Shield, Zap, BarChart3, Minus,
} from 'lucide-react';
import { storage } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import { getUsdCad } from '../../lib/fx';
import type { Holding, FinnhubQuote, FinnhubMetrics, FinnhubProfile } from '../../types';

const MANUAL_PRICES_KEY = 'swing_manual_prices';
const LIVE_PRICES_KEY   = 'swing_live_prices';
const EARNINGS_CACHE_KEY = 'swing_earnings_dates';

type Rating = 'STRONG HOLD' | 'HOLD' | 'TRIM' | 'WATCH' | 'EXIT';

function baseTickerKey(t: string) {
  return t.replace(/\.(TO|V|TSX)$/i, '').toUpperCase();
}

// Detect if two company names refer to the same company (share significant words)
function namesMatch(a: string, b: string): boolean {
  const clean = (s: string) =>
    s.toLowerCase().replace(/\b(inc|corp|corporation|ltd|co|plc|lp|llc|the|and|of|company|limited)\b\.?/g, '').trim();
  const ca = clean(a);
  const cb = clean(b);
  const words = ca.split(/\s+/).filter(w => w.length > 3);
  return words.length === 0 ? ca === cb : words.some(w => cb.includes(w));
}

// Raw fetched data for one holding
interface RawRow {
  h: Holding;
  companyName: string;
  currentPrice: number;      // in the holding's own currency
  usdRefPrice: number | null; // Finnhub USD price — used ONLY for technical checks
  metrics: FinnhubMetrics['metric'] | null;
  earningsDate: string | null; // next earnings date (YYYY-MM-DD), if within 90 days
  cadValue: number;
  costCAD: number;
}

// Shared company-level analysis (same for every account holding this stock)
interface CompanyAnalysis {
  rating: Rating;
  ratingScore: number;
  pros: string[];
  cons: string[];
  action: string;
  flags: string[];
}

interface StockCard {
  ticker: string;
  companyName: string;
  sector: string;
  account: string;
  currency: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  targetPrice: number | null;
  pnlPct: number;
  mktVal: number;
  allocationPct: number;
  beta: number | null;
  analysis: CompanyAnalysis;
  siblingCount: number;      // how many accounts hold this company
}

interface ReviewResult {
  cards: StockCard[];
  portfolioScore: number;
  totalPnLCAD: number;
  totalCostCAD: number;
  warnings: string[];
  generatedAt: string;
  fxRate: number;
  annualDividendsCAD: number;
  benchmarks: { spyYtd: number | null; tsxYtd: number | null };
}

// ─── company-level scoring (one analysis per company, shared across accounts) ─

function analyzeCompany(members: RawRow[], groupAllocationPct: number): CompanyAnalysis {
  const pros: string[] = [];
  const cons: string[] = [];
  const flags: string[] = [];
  let score = 5;

  const totalCadValue = members.reduce((s, m) => s + m.cadValue, 0);
  const totalCostCAD  = members.reduce((s, m) => s + m.costCAD, 0);
  const totalPnLPct   = totalCostCAD > 0 ? ((totalCadValue - totalCostCAD) / totalCostCAD) * 100 : 0;

  // Metrics: prefer a member that has them (they're all the same company)
  const m = members.find(x => x.metrics != null)?.metrics ?? null;
  // USD reference price for technical checks — same currency as Finnhub metrics
  const usdPrice = members.find(x => x.usdRefPrice != null)?.usdRefPrice ?? null;

  // ── Combined P&L across all accounts ─────────────────────────────────────
  if (totalPnLPct >= 25)       { pros.push(`Up ${totalPnLPct.toFixed(1)}% overall — substantial gain`); score += 2; }
  else if (totalPnLPct >= 10)  { pros.push(`Up ${totalPnLPct.toFixed(1)}% overall`); score += 1.5; }
  else if (totalPnLPct >= 3)   { pros.push(`Up ${totalPnLPct.toFixed(1)}% overall`); score += 0.5; }
  else if (totalPnLPct >= 0)   { pros.push(`Slightly above cost basis (+${totalPnLPct.toFixed(1)}%)`); }
  else if (totalPnLPct >= -10) { cons.push(`Down ${Math.abs(totalPnLPct).toFixed(1)}% overall`); score -= 1; }
  else if (totalPnLPct >= -20) { cons.push(`Down ${Math.abs(totalPnLPct).toFixed(1)}% overall — consider stop loss`); score -= 1.5; flags.push('Loss >10%'); }
  else                         { cons.push(`Down ${Math.abs(totalPnLPct).toFixed(1)}% overall — significant drawdown`); score -= 2.5; flags.push('Loss >20% — review thesis'); }

  // ── Sell targets (per account, each in its own currency) ─────────────────
  for (const mem of members) {
    const tp = mem.h.target_price;
    if (!tp || tp <= 0) continue;
    const price = mem.currentPrice;
    const pctToTarget    = ((tp - price) / price) * 100;
    const pctAboveTarget = ((price - tp) / tp) * 100;
    const label = members.length > 1 ? `${mem.h.ticker}: ` : '';
    if (price >= tp) {
      if (pctAboveTarget <= 100) {  // ignore ancient/stale targets
        flags.push(`${mem.h.ticker} at sell target $${tp}`);
        cons.push(`${label}price reached sell target ($${tp}) — consider taking profits`);
        score -= 0.5;
      }
    } else if (pctToTarget < 5) {
      flags.push(`${mem.h.ticker} near sell target $${tp}`);
      pros.push(`${label}within ${pctToTarget.toFixed(1)}% of sell target ($${tp})`);
    } else {
      pros.push(`${label}${pctToTarget.toFixed(1)}% upside to sell target ($${tp})`);
      score += 0.3;
    }
  }

  // ── 52-week range — USD price vs USD metrics only, never mixed ───────────
  if (m?.['52WeekHigh'] && m?.['52WeekLow'] && usdPrice != null) {
    const hi = m['52WeekHigh'], lo = m['52WeekLow'];
    // Sanity check: price must plausibly belong to this range
    if (hi > lo && usdPrice >= lo * 0.5 && usdPrice <= hi * 1.5) {
      const pos = Math.min(100, Math.max(0, ((usdPrice - lo) / (hi - lo)) * 100));
      if (pos >= 80)      { pros.push(`Near 52-week high (${pos.toFixed(0)}% of range) — strong momentum`); score += 1; }
      else if (pos >= 55) { pros.push(`Upper half of 52-week range (${pos.toFixed(0)}%)`); score += 0.5; }
      else if (pos <= 20) { cons.push(`Near 52-week low (${pos.toFixed(0)}% of range) — weak trend`); score -= 1.5; flags.push('Near 52W low'); }
      else if (pos <= 40) { cons.push(`Lower portion of 52-week range (${pos.toFixed(0)}%)`); score -= 0.5; }
    }
  }

  // ── Beta ──────────────────────────────────────────────────────────────────
  if (m?.beta != null) {
    const b = m.beta;
    if (b < 0.8)      { pros.push(`Low volatility (Beta ${b.toFixed(2)}) — stable, defensive`); score += 0.5; }
    else if (b > 2.2) { cons.push(`Very high volatility (Beta ${b.toFixed(2)}) — large swing risk`); score -= 1; flags.push(`High Beta: ${b.toFixed(2)}`); }
    else if (b > 1.6) { cons.push(`Above-average volatility (Beta ${b.toFixed(2)})`); score -= 0.5; }
  }

  // ── EPS growth ────────────────────────────────────────────────────────────
  if (m?.epsGrowth3Y != null) {
    const g = m.epsGrowth3Y;
    if (g > 25)      { pros.push(`Strong EPS growth: ${g.toFixed(1)}% (3-year CAGR)`); score += 1; }
    else if (g > 10) { pros.push(`Solid EPS growth: ${g.toFixed(1)}% (3-year CAGR)`); score += 0.5; }
    else if (g < -5) { cons.push(`Declining earnings: ${g.toFixed(1)}% EPS growth (3-year)`); score -= 1; }
    else if (g < 0)  { cons.push(`Flat/negative EPS growth: ${g.toFixed(1)}% (3-year)`); score -= 0.5; }
  }

  // ── Revenue growth ────────────────────────────────────────────────────────
  if (m?.revenueGrowth3Y != null) {
    const g = m.revenueGrowth3Y;
    if (g > 15)      { pros.push(`Strong revenue growth: ${g.toFixed(1)}% (3-year CAGR)`); score += 0.5; }
    else if (g < -3) { cons.push(`Declining revenue: ${g.toFixed(1)}% (3-year)`); score -= 0.5; }
  }

  // ── Gross margin ──────────────────────────────────────────────────────────
  if (m?.grossMarginTTM != null) {
    const gm = m.grossMarginTTM;
    if (gm > 65)      { pros.push(`Exceptional gross margin (${gm.toFixed(1)}%) — strong pricing power`); score += 1; }
    else if (gm > 40) { pros.push(`Healthy gross margin (${gm.toFixed(1)}%)`); score += 0.5; }
    else if (gm < 15) { cons.push(`Thin gross margin (${gm.toFixed(1)}%) — commoditized`); score -= 0.5; }
  }

  // ── Debt / equity ─────────────────────────────────────────────────────────
  if (m?.debtEquityAnnual != null) {
    const de = m.debtEquityAnnual;
    if (de < 0.3)      { pros.push(`Low leverage (D/E: ${de.toFixed(2)}) — strong balance sheet`); score += 0.5; }
    else if (de > 2.0) { cons.push(`High leverage (D/E: ${de.toFixed(2)}) — financial risk`); score -= 1; flags.push(`High D/E: ${de.toFixed(2)}`); }
    else if (de > 1.2) { cons.push(`Elevated debt (D/E: ${de.toFixed(2)})`); score -= 0.5; }
  }

  // ── ROE ───────────────────────────────────────────────────────────────────
  if (m?.roeTTM != null) {
    const roe = m.roeTTM;
    if (roe > 25)     { pros.push(`High ROE (${roe.toFixed(1)}%) — excellent capital efficiency`); score += 0.5; }
    else if (roe < 0) { cons.push(`Negative ROE (${roe.toFixed(1)}%)`); score -= 1; }
    else if (roe < 5) { cons.push(`Low ROE (${roe.toFixed(1)}%)`); score -= 0.3; }
  }

  // ── P/E ───────────────────────────────────────────────────────────────────
  if (m?.peBasicExclExtraTTM != null) {
    const pe = m.peBasicExclExtraTTM;
    if (pe > 0 && pe < 12) { pros.push(`Attractive valuation (P/E: ${pe.toFixed(1)}x)`); score += 0.5; }
    else if (pe > 70)      { cons.push(`Expensive valuation (P/E: ${pe.toFixed(1)}x) — priced for perfection`); score -= 0.5; }
    else if (pe < 0)       { cons.push(`Negative earnings — unprofitable on trailing basis`); score -= 0.5; }
  }

  // ── Concentration (combined weight across accounts) ───────────────────────
  if (groupAllocationPct > 30)      { flags.push(`${groupAllocationPct.toFixed(1)}% of portfolio combined`); cons.push(`Overweight (${groupAllocationPct.toFixed(1)}% of portfolio across accounts) — concentration risk`); score -= 0.5; }
  else if (groupAllocationPct > 20) { flags.push(`${groupAllocationPct.toFixed(1)}% of portfolio combined`); }

  // ── Upcoming earnings ─────────────────────────────────────────────────────
  const earningsDate = members.find(x => x.earningsDate)?.earningsDate ?? null;
  if (earningsDate) {
    const days = Math.ceil((new Date(earningsDate + 'T00:00:00').getTime() - Date.now()) / 86400000);
    if (days >= 0 && days <= 7) {
      flags.push(`⚠ Earnings in ${days === 0 ? 'today' : `${days}d`}`);
      cons.push(`Earnings report on ${earningsDate} — biggest single-day risk for a swing position. Consider position sizing before the print.`);
    } else if (days > 7 && days <= 21) {
      flags.push(`Earnings ${earningsDate}`);
    }
  }

  // ── Dividend yield ────────────────────────────────────────────────────────
  if (m?.dividendYieldIndicatedAnnual != null && m.dividendYieldIndicatedAnnual > 0) {
    const dy = m.dividendYieldIndicatedAnnual;
    if (dy >= 4)      { pros.push(`Strong dividend yield (${dy.toFixed(2)}%) — paid to wait`); score += 0.3; }
    else if (dy >= 2) { pros.push(`Pays a ${dy.toFixed(2)}% dividend`); }
  }

  score = Math.round(Math.min(10, Math.max(1, score)) * 10) / 10;

  let rating: Rating;
  let action: string;
  if (score >= 7.5)      { rating = 'STRONG HOLD'; action = 'High-conviction position. Consider adding on pullbacks. Maintain or increase allocation.'; }
  else if (score >= 6)   { rating = 'HOLD';        action = 'Continue holding. Set a trailing stop 8–10% below current price to protect gains.'; }
  else if (score >= 4.5) { rating = 'TRIM';        action = 'Consider reducing position by 25–50% to lock in gains or limit further downside.'; }
  else if (score >= 3)   { rating = 'WATCH';       action = 'Monitor closely. Revisit original thesis. Be prepared to exit if price breaks below key support.'; }
  else                   { rating = 'EXIT';         action = 'Thesis may be broken. Consider exiting to redeploy capital into higher-conviction opportunities.'; }

  return { rating, ratingScore: score, pros, cons, action, flags };
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

// ─── component ───────────────────────────────────────────────────────────────

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
        setError('No holdings found. Add positions in the Portfolio tab first.');
        setLoading(false);
        return;
      }

      const manualPrices: Record<string, number>              = JSON.parse(localStorage.getItem(MANUAL_PRICES_KEY) ?? '{}');
      const livePricesCache: Record<string, { price: number }> = JSON.parse(localStorage.getItem(LIVE_PRICES_KEY) ?? '{}');

      setProgress({ current: 0, total: holdings.length });

      // Benchmarks fetched in parallel with the holdings; FX needed up front
      const spyPromise = fetchYahoo('SPY').catch(() => null);
      const tsxPromise = fetchYahoo('XIC.TO').catch(() => null);
      const fxRate     = await getUsdCad();

      const rawResults = await Promise.allSettled(
        holdings.map(async (h): Promise<RawRow> => {
          const isCAD    = /\.TO$/i.test(h.ticker);
          const finnhubT = baseTickerKey(h.ticker);

          const [qRes, mRes, pRes, yRes, eRes] = await Promise.allSettled([
            finnhub.quote(finnhubT),
            finnhub.metrics(finnhubT),
            finnhub.profile(finnhubT),
            isCAD ? fetchYahoo(h.ticker) : Promise.resolve(null),
            finnhub.earningsCalendar(finnhubT),
          ]);

          const quote: FinnhubQuote | null   = qRes.status === 'fulfilled' ? qRes.value : null;
          let metrics                        = mRes.status === 'fulfilled' ? mRes.value?.metric ?? null : null;
          const profile: FinnhubProfile | null = pRes.status === 'fulfilled' ? pRes.value : null;
          const yahoo = yRes.status === 'fulfilled' ? yRes.value as Awaited<ReturnType<typeof fetchYahoo>> | null : null;
          const earningsDate = eRes.status === 'fulfilled'
            ? (eRes.value?.earningsCalendar?.map(e => e.date).sort()[0] ?? null)
            : null;

          const yahooName = yahoo?.price?.longName ?? yahoo?.price?.shortName ?? null;

          // Ticker collision guard: if Finnhub resolved to a different company
          // than Yahoo (e.g. T → AT&T but T.TO → Telus), discard Finnhub data
          let usdRefPrice = quote?.c && quote.c > 0 ? quote.c : null;
          if (isCAD && yahooName && profile?.name && !namesMatch(profile.name, yahooName)) {
            metrics = null;
            usdRefPrice = null;
          }

          const companyName = yahooName ?? profile?.name ?? h.ticker;

          // Display price in the holding's own currency
          const yahooPrice = yahoo?.price?.regularMarketPrice ?? null;
          const livePrice  = isCAD
            ? (yahooPrice ?? (usdRefPrice != null ? usdRefPrice * fxRate : null))
            : usdRefPrice;

          const currentPrice = manualPrices[h.ticker] ?? livePrice ?? livePricesCache[h.ticker]?.price ?? h.avg_cost;

          const mktVal   = h.shares * currentPrice;
          const cadValue = h.currency === 'USD' ? mktVal * fxRate : mktVal;
          const costCAD  = h.shares * h.avg_cost * (h.currency === 'USD' ? fxRate : 1);

          setProgress(p => ({ ...p, current: p.current + 1 }));
          return { h, companyName, currentPrice, usdRefPrice, metrics, earningsDate, cadValue, costCAD };
        })
      );

      const rows: RawRow[] = rawResults
        .filter((r): r is PromiseFulfilledResult<RawRow> => r.status === 'fulfilled')
        .map(r => r.value);

      const totalCAD     = rows.reduce((s, r) => s + r.cadValue, 0);
      const totalCostCAD = rows.reduce((s, r) => s + r.costCAD, 0);
      const totalPnLCAD  = totalCAD - totalCostCAD;

      // Group by company for the shared analysis (rating/pros/cons identical
      // across accounts), then render one card per holding
      const groupMap = new Map<string, RawRow[]>();
      for (const row of rows) {
        const key = baseTickerKey(row.h.ticker);
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key)!.push(row);
      }

      const cards: StockCard[] = [];
      for (const members of groupMap.values()) {
        const groupCad          = members.reduce((s, m) => s + m.cadValue, 0);
        const groupAllocationPct = totalCAD > 0 ? (groupCad / totalCAD) * 100 : 0;
        const analysis          = analyzeCompany(members, groupAllocationPct);
        const sharedName        = members.find(m => m.companyName !== m.h.ticker)?.companyName ?? members[0].companyName;

        for (const m of members) {
          cards.push({
            ticker: m.h.ticker,
            companyName: sharedName,
            sector: m.h.sector,
            account: m.h.account,
            currency: m.h.currency,
            shares: m.h.shares,
            avgCost: m.h.avg_cost,
            currentPrice: m.currentPrice,
            targetPrice: m.h.target_price,
            pnlPct: m.h.avg_cost > 0 ? ((m.currentPrice - m.h.avg_cost) / m.h.avg_cost) * 100 : 0,
            mktVal: m.currentPrice * m.h.shares,
            allocationPct: totalCAD > 0 ? (m.cadValue / totalCAD) * 100 : 0,
            beta: m.metrics?.beta ?? members.find(x => x.metrics?.beta != null)?.metrics?.beta ?? null,
            analysis,
            siblingCount: members.length,
          });
        }
      }

      cards.sort((a, b) =>
        b.analysis.ratingScore - a.analysis.ratingScore
        || a.ticker.localeCompare(b.ticker)
      );

      // Portfolio score: average per company (not per lot, to avoid double-counting)
      const companyScores = [...groupMap.values()].map(members =>
        cards.find(c => baseTickerKey(c.ticker) === baseTickerKey(members[0].h.ticker))!.analysis.ratingScore
      );
      const portfolioScore = companyScores.reduce((s, x) => s + x, 0) / companyScores.length;

      // Warnings (deduped by company)
      const companies = [...groupMap.values()].map(members => {
        const card = cards.find(c => baseTickerKey(c.ticker) === baseTickerKey(members[0].h.ticker))!;
        const groupCad = members.reduce((s, m) => s + m.cadValue, 0);
        return { base: baseTickerKey(members[0].h.ticker), rating: card.analysis.rating, allocationPct: totalCAD > 0 ? (groupCad / totalCAD) * 100 : 0 };
      });
      const warnings: string[] = [];
      const exitCnt  = companies.filter(c => c.rating === 'EXIT').length;
      const watchCnt = companies.filter(c => c.rating === 'WATCH').length;
      const trimCnt  = companies.filter(c => c.rating === 'TRIM').length;
      const heaviest = companies.reduce((a, b) => a.allocationPct > b.allocationPct ? a : b);
      if (exitCnt  > 0) warnings.push(`${exitCnt} stock${exitCnt > 1 ? 's' : ''} flagged for EXIT`);
      if (watchCnt > 0) warnings.push(`${watchCnt} stock${watchCnt > 1 ? 's' : ''} on WATCH`);
      if (trimCnt  > 0) warnings.push(`${trimCnt} stock${trimCnt > 1 ? 's' : ''} suggest TRIM`);
      if (heaviest.allocationPct > 30) warnings.push(`${heaviest.base} is ${heaviest.allocationPct.toFixed(1)}% of portfolio combined`);

      // Estimated annual dividend income (CAD): Σ market value × indicated yield
      const annualDividendsCAD = rows.reduce((s, r) => {
        const dy = r.metrics?.dividendYieldIndicatedAnnual;
        return dy && dy > 0 ? s + r.cadValue * (dy / 100) : s;
      }, 0);

      // Earnings-within-a-week warning at the portfolio level + cache for Portfolio tab badges
      const earningsCache: Record<string, string> = {};
      for (const r of rows) {
        if (r.earningsDate) earningsCache[r.h.ticker] = r.earningsDate;
      }
      localStorage.setItem(EARNINGS_CACHE_KEY, JSON.stringify(earningsCache));
      const soonEarnings = [...groupMap.values()]
        .map(members => ({ base: baseTickerKey(members[0].h.ticker), date: members.find(x => x.earningsDate)?.earningsDate ?? null }))
        .filter(x => x.date != null && (new Date(x.date + 'T00:00:00').getTime() - Date.now()) / 86400000 <= 7)
        .map(x => x.base);
      if (soonEarnings.length > 0) warnings.push(`Earnings within 7 days: ${soonEarnings.join(', ')}`);

      // Benchmark YTD returns
      const [spyData, tsxData] = await Promise.all([spyPromise, tsxPromise]);
      const benchmarks = {
        spyYtd: spyData?.performance?.ytdReturn ?? null,
        tsxYtd: tsxData?.performance?.ytdReturn ?? null,
      };

      setResult({
        cards, portfolioScore, totalPnLCAD, totalCostCAD, warnings,
        generatedAt: new Date().toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }),
        fxRate, annualDividendsCAD, benchmarks,
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
              One card per holding — same company always gets the same rating, no matter the account
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
          {/* Summary */}
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
                  const count = new Set(
                    result.cards.filter(c => c.analysis.rating === r).map(c => baseTickerKey(c.ticker))
                  ).size;
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

          {/* Benchmarks + dividends row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2">vs Benchmarks (YTD)</div>
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-xs text-zinc-500">Your P&amp;L on cost</div>
                  <div className={`text-lg font-bold ${result.totalPnLCAD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {result.totalCostCAD > 0 ? `${result.totalPnLCAD >= 0 ? '+' : ''}${fmt2((result.totalPnLCAD / result.totalCostCAD) * 100, 1)}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500">S&amp;P 500 (SPY)</div>
                  <div className={`text-lg font-bold ${(result.benchmarks.spyYtd ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {result.benchmarks.spyYtd != null ? `${result.benchmarks.spyYtd >= 0 ? '+' : ''}${fmt2(result.benchmarks.spyYtd * 100, 1)}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500">TSX (XIC)</div>
                  <div className={`text-lg font-bold ${(result.benchmarks.tsxYtd ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {result.benchmarks.tsxYtd != null ? `${result.benchmarks.tsxYtd >= 0 ? '+' : ''}${fmt2(result.benchmarks.tsxYtd * 100, 1)}%` : '—'}
                  </div>
                </div>
              </div>
              <div className="text-xs text-zinc-600 mt-2">
                P&amp;L on cost is lifetime, benchmarks are calendar-year — directional comparison only
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2">Est. Annual Dividend Income</div>
              <div className="text-lg font-bold text-emerald-400">
                {result.annualDividendsCAD > 0 ? `${fmtMoney(result.annualDividendsCAD)} CAD / yr` : '—'}
              </div>
              <div className="text-xs text-zinc-600 mt-2">
                {result.annualDividendsCAD > 0
                  ? `≈ ${fmtMoney(result.annualDividendsCAD / 12)} per month at current yields · USD/CAD ${result.fxRate.toFixed(4)}`
                  : 'No dividend-paying holdings detected'}
              </div>
            </div>
          </div>

          {/* Per-holding cards */}
          <div className="space-y-4">
            {result.cards.map(c => (
              <div
                key={`${c.ticker}-${c.account}`}
                className={`bg-zinc-900 border border-zinc-800 border-l-4 ${ratingBorder(c.analysis.rating)} rounded-xl p-5`}
              >
                {/* Header */}
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold text-zinc-100">{c.ticker}</span>
                      {c.companyName !== c.ticker && (
                        <span className="text-sm text-zinc-500">{c.companyName}</span>
                      )}
                      {c.siblingCount > 1 && (
                        <span className="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded">
                          held in {c.siblingCount} accounts
                        </span>
                      )}
                      {c.analysis.flags.map((f, i) => (
                        <span key={i} className="text-xs bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <AlertTriangle size={10} className="text-amber-500" />
                          {f}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500 flex-wrap">
                      <span>{c.sector || '—'}</span>
                      <span>·</span>
                      <span>{c.account}</span>
                      <span>·</span>
                      <span>{c.currency}</span>
                      <span>·</span>
                      <span>{c.allocationPct.toFixed(1)}% of portfolio</span>
                    </div>
                  </div>
                  <div className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 ${ratingColor(c.analysis.rating)}`}>
                    {ratingIcon(c.analysis.rating)}
                    <span className="text-xs font-semibold">{c.analysis.rating}</span>
                  </div>
                </div>

                <div className="mt-3"><ScoreBar score={c.analysis.ratingScore} /></div>

                {/* Key metrics — this holding only */}
                <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {[
                    { label: `Price (${c.currency})`,    value: `$${fmt2(c.currentPrice)}` },
                    { label: 'Avg Cost', value: `$${fmt2(c.avgCost)}` },
                    { label: 'P&L',      value: `${c.pnlPct >= 0 ? '+' : ''}${fmt2(c.pnlPct, 1)}%`, color: c.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Shares',   value: Math.round(c.shares).toLocaleString() },
                    { label: 'Mkt Val',  value: `$${Math.round(c.mktVal).toLocaleString()}` },
                    { label: c.targetPrice ? 'Target' : 'Beta',
                      value: c.targetPrice ? `$${fmt2(c.targetPrice)}` : (c.beta != null ? c.beta.toFixed(2) : '—') },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-zinc-800/60 rounded-lg p-2">
                      <div className="text-xs text-zinc-500">{label}</div>
                      <div className={`text-xs font-medium mt-0.5 ${color ?? 'text-zinc-200'}`}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Pros / Cons — company-level, shared across accounts */}
                <div className="mt-4 grid sm:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs font-medium text-emerald-500 flex items-center gap-1.5 mb-2">
                      <TrendingUp size={12} /> What's Going Well
                    </div>
                    {c.analysis.pros.length === 0
                      ? <p className="text-xs text-zinc-600 italic">No notable positives</p>
                      : <ul className="space-y-1">{c.analysis.pros.map((p, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                            <CheckCircle size={11} className="text-emerald-500 mt-0.5 shrink-0" />{p}
                          </li>
                        ))}</ul>
                    }
                  </div>
                  <div>
                    <div className="text-xs font-medium text-red-500 flex items-center gap-1.5 mb-2">
                      <TrendingDown size={12} /> Areas of Concern
                    </div>
                    {c.analysis.cons.length === 0
                      ? <p className="text-xs text-zinc-600 italic">No notable concerns</p>
                      : <ul className="space-y-1">{c.analysis.cons.map((x, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-300">
                            <XCircle size={11} className="text-red-500 mt-0.5 shrink-0" />{x}
                          </li>
                        ))}</ul>
                    }
                  </div>
                </div>

                {/* Action */}
                <div className="mt-4 bg-zinc-800/40 border border-zinc-700/40 rounded-lg p-3 flex items-start gap-2">
                  <Zap size={12} className="text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <span className="text-xs font-medium text-blue-400">Suggested Action: </span>
                    <span className="text-xs text-zinc-300">{c.analysis.action}</span>
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
          <p className="text-zinc-500 text-sm">Click <strong className="text-zinc-400">Run Full Review</strong> to analyze every position.</p>
          <p className="text-zinc-600 text-xs mt-1">Fetches live data for all holdings — takes ~15–20 seconds.</p>
        </div>
      )}
    </div>
  );
}
