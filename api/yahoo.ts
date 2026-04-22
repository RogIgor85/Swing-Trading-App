import type { VercelRequest, VercelResponse } from '@vercel/node';
// @ts-ignore — yahoo-finance2 CommonJS interop
import yahooFinance from 'yahoo-finance2';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker || typeof ticker !== 'string') {
    return res.status(400).json({ error: 'ticker query param required' });
  }

  try {
    const data = await (yahooFinance as any).quoteSummary(ticker.toUpperCase(), {
      modules: [
        'financialData',
        'defaultKeyStatistics',
        'summaryDetail',
        'calendarEvents',
        'price',
      ],
    });
    return res.status(200).json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Yahoo Finance error';
    // Return partial data rather than hard-failing — scoring engine handles nulls
    return res.status(200).json({ _error: msg });
  }
}
