import { useState } from 'react';
import { TrendingUp, Eye, BarChart2, PieChart, BookOpen, ClipboardList, Download, Layers, Lock, Unlock } from 'lucide-react';
import TriFrameScorecard from './components/tabs/TriFrameScorecard';
import WatchList from './components/tabs/WatchList';
import TechnicalSetup from './components/tabs/TechnicalSetup';
import PortfolioRisk from './components/tabs/PortfolioRisk';
import Fundamentals from './components/tabs/Fundamentals';
import TradeJournal from './components/tabs/TradeJournal';
import { importSeedData } from './data/seedData';

const LOCK_KEY = 'swing_locked';

const TABS = [
  { id: 'scorecard', label: 'Scorecard', icon: Layers },
  { id: 'watchlist', label: 'Watch List', icon: Eye },
  { id: 'technical', label: 'Technical Setup', icon: BarChart2 },
  { id: 'portfolio', label: 'Portfolio Risk', icon: PieChart },
  { id: 'fundamentals', label: 'Fundamentals', icon: BookOpen },
  { id: 'journal', label: 'Trade Journal', icon: ClipboardList },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('scorecard');
  const [importing, setImporting] = useState(false);
  const [locked, setLocked] = useState<boolean>(() => localStorage.getItem(LOCK_KEY) === 'true');

  async function handleImport() {
    setImporting(true);
    try {
      await importSeedData();
      alert('Portfolio data imported! Refresh the tab to see it.');
    } finally {
      setImporting(false);
    }
  }

  function toggleLock() {
    const next = !locked;
    setLocked(next);
    localStorage.setItem(LOCK_KEY, String(next));
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center gap-3 py-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600">
              <TrendingUp size={16} className="text-white" />
            </div>
            <h1 className="text-base font-semibold text-zinc-100">Swing Trading Dashboard</h1>

            <div className="ml-auto flex items-center gap-3">
              {!locked && (
                <button
                  onClick={handleImport}
                  disabled={importing}
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
                  title="Import portfolio seed data from Excel"
                >
                  <Download size={12} />
                  {importing ? 'Importing…' : 'Import Data'}
                </button>
              )}
              <button
                onClick={toggleLock}
                className={`flex items-center gap-1.5 text-xs transition-colors ${locked ? 'text-amber-500 hover:text-amber-300' : 'text-zinc-600 hover:text-zinc-400'}`}
                title={locked ? 'Locked — click to unlock admin controls' : 'Click to lock (hides Import Data for sharing)'}
              >
                {locked ? <Lock size={12} /> : <Unlock size={12} />}
                {locked ? 'Locked' : 'Lock'}
              </button>
            </div>

            <span className="text-xs text-zinc-700 mx-1">|</span>
            <span className="text-xs text-zinc-600">Powered by Finnhub</span>
          </div>
          {/* Tab bar */}
          <nav className="flex gap-1 -mb-px overflow-x-auto">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {activeTab === 'scorecard' && <TriFrameScorecard />}
        {activeTab === 'watchlist' && <WatchList />}
        {activeTab === 'technical' && <TechnicalSetup />}
        {activeTab === 'portfolio' && <PortfolioRisk />}
        {activeTab === 'fundamentals' && <Fundamentals />}
        {activeTab === 'journal' && <TradeJournal />}
      </main>
    </div>
  );
}
