/**
 * Hybrid storage: Supabase when configured (with user scoping), localStorage fallback.
 * Each table maps to a localStorage key prefixed with "swing_".
 */
import { supabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function getUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

export const storage = {
  async getAll<T>(table: string): Promise<T[]> {
    if (supabase) {
      const userId = await getUserId();
      let query = supabase.from(table).select('*').order('created_at', { ascending: false });
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as T[];
    }
    return (JSON.parse(localStorage.getItem(`swing_${table}`) ?? '[]') as T[]).sort(
      (a, b) => String((b as Row).created_at ?? '').localeCompare(String((a as Row).created_at ?? ''))
    );
  },

  async insert<T>(table: string, row: T): Promise<T> {
    if (supabase) {
      const userId = await getUserId();
      const rowWithUser = userId ? { ...(row as Row), user_id: userId } : row;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.from(table).insert(rowWithUser as any).select().single();
      if (error) throw error;
      return data as T;
    }
    const rows = JSON.parse(localStorage.getItem(`swing_${table}`) ?? '[]') as T[];
    rows.push(row);
    localStorage.setItem(`swing_${table}`, JSON.stringify(rows));
    return row;
  },

  async update<T>(table: string, id: string, patch: Partial<T>): Promise<void> {
    if (supabase) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await supabase.from(table).update(patch as any).eq('id', id);
      if (error) throw error;
      return;
    }
    const rows = JSON.parse(localStorage.getItem(`swing_${table}`) ?? '[]') as Row[];
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) rows[idx] = { ...rows[idx], ...(patch as Row) };
    localStorage.setItem(`swing_${table}`, JSON.stringify(rows));
  },

  async remove(table: string, id: string): Promise<void> {
    if (supabase) {
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) throw error;
      return;
    }
    const rows = JSON.parse(localStorage.getItem(`swing_${table}`) ?? '[]') as Row[];
    localStorage.setItem(`swing_${table}`, JSON.stringify(rows.filter((r) => r.id !== id)));
  },
};

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
