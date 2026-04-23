import { useState } from 'react';
import { TrendingUp, Mail, Lock, Loader, AlertTriangle, UserPlus, LogIn } from 'lucide-react';
import { supabase } from '../lib/supabase';

type Mode = 'login' | 'signup' | 'forgot';

export default function Auth() {
  const [mode, setMode]         = useState<Mode>('login');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [message, setMessage]   = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage('Account created! Check your email to confirm, then log in.');
        setMode('login');
        setPassword('');
        return;
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (error) throw error;
        setMessage('Password reset link sent — check your email.');
        setMode('login');
        return;
      }
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-blue-600 mb-4">
            <TrendingUp size={22} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-zinc-100">Swing Trading Dashboard</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {mode === 'login'  && 'Sign in to your account'}
            {mode === 'signup' && 'Create your account'}
            {mode === 'forgot' && 'Reset your password'}
          </p>
        </div>

        {/* Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl">
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Email */}
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Email</label>
              <div className="relative">
                <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>

            {/* Password */}
            {mode !== 'forgot' && (
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Password</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'signup' ? 'Min. 6 characters' : '••••••••'}
                    required
                    minLength={mode === 'signup' ? 6 : undefined}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">
                <AlertTriangle size={13} className="text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-300">{error}</p>
              </div>
            )}

            {/* Success message */}
            {message && (
              <div className="bg-emerald-950/40 border border-emerald-800 rounded-lg px-3 py-2">
                <p className="text-xs text-emerald-300">{message}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              {loading ? (
                <Loader size={14} className="animate-spin" />
              ) : mode === 'login' ? (
                <><LogIn size={14} /> Sign In</>
              ) : mode === 'signup' ? (
                <><UserPlus size={14} /> Create Account</>
              ) : (
                'Send Reset Link'
              )}
            </button>
          </form>

          {/* Mode switcher */}
          <div className="mt-5 pt-4 border-t border-zinc-800 space-y-2 text-center">
            {mode === 'login' && (
              <>
                <button
                  onClick={() => { setMode('signup'); setError(null); setMessage(null); }}
                  className="block w-full text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Don't have an account? <span className="text-blue-400 font-medium">Sign up</span>
                </button>
                <button
                  onClick={() => { setMode('forgot'); setError(null); setMessage(null); }}
                  className="block w-full text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  Forgot password?
                </button>
              </>
            )}
            {mode === 'signup' && (
              <button
                onClick={() => { setMode('login'); setError(null); setMessage(null); }}
                className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Already have an account? <span className="text-blue-400 font-medium">Sign in</span>
              </button>
            )}
            {mode === 'forgot' && (
              <button
                onClick={() => { setMode('login'); setError(null); setMessage(null); }}
                className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Back to sign in
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
