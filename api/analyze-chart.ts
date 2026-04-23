import type { VercelRequest, VercelResponse } from '@vercel/node';

const SYSTEM_PROMPT = `You are an expert technical analyst with 20+ years of experience in equity markets.
A trader is sharing a stock chart with you for analysis. Be direct, specific, and actionable.

Analyze the chart and respond in this exact JSON format:
{
  "verdict": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "timeframe": "the timeframe visible on the chart if identifiable, e.g. Daily, Weekly, 1H",
  "pattern": "the primary chart pattern you see, e.g. Bull Flag, Cup & Handle, Breakout, H&S, etc. or None",
  "trend": {
    "short": "BULLISH" | "BEARISH" | "NEUTRAL",
    "medium": "BULLISH" | "BEARISH" | "NEUTRAL",
    "long": "BULLISH" | "BEARISH" | "NEUTRAL"
  },
  "key_levels": {
    "support": ["list of support price levels you can read from the chart"],
    "resistance": ["list of resistance price levels you can read from the chart"]
  },
  "indicators": {
    "ma_observations": "observations about moving averages if visible",
    "rsi": "RSI reading and interpretation if visible",
    "volume": "volume observations if visible",
    "macd": "MACD observations if visible"
  },
  "summary": "2-3 sentence plain English summary of what you see and what it means for a trader",
  "entry_notes": "specific notes on entry — where to buy, what to wait for",
  "risk_notes": "what would invalidate this setup, where to put a stop",
  "warnings": ["any red flags or cautions — e.g. extended from MA, earnings soon, low volume, etc."]
}

Be specific with price levels when you can read them from the chart. If the chart is unclear or not a stock chart, still do your best.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, mediaType } = req.body as { image: string; mediaType: string };
  if (!image) return res.status(400).json({ error: 'image required (base64)' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/png',
                  data: image,
                },
              },
              {
                type: 'text',
                text: 'Analyze this chart and give me your full technical assessment.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Anthropic API error: ${err}` });
    }

    const data: any = await response.json();
    const text = data.content?.[0]?.text ?? '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse analysis', raw: text });

    const analysis = JSON.parse(jsonMatch[0]);
    return res.status(200).json(analysis);
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? 'Unknown error' });
  }
}
