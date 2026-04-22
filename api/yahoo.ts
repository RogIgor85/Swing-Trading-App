import type { VercelRequest, VercelResponse } from '@vercel/node';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Fetch a Yahoo Finance session cookie + crumb (required since Jan 2024)
async function getSession(): Promise<{ crumb: string; cookie: string } | null> {
  try {
    const pageRes = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    // Grab first Set-Cookie value
    const raw = pageRes.headers.get('set-cookie') ?? '';
    const cookie = raw.split(',').map((s) => s.split(';')[0]).join('; ');

    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.startsWith('<')) return null;
    return { crumb, cookie };
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker || typeof ticker !== 'string') {
    return res.status(400).json({ error: 'ticker query param required' });
  }

  try {
    const session = await getSession();
    if (!session) {
      return res.status(200).json({ _error: 'Could not establish Yahoo Finance session' });
    }

    const modules = [
      'financialData',
      'defaultKeyStatistics',
      'summaryDetail',
      'calendarEvents',
      'price',
    ].join(',');

    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/` +
      `${encodeURIComponent(ticker.toUpperCase())}` +
      `?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}&formatted=false`;

    const dataRes = await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: session.cookie },
    });

    const json: any = await dataRes.json();
    const result = json?.quoteSummary?.result?.[0];

    if (!result) {
      return res.status(200).json({ _error: json?.quoteSummary?.error?.description ?? 'No data' });
    }

    return res.status(200).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return res.status(200).json({ _error: msg });
  }
}
