import { useState, useRef, useCallback } from 'react';
import { Upload, X, TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle, Loader } from 'lucide-react';

interface ChartAnalysis {
  verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  timeframe: string;
  pattern: string;
  trend: { short: string; medium: string; long: string };
  key_levels: { support: string[]; resistance: string[] };
  indicators: { ma_observations: string; rsi: string; volume: string; macd: string };
  summary: string;
  entry_notes: string;
  risk_notes: string;
  warnings: string[];
}

const VERDICT_STYLE = {
  BULLISH: {
    bg:     'bg-emerald-900/30 border-emerald-600',
    text:   'text-emerald-400',
    icon:   <TrendingUp size={28} className="text-emerald-400" />,
    glow:   'shadow-[0_0_30px_rgba(16,185,129,0.2)]',
  },
  BEARISH: {
    bg:     'bg-red-900/30 border-red-600',
    text:   'text-red-400',
    icon:   <TrendingDown size={28} className="text-red-400" />,
    glow:   'shadow-[0_0_30px_rgba(239,68,68,0.2)]',
  },
  NEUTRAL: {
    bg:     'bg-zinc-800/60 border-zinc-600',
    text:   'text-zinc-300',
    icon:   <Minus size={28} className="text-zinc-400" />,
    glow:   '',
  },
};

const TREND_COLOR: Record<string, string> = {
  BULLISH: 'text-emerald-400',
  BEARISH: 'text-red-400',
  NEUTRAL: 'text-zinc-400',
};
const TREND_ICON: Record<string, React.ReactNode> = {
  BULLISH: <TrendingUp size={12} />,
  BEARISH: <TrendingDown size={12} />,
  NEUTRAL: <Minus size={12} />,
};

const CONFIDENCE_COLOR: Record<string, string> = {
  HIGH:   'text-emerald-400 bg-emerald-900/30 border-emerald-700',
  MEDIUM: 'text-amber-400 bg-amber-900/30 border-amber-700',
  LOW:    'text-zinc-400 bg-zinc-800 border-zinc-600',
};

