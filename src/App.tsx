import { useState, useEffect } from 'react';
import { TrendingUp, Eye, ScanLine, PieChart, BookOpen, ClipboardList, Layers, LogOut } from 'lucide-react';
import TriFrameScorecard from './components/tabs/TriFrameScorecard';
import WatchList from './components/tabs/WatchList';
import ChartAnalysis from './components/tabs/ChartAnalysis';
import PortfolioRisk from './components/tabs/PortfolioRisk';
import Fundamentals from './components/tabs/Fundamentals';
import TradeJournal from './components/tabs/TradeJournal';
import Auth from './components/Auth';
import { supabase } from './lib/supabase';
import type { User } from '@supabase/supabase-js';

const TABS = [
  { id: 'scorecard', label: 'Scorecard', icon: Layers },
  { id: 'watchlist', label: 'Watch List', icon: Eye },
  { id: 'technical', label: 'Chart Analysis', icon: ScanLine },
  { id: 'portfolio', label: 'Portfolio', icon: PieChart },
  { id: 'journal', label: 'Trade Journal', icon: ClipboardList },
  { id: 'fundamentals', label: 'Fundamentals', icon: BookOpen },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('scorecard');
  const [user, setUser]           = useState<User | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    if (!supabase) { setUser(null); return; }

    // Get current session on mount
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    // Listen for login/logout
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  // Still checking auth state
  if (user === undefined) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Not logged in — show auth screen
  if (supabase && user === null) {
    return <Auth />;
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
            <h1 className="text-base font-semibold text-zinc-100">Trading Dashboard</h1>

            <div className="ml-auto flex items-center gap-3">
              {user && (
                <span className="text-xs text-zinc-500 hidden sm:block truncate max-w-[180px]">
                  {user.email}
                </span>
              )}
              {user && (
                <button
                  onClick={handleSignOut}
                  title="Sign out"
                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200 transition-colors px-2 py-1 rounded-lg hover:bg-zinc-800"
                >
                  <LogOut size={13} />
                  <span className="hidden sm:block">Sign out</span>
                </button>
              )}
              {!user && (
                <span className="text-xs text-zinc-600">Powered by Finnhub</span>
              )}
            </div>
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

      {/* Content — portfolio gets a wider container to avoid table scroll */}
      <main className={`mx-auto px-4 py-6 ${activeTab === 'portfolio' ? 'max-w-[1600px]' : 'max-w-7xl'}`}>
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
