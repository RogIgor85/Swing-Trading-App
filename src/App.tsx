import { useState } from 'react';
import { TrendingUp, Eye, ScanLine, PieChart, BookOpen, ClipboardList, Layers } from 'lucide-react';
import TriFrameScorecard from './components/tabs/TriFrameScorecard';
import WatchList from './components/tabs/WatchList';
import ChartAnalysis from './components/tabs/ChartAnalysis';
import PortfolioRisk from './components/tabs/PortfolioRisk';
import Fundamentals from './components/tabs/Fundamentals';
import TradeJournal from './components/tabs/TradeJournal';

const TABS = [
  { id: 'scorecard', label: 'Scorecard', icon: Layers },
  { id: 'watchlist', label: 'Watch List', icon: Eye },
  { id: 'technical', label: 'Chart Analysis', icon: ScanLine },
  { id: 'portfolio', label: 'Portfolio Risk', icon: PieChart },
  { id: 'fundamentals', label: 'Fundamentals', icon: BookOpen },
  { id: 'journal', label: 'Trade Journal', icon: ClipboardList },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('scorecard');

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

            <span className="ml-auto text-xs text-zinc-600">Powered by Finnhub</span>
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
        {activeTab === 'technical' && <ChartAnalysis />}
        {activeTab === 'portfolio' && <PortfolioRisk />}
        {activeTab === 'fundamentals' && <Fundamentals />}
        {activeTab === 'journal' && <TradeJournal />}
      </main>
    </div>
  );
}
