// Frontend client — proxies requests through the Vercel serverless function
// so Yahoo Finance calls are server-side (avoids CORS + rate limit headers).

export interface YahooFinancialData {
  currentPrice?: number | null;
  targetMeanPrice?: number | null;
  targetHighPrice?: number | null;
  targetLowPrice?: number | null;
  recommendationKey?: string | null;   // 'strongBuy' | 'buy' | 'hold' | 'underperform' | 'sell'
  recommendationMean?: number | null;  // 1=Strong Buy … 5=Strong Sell
  numberOfAnalystOpinions?: number | null;
  totalRevenue?: number | null;
  revenueGrowth?: number | null;       // YoY quarterly, decimal e.g. 0.12
  earningsGrowth?: number | null;      // YoY quarterly, decimal
  grossProfits?: number | null;
  freeCashflow?: number | null;
  returnOnEquity?: number | null;      // decimal e.g. 0.25
  currentRatio?: number | null;
  debtToEquity?: number | null;        // e.g. 150 = 150% (Yahoo returns ×100)
  profitMargins?: number | null;       // net margin decimal
}

export interface YahooKeyStats {
  beta?: number | null;
  shortPercentOfFloat?: number | null; // decimal e.g. 0.05
  shortRatio?: number | null;
  priceToBook?: number | null;
  forwardPE?: number | null;
  trailingEps?: number | null;
  forwardEps?: number | null;
  pegRatio?: number | null;
  profitMargins?: number | null;
}

export interface YahooSummaryDetail {
  marketCap?: number | null;
  fiftyTwoWeekHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
  fiftyDayAverage?: number | null;
  twoHundredDayAverage?: number | null;
  averageVolume?: number | null;
  averageVolume10days?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  beta?: number | null;
  volume?: number | null;
  previousClose?: number | null;
  open?: number | null;
  dayLow?: number | null;
  dayHigh?: number | null;
  regularMarketPreviousClose?: number | null;
  regularMarketOpen?: number | null;
}

export interface YahooPrice {
  regularMarketPrice?: number | null;
  regularMarketOpen?: number | null;
  regularMarketDayHigh?: number | null;
  regularMarketDayLow?: number | null;
  regularMarketPreviousClose?: number | null;
  regularMarketVolume?: number | null;
  longName?: string | null;
  shortName?: string | null;
  exchangeName?: string | null;
  fullExchangeName?: string | null;
  currency?: string | null;
  marketCap?: number | null;
}

export interface YahooCalendar {
  earningsDate?: string[] | null;
}

export interface YahooData {
  financialData?: YahooFinancialData;
  defaultKeyStatistics?: YahooKeyStats;
  summaryDetail?: YahooSummaryDetail;
  calendarEvents?: { earnings?: YahooCalendar };
  price?: YahooPrice;
  _error?: string;
}

export async function fetchYahoo(ticker: string): Promise<YahooData> {
  try {
    // In dev mode, call through Vite proxy; in production it's a real Vercel function
    const url = `/api/yahoo?ticker=${encodeURIComponent(ticker)}`;
    const res = await fetch(url);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}
