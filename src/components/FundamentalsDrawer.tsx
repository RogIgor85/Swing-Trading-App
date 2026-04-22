import { useState, useEffect } from 'react';
import { X, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { fetchYahoo } from '../lib/yahoo';
import { fmtCurrency } from '../lib/utils';
import type { YahooData } from '../lib/yahoo';

const TSX_SUFFIXES = ['.TO', '.V', '.TSX', '.CN', '.NEO', '.VN'];

export function toYahooTicker(ticker: string, currency: string): string {
  if (TSX_SUFFIXES.some((s) => ticker.toUpperCase().endsWith(s.toUpperCase()))) return ticker;
  if (currency === 'CAD') return `${ticker}.TO`;
  return ticker;
}

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

interface Props {
  ticker: string;
  currency: string;
  onClose: () => void;
}

export default function FundamentalsDrawer({ ticker, currency, onClose }: Props) {
  const [data, setData] = useState<YahooData | null>(null);
  const [loading, setLoading] = useState(true);

  const yahooTicker = toYahooTicker(ticker, currency);

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetchYahoo(yahooTicker).then((d) => { setData(d); setLoading(false); });
  }, [yahooTicker]);

  const p   = data?.price;
  const sd  = data?.summaryDetail;
  const fd  = data?.financialData;
  const ks  = data?.defaultKeyStatistics;
  const cal = data?.calendarEvents?.earnings;

  const price      = p?.regularMarketPrice ?? null;
  const prevClose  = p?.regularMarketPreviousClose ?? sd?.regularMarketPreviousClose ?? null;
  const dayChange  = price != null && prevClose != null ? price - prevClose : null;
  const dayChangePct = price != null && prevClose != null && prevClose !== 0
    ? (dayChange! / prevClose) * 100 : null;
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
    ? ((price - w52Low) / (w52High - w52Low)) * 100 : null;

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
              <span className="text-xs text-zinc-500">Loading {yahooTicker}…</span>
            </div>
          ) : data?._error || (!price && !data?.summaryDetail) ? (
            <div className="flex flex-col items-center justify-center h-40 gap-2 text-center">
              <AlertTriangle size={20} className="text-amber-500" />
              <p className="text-xs text-zinc-500">No data available for {yahooTicker}</p>
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
                <Row label="50-Day MA"  value={ma50  != null ? fmtCurrency(ma50)  : '—'} colored={price != null && ma50  != null ? (price > ma50  ? 'text-emerald-400' : 'text-red-400') : undefined} />
                <Row label="200-Day MA" value={ma200 != null ? fmtCurrency(ma200) : '—'} colored={price != null && ma200 != null ? (price > ma200 ? 'text-emerald-400' : 'text-red-400') : undefined} />
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
                <Row label="Revenue Growth"  value={fmtPct2(fd?.revenueGrowth)}  colored={fd?.revenueGrowth  != null ? (fd.revenueGrowth  >= 0 ? 'text-emerald-400' : 'text-red-400') : undefined} />
                <Row label="Earnings Growth" value={fmtPct2(fd?.earningsGrowth)} colored={fd?.earningsGrowth != null ? (fd.earningsGrowth >= 0 ? 'text-emerald-400' : 'text-red-400') : undefined} />
                <Row label="Profit Margin"   value={fmtPct2(fd?.profitMargins ?? ks?.profitMargins)} />
                <Row label="ROE"             value={fmtPct2(fd?.returnOnEquity)} />
                <Row label="Free Cash Flow"  value={fmtBig(fd?.freeCashflow)} />
                <Row label="Current Ratio"   value={fmtNum(fd?.currentRatio, 2)} />
                <Row label="Debt / Equity"   value={fd?.debtToEquity != null ? `${fmtNum(fd.debtToEquity / 100, 2)}x` : '—'}
                  colored={fd?.debtToEquity != null ? (fd.debtToEquity < 100 ? 'text-emerald-400' : fd.debtToEquity < 200 ? 'text-amber-400' : 'text-red-400') : undefined} />
              </Section>

              <Section title="Analyst Coverage">
                <Row label="Recommendation" value={rec.label} colored={rec.color} />
                <Row label="Analysts"       value={fd?.numberOfAnalystOpinions != null ? `${fd.numberOfAnalystOpinions}` : '—'} />
                <Row label="Target (mean)"  value={fd?.targetMeanPrice != null ? fmtCurrency(fd.targetMeanPrice) : '—'} />
                <Row label="Target (high)"  value={fd?.targetHighPrice != null ? fmtCurrency(fd.targetHighPrice) : '—'} />
                <Row label="Target (low)"   value={fd?.targetLowPrice  != null ? fmtCurrency(fd.targetLowPrice)  : '—'} />
                {price != null && fd?.targetMeanPrice != null && (
                  <Row
                    label="Upside to target"
                    value={`${((fd.targetMeanPrice - price) / price * 100).toFixed(1)}%`}
                    colored={(fd.targetMeanPrice >= price) ? 'text-emerald-400' : 'text-red-400'}
                  />
                )}
              </Section>

              <Section title="Risk & Flow">
                <Row label="Short % of Float" value={ks?.shortPercentOfFloat != null ? fmtPct2(ks.shortPercentOfFloat) : '—'}
                  colored={ks?.shortPercentOfFloat != null ? (ks.shortPercentOfFloat > 0.1 ? 'text-red-400' : 'text-zinc-200') : undefined} />
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

        <div className="p-3 border-t border-zinc-800 text-xs text-zinc-700 text-center">
          Data via Yahoo Finance {data?._partial ? '· partial data' : ''}
        </div>
      </div>
    </>
  );
}
