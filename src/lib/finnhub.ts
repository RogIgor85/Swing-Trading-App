import type {
  FinnhubQuote,
  FinnhubProfile,
  FinnhubMetrics,
  FinnhubEarnings,
  FinnhubSentiment,
} from '../types';

const API_KEY = import.meta.env.VITE_FINNHUB_API_KEY as string;
const BASE = 'https://finnhub.io/api/v1';

async function get<T>(path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}token=${API_KEY}`);
  if (!res.ok) throw new Error(`Finnhub error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export const finnhub = {
  quote: (symbol: string) =>
    get<FinnhubQuote>(`/quote?symbol=${symbol.toUpperCase()}`),

  profile: (symbol: string) =>
    get<FinnhubProfile>(`/stock/profile2?symbol=${symbol.toUpperCase()}`),

  metrics: (symbol: string) =>
    get<FinnhubMetrics>(`/stock/metric?symbol=${symbol.toUpperCase()}&metric=all`),

  earnings: (symbol: string) =>
    get<FinnhubEarnings[]>(`/stock/earnings?symbol=${symbol.toUpperCase()}`),

  epsEstimate: (symbol: string) =>
    get<{ data: Array<{ epsAvg: number; epsHigh: number; epsLow: number; period: string; year: number }> }>(
      `/stock/eps-estimate?symbol=${symbol.toUpperCase()}&freq=quarterly`
    ),

  revenueEstimate: (symbol: string) =>
    get<{ data: Array<{ revenueAvg: number; revenueHigh: number; revenueLow: number; period: string; year: number }> }>(
      `/stock/revenue-estimate?symbol=${symbol.toUpperCase()}&freq=quarterly`
    ),

  sentiment: (symbol: string) =>
    get<FinnhubSentiment>(`/news-sentiment?symbol=${symbol.toUpperCase()}`),

  news: (symbol: string) =>
    get<Array<{ headline: string; source: string; datetime: number; url: string; summary: string }>>(
      `/company-news?symbol=${symbol.toUpperCase()}&from=${daysAgo(30)}&to=${today()}`
    ),
};

function today() {
  return new Date().toISOString().split('T')[0];
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