export default function ChartAnalysis() {
  const [image, setImage]         = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<string>('image/png');
  const [preview, setPreview]     = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult]       = useState<ChartAnalysis | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const fileRef                   = useRef<HTMLInputElement>(null);
  const dropRef                   = useRef<HTMLDivElement>(null);

  function loadFile(file: File) {
    setResult(null);
    setError(null);
    setMediaType(file.type || 'image/png');
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setPreview(dataUrl);
      // Strip the data:...;base64, prefix
      setImage(dataUrl.split(',')[1]);
    };
    reader.readAsDataURL(file);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) loadFile(file);
  }, []);

  // Support paste from clipboard
  function handlePaste(e: React.ClipboardEvent) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (item) {
      const file = item.getAsFile();
      if (file) loadFile(file);
    }
  }

  function clearImage() {
    setImage(null);
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function analyze() {
    if (!image) return;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/analyze-chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, mediaType }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data as ChartAnalysis);
    } catch (err: any) {
      setError(err.message ?? 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  }

  const vs = result ? VERDICT_STYLE[result.verdict] : null;

  return (
    <div className="space-y-6" onPaste={handlePaste}>

      {/* Upload area */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-1">AI Chart Analysis</h2>
        <p className="text-xs text-zinc-500 mb-4">
          Upload, drag & drop, or <kbd className="bg-zinc-700 px-1 rounded text-zinc-300">Ctrl+V</kbd> paste a chart screenshot.
          Claude will assess the setup and tell you if it's bullish or bearish.
        </p>

        {!preview ? (
          <div
            ref={dropRef}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-zinc-700 hover:border-blue-500 rounded-xl p-12 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors group"
          >
            <Upload size={32} className="text-zinc-600 group-hover:text-blue-400 transition-colors" />
            <div className="text-center">
              <p className="text-sm text-zinc-400 group-hover:text-zinc-200 transition-colors">Click to upload or drag & drop</p>
              <p className="text-xs text-zinc-600 mt-1">PNG, JPG, WebP · or paste with Ctrl+V</p>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Preview */}
            <div className="relative rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900">
              <img src={preview} alt="Chart" className="w-full max-h-96 object-contain" />
              <button
                onClick={clearImage}
                className="absolute top-2 right-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-full p-1.5 transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Analyze button */}
            <button
              onClick={analyze}
              disabled={analyzing}
              className="w-full btn-primary flex items-center justify-center gap-2 py-3 text-sm font-semibold"
            >
              {analyzing ? (
                <>
                  <Loader size={16} className="animate-spin" />
                  Analyzing chart…
                </>
              ) : (
                <>
                  <TrendingUp size={16} />
                  Analyze Chart
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="card border-red-800 bg-red-950/20 flex items-start gap-3">
          <AlertTriangle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && vs && (
        <div className="space-y-4">

          {/* Verdict hero */}
          <div className={`card border-2 ${vs.bg} ${vs.glow}`}>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                {vs.icon}
                <div>
                  <div className={`text-4xl font-black tracking-wide ${vs.text}`}>{result.verdict}</div>
                  <div className="text-sm text-zinc-400 mt-0.5">
                    {result.pattern !== 'None' && result.pattern ? (
                      <span className="text-blue-300 font-medium">{result.pattern}</span>
                    ) : 'No clear pattern'}
                    {result.timeframe && <span className="text-zinc-600 ml-2">· {result.timeframe}</span>}
                  </div>
                </div>
              </div>
              <span className={`text-xs font-bold px-3 py-1.5 rounded-full border ${CONFIDENCE_COLOR[result.confidence]}`}>
                {result.confidence} CONFIDENCE
              </span>
            </div>

            {/* Summary */}
            <p className="mt-4 text-sm text-zinc-300 leading-relaxed border-t border-zinc-800 pt-4">
              {result.summary}
            </p>
          </div>

          {/* Trend + Levels grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

            {/* Trend */}
            <div className="card">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Trend Direction</h3>
              <div className="space-y-2.5">
                {(['short', 'medium', 'long'] as const).map((tf) => (
                  <div key={tf} className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500 capitalize">{tf}-term</span>
                    <div className={`flex items-center gap-1.5 text-xs font-semibold ${TREND_COLOR[result.trend[tf]] ?? 'text-zinc-400'}`}>
                      {TREND_ICON[result.trend[tf]]}
                      {result.trend[tf]}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Support */}
            <div className="card">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Support Levels</h3>
              {result.key_levels.support.length > 0 ? (
                <div className="space-y-1.5">
                  {result.key_levels.support.map((l, i) => (
                    <div key={i} className="text-sm text-emerald-400 font-mono font-medium">{l}</div>
                  ))}
                </div>
              ) : <p className="text-xs text-zinc-600">Not identifiable</p>}
            </div>

            {/* Resistance */}
            <div className="card">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Resistance Levels</h3>
              {result.key_levels.resistance.length > 0 ? (
                <div className="space-y-1.5">
                  {result.key_levels.resistance.map((l, i) => (
                    <div key={i} className="text-sm text-red-400 font-mono font-medium">{l}</div>
                  ))}
                </div>
              ) : <p className="text-xs text-zinc-600">Not identifiable</p>}
            </div>
          </div>

          {/* Indicators */}
          {(result.indicators.ma_observations || result.indicators.rsi || result.indicators.volume || result.indicators.macd) && (
            <div className="card">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Indicators</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {result.indicators.ma_observations && (
                  <div>
                    <div className="text-xs text-zinc-600 mb-0.5">Moving Averages</div>
                    <p className="text-xs text-zinc-300">{result.indicators.ma_observations}</p>
                  </div>
                )}
                {result.indicators.rsi && (
                  <div>
                    <div className="text-xs text-zinc-600 mb-0.5">RSI</div>
                    <p className="text-xs text-zinc-300">{result.indicators.rsi}</p>
                  </div>
                )}
                {result.indicators.volume && (
                  <div>
                    <div className="text-xs text-zinc-600 mb-0.5">Volume</div>
                    <p className="text-xs text-zinc-300">{result.indicators.volume}</p>
                  </div>
                )}
                {result.indicators.macd && (
                  <div>
                    <div className="text-xs text-zinc-600 mb-0.5">MACD</div>
                    <p className="text-xs text-zinc-300">{result.indicators.macd}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Entry + Risk */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="card border-emerald-900/50">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle size={14} className="text-emerald-400" />
                <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Entry Notes</h3>
              </div>
              <p className="text-sm text-zinc-300 leading-relaxed">{result.entry_notes}</p>
            </div>
            <div className="card border-red-900/50">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={14} className="text-red-400" />
                <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider">Risk / Invalidation</h3>
              </div>
              <p className="text-sm text-zinc-300 leading-relaxed">{result.risk_notes}</p>
            </div>
          </div>

          {/* Warnings */}
          {result.warnings.length > 0 && (
            <div className="card border-amber-900/50 bg-amber-950/10">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={14} className="text-amber-400" />
                <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Cautions</h3>
              </div>
              <div className="space-y-1.5">
                {result.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-amber-300/80">
                    <span className="mt-0.5 flex-shrink-0">·</span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Re-analyze button */}
          <button onClick={clearImage} className="btn-ghost text-sm flex items-center gap-2 mx-auto">
            <Upload size={13} /> Upload another chart
          </button>
        </div>
      )}
    </div>
  );
}
