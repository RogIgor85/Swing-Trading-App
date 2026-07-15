-- ─────────────────────────────────────────────────────────────────────────────
-- RLS LOCKDOWN MIGRATION
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- What it does, for every app table that exists in your database:
--   1. Adds a user_id column if it's missing (defaults to the signed-in user)
--   2. Backfills any rows that have no user_id to YOUR account
--      (safe because you are currently the only user)
--   3. Enables Row Level Security
--   4. Drops the wide-open "public_access" policy
--   5. Creates a strict policy: each user can only see/insert/update/delete
--      their OWN rows (auth.uid() = user_id)
--
-- After running this, sharing the app link is safe: new users who sign up
-- get an empty app and can never read or touch your data.
--
-- IMPORTANT: verify you are the only user first —
--   select id, email from auth.users;
-- should return exactly one row (you). If there are extra/test accounts,
-- delete them in Dashboard → Authentication → Users before running this.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  my_user_id uuid;
  tables text[] := array[
    'holdings',
    'watch_items',
    'trade_journal',
    'fundamentals',
    'net_worth_items',
    'option_trades',
    'sprint_settings',
    'sprint_positions',
    'sprint_trades',
    'sprint_plans',
    -- legacy tables (locked down too if they exist)
    'scorecard',
    'scorecard_entries',
    'technical_setups',
    'portfolio_holdings',
    'fundamental_notes',
    'watchlist'
  ];
begin
  -- Grab your user id (you must be the only user — see note above)
  select id into my_user_id from auth.users order by created_at asc limit 1;
  if my_user_id is null then
    raise exception 'No users found in auth.users — sign in to the app once, then re-run.';
  end if;

  foreach t in array tables loop
    -- Skip tables that don't exist in this database
    if to_regclass('public.' || t) is null then
      raise notice 'Skipping % (table does not exist)', t;
      continue;
    end if;

    -- 1. Ensure user_id column exists
    execute format(
      'alter table public.%I add column if not exists user_id uuid references auth.users(id) on delete cascade',
      t
    );

    -- New rows automatically get the signed-in user's id even if the client
    -- forgets to send one
    execute format(
      'alter table public.%I alter column user_id set default auth.uid()',
      t
    );

    -- 2. Backfill orphan rows to your account
    execute format(
      'update public.%I set user_id = %L where user_id is null',
      t, my_user_id
    );

    -- 3. Enable RLS
    execute format('alter table public.%I enable row level security', t);

    -- 4. Drop the wide-open policies if present
    execute format('drop policy if exists "public_access" on public.%I', t);
    execute format('drop policy if exists "owner_only" on public.%I', t);

    -- 5. Strict per-user policy
    execute format(
      'create policy "owner_only" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );

    raise notice 'Locked down %', t;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — run these after the migration:
--
-- 1. Every table should show rowsecurity = true and a single "owner_only" policy:
--    select tablename, rowsecurity from pg_tables where schemaname = 'public';
--    select tablename, policyname, cmd from pg_policies where schemaname = 'public';
--
-- 2. No orphan rows should remain:
--    select count(*) from holdings where user_id is null;   -- expect 0
--
-- 3. In the app (signed in as you): everything should look exactly the same.
--    In an incognito window, sign up with a throwaway email: the app should
--    be completely empty.
-- ─────────────────────────────────────────────────────────────────────────────
