import type { VercelRequest, VercelResponse } from '@vercel/node';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MODULES = 'financialData,defaultKeyStatistics,summaryDetail,calendarEvents,price';

const TSX_SUFFIXES = ['.TO', '.V', '.TSX', '.CN', '.NEO', '.VN'];
function isTSX(ticker: string) {
  return TSX_SUFFIXES.some((s) => ticker.toUpperCase().endsWith(s));
}

// Helper: simple moving average of last N values
function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

// ─── Layer A: v8 chart API — 1y range so we can compute 50D/200D MA ───────────
async function tryChart(ticker: string): Promise<any> {
  try {
    // 1y of daily data gives us enough closes to compute 50D and 200D MA
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y&includePrePost=false`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const j: any = await r.json();
    const result = j?.chart?.result?.[0];
    const meta   = result?.meta;
    if (!meta?.regularMarketPrice) return null;

    // Extract closing prices from chart data
    const closes: number[] = (result?.indicators?.quote?.[0]?.close ?? [])
      .filter((c: any) => c != null && typeof c === 'number');

    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
    const price     = meta.regularMarketPrice;
    const change    = prevClose != null ? price - prevClose : null;
    const changePct = prevClose != null && prevClose !== 0 ? (price - prevClose) / prevClose : null;

    // Compute MAs from actual closes; fall back to meta fields if not enough data
    const ma50  = sma(closes, 50)  ?? meta.fiftyDayAverage     ?? null;
    const ma200 = sma(closes, 200) ?? meta.twoHundredDayAverage ?? null;

    return {
      price: {
        regularMarketPrice:         price,
        regularMarketChange:        change,
        regularMarketChangePercent: changePct,
        regularMarketPreviousClose: prevClose,
        regularMarketOpen:          meta.regularMarketOpen    ?? null,
        regularMarketDayHigh:       meta.regularMarketDayHigh ?? null,
        regularMarketDayLow:        meta.regularMarketDayLow  ?? null,
        regularMarketVolume:        meta.regularMarketVolume  ?? null,
        longName:                   meta.longName ?? meta.shortName ?? ticker,
        shortName:                  meta.shortName ?? ticker,
        exchangeName:               meta.exchangeName         ?? null,
        fullExchangeName:           meta.fullExchangeName     ?? null,
        currency:                   meta.currency             ?? null,
        marketCap:                  null,
      },
      summaryDetail: {
        marketCap:              null,
        fiftyTwoWeekHigh:       meta.fiftyTwoWeekHigh    ?? null,
        fiftyTwoWeekLow:        meta.fiftyTwoWeekLow     ?? null,
        fiftyDayAverage:        ma50,
        twoHundredDayAverage:   ma200,
        averageVolume:          meta.averageVolume        ?? null,
        beta:                   null,
        volume:                 meta.regularMarketVolume  ?? null,
      },
      _partial: true,
    };
  } catch { return null; }
}

// ─── Layer B: v7 quote API — good for market cap + extra stats ─────────────────
async function tryV7Quote(ticker: string): Promise<any> {
  try {
    const fields = [
      'regularMarketPrice','regularMarketChange','regularMarketChangePercent',
      'regularMarketOpen','regularMarketDayHigh','regularMarketDayLow',
      'regularMarketPreviousClose','regularMarketVolume',
      'longName','shortName','exchangeName','fullExchangeName','currency','marketCap',
      'fiftyTwoWeekHigh','fiftyTwoWeekLow','fiftyDayAverage','twoHundredDayAverage',
      'averageDailyVolume3Month','trailingPE','forwardPE','beta',
      'shortPercentOfFloat','shortRatio',
    ].join(',');
    const r = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=${fields}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const j: any = await r.json();
    const q = j?.quoteResponse?.result?.[0];
    if (!q?.regularMarketPrice) return null;

    return {
      price: {
        regularMarketPrice:         q.regularMarketPrice,
        regularMarketChange:        q.regularMarketChange ?? null,
        regularMarketChangePercent: (q.regularMarketChangePercent ?? 0) / 100, // v7 gives %, normalise to decimal
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
        marketCap:            q.marketCap               ?? null,
        fiftyTwoWeekHigh:     q.fiftyTwoWeekHigh        ?? null,
        fiftyTwoWeekLow:      q.fiftyTwoWeekLow         ?? null,
        fiftyDayAverage:      q.fiftyDayAverage         ?? null,
        twoHundredDayAverage: q.twoHundredDayAverage    ?? null,
        averageVolume:        q.averageDailyVolume3Month ?? null,
        beta:                 q.beta                    ?? null,
        volume:               q.regularMarketVolume     ?? null,
        trailingPE:           q.trailingPE              ?? null,
        forwardPE:            q.forwardPE               ?? null,
      },
      defaultKeyStatistics: {
        shortPercentOfFloat:  q.shortPercentOfFloat ?? null,
        shortRatio:           q.shortRatio          ?? null,
      },
      _partial: true,
    };
  } catch { return null; }
}

// ─── Layer E: HTML scrape — extract short interest + earnings from page HTML ──
// Yahoo Finance embeds raw JSON data in the page HTML. Scraping the page is
// often possible even when API endpoints are blocked from Vercel IPs.
async function tryHTMLScrape(ticker: string): Promise<{ shortPercentOfFloat: number | null; earningsDateTs: number | null }> {
  const empty = { shortPercentOfFloat: null, earningsDateTs: null };
  try {
    const r = await fetch(
      `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' } }
    );
    if (!r.ok) return empty;
    const html = await r.text();

    // Short interest — Yahoo embeds as {"raw":0.0064,"fmt":"0.64%"} or bare number
    let shortPct: number | null = null;
    const m1 = html.match(/"shortPercentOfFloat"\s*:\s*\{\s*"raw"\s*:\s*([\d.eE+\-]+)/);
    const m2 = !m1 ? html.match(/"shortPercentOfFloat"\s*:\s*([\d.eE+\-]+)/) : null;
    const rawStr = (m1 ?? m2)?.[1];
    if (rawStr) {
      const v = parseFloat(rawStr);
      if (!isNaN(v) && v > 0) shortPct = v;
    }

    // Next earnings date — embedded as {"raw":1746302400,"fmt":"2025-05-03"}
    let earningsDateTs: number | null = null;
    const em = html.match(/"earningsDate"\s*:\s*\[\s*\{\s*"raw"\s*:\s*(\d+)/);
    if (em) {
      const ts = parseInt(em[1], 10);
      if (!isNaN(ts) && ts * 1000 > Date.now()) earningsDateTs = ts;
    }

    return { shortPercentOfFloat: shortPct, earningsDateTs };
  } catch { return empty; }
}

// ─── Layer F: fundamentals timeseries — short interest fallback ───────────────
async function tryShortInterestTimeseries(ticker: string): Promise<number | null> {
  try {
    const now  = Math.floor(Date.now() / 1000);
    const year = now - 365 * 24 * 3600;
    const url  = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}` +
                 `?type=trailingShortPercentOfFloat&period1=${year}&period2=${now}&lang=en-US&region=US`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j: any = await r.json();
    const rows: any[] = j?.timeseries?.result?.[0]?.trailingShortPercentOfFloat ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i]?.reportedValue?.raw;
      if (v != null && typeof v === 'number') return v;
    }
    return null;
  } catch { return null; }
}

// ─── Layer C: quoteSummary without crumb ──────────────────────────────────────
async function tryNoCrumb(ticker: string): Promise<any> {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${MODULES}&formatted=false`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.quoteSummary?.result?.[0] ?? null;
  } catch { return null; }
}

// ─── Layer D: cookie + crumb flow ─────────────────────────────────────────────
async function tryWithCrumb(ticker: string): Promise<any> {
  try {
    const pageRes = await fetch(`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    const rawCookie = pageRes.headers.get('set-cookie') ?? '';
    const cookie = rawCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
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
  } catch { return null; }
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

  try {
    let result: any;

    if (isTSX(t)) {
      // For Canadian/TSX stocks: chart API is most reliable → v7 → quoteSummary
      result =
        (await tryChart(t)) ??
        (await tryV7Quote(t)) ??
        (await tryNoCrumb(t)) ??
        (await tryWithCrumb(t));
    } else {
      // For US stocks: try quoteSummary first (more data) → fall back to chart
      result =
        (await tryNoCrumb(t)) ??
        (await tryWithCrumb(t)) ??
        (await tryV7Quote(t)) ??
        (await tryChart(t));
    }

    if (result) {
      // Check whether we're missing short interest or calendar events
      const missingShort    = result.defaultKeyStatistics?.shortPercentOfFloat == null;
      const missingCalendar = result.calendarEvents == null;

      if (result._partial || missingShort || missingCalendar) {
        // Run supplementary fetches in parallel — HTML scrape is the most reliable
        // since the page is less aggressively blocked than API endpoints.
        const [htmlData, tsVal] = await Promise.all([
          tryHTMLScrape(t),
          missingShort ? tryShortInterestTimeseries(t) : Promise.resolve(null),
        ]);

        // Merge short interest — HTML scrape wins, timeseries as secondary fallback
        const siVal = htmlData.shortPercentOfFloat ?? tsVal;
        if (siVal != null) {
          if (!result.defaultKeyStatistics) result.defaultKeyStatistics = {};
          if (result.defaultKeyStatistics.shortPercentOfFloat == null)
            result.defaultKeyStatistics.shortPercentOfFloat = siVal;
        }

        // Merge earnings date from HTML scrape when calendar is missing
        if (missingCalendar && htmlData.earningsDateTs != null) {
          result.calendarEvents = {
            earnings: {
              earningsDate: [{ raw: htmlData.earningsDateTs, fmt: new Date(htmlData.earningsDateTs * 1000).toISOString().split('T')[0] }],
            },
          };
        }
      }
      return res.status(200).json(result);
    }
  } catch { /* fall through */ }

  return res.status(200).json({ _error: 'All Yahoo Finance layers failed for ' + t });
}
