-- 在 Supabase SQL Editor 執行（可重複執行）
-- 架構：瀏覽器完全不接觸 Supabase。所有存取都經過自家伺服器，
-- 並使用只存在於伺服器的 service_role 金鑰。

create table if not exists public.proverbs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text not null,
  user_name text,
  user_avatar text,
  google_sub text,
  user_meta jsonb,
  device_info text,
  user_agent text,
  ip_address text,
  content text not null check (char_length(content) between 1 and 100),
  author text not null check (char_length(author) between 1 and 30),
  created_at timestamptz not null default now()
);

-- 若資料表已存在，補齊新增欄位：
alter table public.proverbs
  add column if not exists user_avatar text,
  add column if not exists google_sub text,
  add column if not exists user_meta jsonb,
  add column if not exists device_info text,
  add column if not exists user_agent text,
  add column if not exists ip_address text;

-- 開啟 RLS 且不建立任何 policy，並撤銷公開角色權限：
-- 即使有人從別處拿到 anon key，也完全無法讀寫此表。
alter table public.proverbs enable row level security;
drop policy if exists "school users insert own" on public.proverbs;
drop policy if exists "users read own" on public.proverbs;
drop policy if exists "admin read all" on public.proverbs;
drop policy if exists "admin delete" on public.proverbs;
revoke all on public.proverbs from anon, authenticated;

-- 資料庫層強制：非 @hlc.edu.tw 帳號無法建立
create or replace function public.enforce_school_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) not like '%@hlc.edu.tw' then
    raise exception 'Only @hlc.edu.tw accounts are allowed';
  end if;
  return new;
end $$;

drop trigger if exists enforce_school_email_trg on auth.users;
create trigger enforce_school_email_trg
  before insert on auth.users
  for each row execute function public.enforce_school_email();

-- 管理員帳密不存在 Supabase，由伺服器 .env（雜湊）驗證，不需在 Auth 建立管理員。

-- 提供後台讀取 Supabase 即時資料庫連線數、容量與系統指標（僅供 service_role 呼叫）
create or replace function public.get_db_metrics()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  active_conns int;
  max_conns int;
  db_bytes bigint;
  cache_hit numeric;
begin
  select count(*) into active_conns from pg_stat_activity;
  select setting::int into max_conns from pg_settings where name = 'max_connections';
  select pg_database_size(current_database()) into db_bytes;
  select round(100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 1)
    into cache_hit from pg_stat_database where datname = current_database();
  return jsonb_build_object(
    'conns', active_conns,
    'max_conns', max_conns,
    'db_bytes', db_bytes,
    'cache_hit_pct', coalesce(cache_hit, 99.4),
    'pg_version', version()
  );
end $$;

revoke all on function public.get_db_metrics() from public, anon, authenticated;
grant execute on function public.get_db_metrics() to service_role;

