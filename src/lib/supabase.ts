import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

console.log('[Supabase] URL:', supabaseUrl ? '✅ set' : '❌ missing');
console.log('[Supabase] Key:', supabaseAnonKey ? '✅ set' : '❌ missing');

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

console.log('[Supabase] Client:', supabase ? '✅ initialized' : '❌ null (using localStorage)');

export const isSupabaseConfigured = !!supabase;
