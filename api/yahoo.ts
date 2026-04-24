import type { VercelRequest, VercelResponse } from '@vercel/node';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MODULES = 'financialData,defaultKeyStatistics,summaryDetail,calendarEvents,price';

// ─── Layer 1: try quoteSummary without crumb (works from server-side IPs) ─────
async function tryNoCrumb(ticker: string): Promise<any> {
  const r = await fetch(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${MODULES}&formatted=false`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } }
  );
  if (!r.ok) return null;
  const j: any = await r.json();
  return j?.quoteSummary?.result?.[0] ?? null;
}

// ─── Layer 2: cookie + crumb flow ─────────────────────────────────────────────
async function tryWithCrumb(ticker: string): Promise<any> {
  // grab session cookie
  const pageRes = await fetch(`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
  });
  const rawCookie = pageRes.headers.get('set-cookie') ?? '';
  const cookie = rawCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');

  // get crumb
  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.startsWith('<') || crumb.includes('{')) return null;

  const r = await fetch(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}&formatted=false`,
    { headers: { 'User-Agent': UA, Cookie: cookie } }
  );
  if (!r.ok) return null;
  const j: any = await r.json();
  return j?.quoteSummary?.result?.[0] ?? null;
}

// ─── Layer 3: v7 quote API — reliable, covers TSX/global tickers ──────────────
async function tryV7Quote(ticker: string): Promise<any> {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,regularMarketVolume,longName,shortName,exchangeName,fullExchangeName,currency,marketCap,fiftyTwoWeekHigh,fiftyTwoWeekLow,fiftyDayAverage,twoHundredDayAverage,averageDailyVolume3Month`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } }
  );
  if (!r.ok) return null;
  const j: any = await r.json();
  const q = j?.quoteResponse?.result?.[0];
  if (!q?.regularMarketPrice) return null;

  return {
    price: {
      regularMarketPrice:         q.regularMarketPrice,
      regularMarketChange:        q.regularMarketChange        ?? null,
      regularMarketChangePercent: (q.regularMarketChangePercent ?? 0) / 100, // v7 returns %, convert to decimal
      regularMarketOpen:          q.regularMarketOpen          ?? null,
      regularMarketDayHigh:       q.regularMarketDayHigh       ?? null,
      regularMarketDayLow:        q.regularMarketDayLow        ?? null,
      regularMarketPreviousClose: q.regularMarketPreviousClose ?? null,
      regularMarketVolume:        q.regularMarketVolume        ?? null,
      longName:                   q.longName ?? q.shortName    ?? ticker,
      shortName:                  q.shortName                  ?? ticker,
      exchangeName:               q.exchangeName               ?? null,
      fullExchangeName:           q.fullExchangeName           ?? null,
      currency:                   q.currency                   ?? null,
      marketCap:                  q.marketCap                  ?? null,
    },
    summaryDetail: {
      marketCap:            q.marketCap              ?? null,
      fiftyTwoWeekHigh:     q.fiftyTwoWeekHigh       ?? null,
      fiftyTwoWeekLow:      q.fiftyTwoWeekLow        ?? null,
      fiftyDayAverage:      q.fiftyDayAverage        ?? null,
      twoHundredDayAverage: q.twoHundredDayAverage   ?? null,
      averageVolume:        q.averageDailyVolume3Month ?? null,
      beta:                 null,
      volume:               q.regularMarketVolume    ?? null,
    },
    _partial: true,
  };
}

// ─── Layer 4: v8 chart API — last resort, always works ────────────────────────
async function tryChart(ticker: string): Promise<any> {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d&includePrePost=false`,
    { headers: { 'User-Agent': UA } }
  );
  if (!r.ok) return null;
  const j: any = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;

  const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
  const change    = prevClose ? meta.regularMarketPrice - prevClose : null;
  const changePct = prevClose ? (change! / prevClose) : null;

  return {
    price: {
      regularMarketPrice:         meta.regularMarketPrice,
      regularMarketChange:        change,
      regularMarketChangePercent: changePct, // decimal e.g. 0.015
      regularMarketPreviousClose: prevClose,
      regularMarketOpen:          meta.regularMarketOpen      ?? null,
      regularMarketDayHigh:       meta.regularMarketDayHigh   ?? null,
      regularMarketDayLow:        meta.regularMarketDayLow    ?? null,
      regularMarketVolume:        meta.regularMarketVolume    ?? null,
      longName:                   meta.longName ?? meta.shortName ?? ticker,
      shortName:                  meta.shortName ?? ticker,
      exchangeName:               meta.exchangeName,
      fullExchangeName:           meta.fullExchangeName,
      currency:                   meta.currency,
      marketCap:                  null,
    },
    summaryDetail: {
      marketCap:              null,
      fiftyTwoWeekHigh:       meta.fiftyTwoWeekHigh    ?? null,
      fiftyTwoWeekLow:        meta.fiftyTwoWeekLow     ?? null,
      fiftyDayAverage:        meta.fiftyDayAverage     ?? null,
      twoHundredDayAverage:   meta.twoHundredDayAverage ?? null,
      averageVolume:          meta.averageVolume        ?? null,
      beta:                   null,
      volume:                 meta.regularMarketVolume  ?? null,
    },
    _partial: true,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker || typeof ticker !== 'string') {
    return res.status(400).json({ error: 'ticker required' });
  }
  const t = ticker.toUpperCase();

  // Try each layer in order — return first one that works
  try {
    const result =
      (await tryNoCrumb(t)) ??
      (await tryWithCrumb(t)) ??
      (await tryV7Quote(t)) ??
      (await tryChart(t));
    if (result) return res.status(200).json(result);
  } catch { /* fall through */ }

  return res.status(200).json({ _error: 'All Yahoo Finance layers failed for ' + t });
}
