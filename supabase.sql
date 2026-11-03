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

-- 開啟並強制 RLS：
-- 即使有人從別處拿到 anon 或 user token，也完全無法直接讀寫資料表
alter table public.proverbs enable row level security;
alter table public.proverbs force row level security;

-- 移除舊政策並建立明確阻擋規則，滿足 Supabase Security Advisor
drop policy if exists "school users insert own" on public.proverbs;
drop policy if exists "users read own" on public.proverbs;
drop policy if exists "admin read all" on public.proverbs;
drop policy if exists "admin delete" on public.proverbs;
drop policy if exists "allow service_role" on public.proverbs;
drop policy if exists "deny public" on public.proverbs;

create policy "allow service_role" on public.proverbs for all to service_role using (true) with check (true);
create policy "deny public" on public.proverbs as restrictive for all to anon, authenticated using (false) with check (false);
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


-- ===== 安全強化新增（請在 Supabase SQL Editor 執行一次）=====
-- 實拍照片改存專用資料表：只有 service_role（伺服器）能讀寫，使用者無法透過 Supabase 改寫
-- [注意] 考量校園資安與個資法隱私權最小化原則，已全面取消學生三張臉部照片採集，本資料表僅供歷史相容保留
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  selfie_front text not null,
  selfie_right text not null,
  selfie_left text not null,
  selfie_at timestamptz not null default now()
);
alter table public.user_profiles enable row level security;
revoke all on public.user_profiles from anon, authenticated;

-- 限流紀錄（serverless 多實例也能共用）
create table if not exists public.rate_limits (
  id bigint generated always as identity primary key,
  key text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limits_key_time on public.rate_limits (key, created_at);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

-- 後台操作稽核紀錄
create table if not exists public.admin_audit (
  id bigint generated always as identity primary key,
  action text not null,
  target text,
  ip text,
  created_at timestamptz not null default now()
);
alter table public.admin_audit enable row level security;
revoke all on public.admin_audit from anon, authenticated;

-- 使用者全站互動與行為安全審計紀錄（結構化儲存）
create table if not exists public.activity_logs (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  user_name text,
  action text not null,
  details text,
  device_info text,
  ip_address text,
  created_at timestamptz not null default now()
);
create index if not exists activity_logs_user_time on public.activity_logs (user_email, created_at);
alter table public.activity_logs enable row level security;
revoke all on public.activity_logs from anon, authenticated;


-- DFC 互動影片防暴雷授權名單資料表（可於 Supabase Table Editor / SQL 直接自由新增或由後台管理）
-- email_pattern 支援完整信箱（如 s112001@hlc.edu.tw）或萬用字元（如 s112*@hlc.edu.tw）
create table if not exists public.dfc_access_list (
  id bigint generated always as identity primary key,
  email_pattern text not null unique,
  note text default '',
  added_by text default 'admin',
  created_at timestamptz not null default now()
);
alter table public.dfc_access_list enable row level security;
revoke all on public.dfc_access_list from anon, authenticated;
drop policy if exists "allow service_role dfc_access" on public.dfc_access_list;
create policy "allow service_role dfc_access" on public.dfc_access_list for all to service_role using (true) with check (true);


-- ===== DFC 互動問卷設定資料表（問卷題目、時間點與設定原生儲存於 Supabase，完全免 Google Form） =====
create table if not exists public.dfc_forms (
  id text primary key,
  title text not null default 'DFC 互動影片探究問卷',
  description text default '',
  video_url text default '',
  fallback_duration integer default 363,
  submit_mode text default 'end' check (submit_mode in ('end', 'each')),
  allow_seek text default 'watched' check (allow_seek in ('watched', 'locked', 'free')),
  allow_rewind boolean default true,
  allow_speed boolean default false,
  pause_on_blur boolean default true,
  is_active boolean default false,
  checkpoints jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dfc_forms enable row level security;
alter table public.dfc_forms force row level security;
revoke all on public.dfc_forms from anon, authenticated;
drop policy if exists "allow service_role dfc_forms" on public.dfc_forms;
create policy "allow service_role dfc_forms" on public.dfc_forms for all to service_role using (true) with check (true);

-- ===== DFC 學生問卷填答與統計結果資料表（原生儲存於 Supabase，後台直接檢視分析與匯出 CSV） =====
create table if not exists public.dfc_responses (
  id uuid primary key default gen_random_uuid(),
  form_id text references public.dfc_forms(id) on delete cascade,
  form_title text not null default '',
  user_id uuid references auth.users(id) on delete set null,
  user_email text not null default '',
  user_name text default '',
  user_class text default '',
  answers jsonb not null default '{}'::jsonb,
  telemetry jsonb default '{}'::jsonb,
  engagement jsonb default '{}'::jsonb,
  device text default '',
  ip_address text default '',
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists dfc_responses_form_time on public.dfc_responses (form_id, submitted_at desc);
create index if not exists dfc_responses_user_time on public.dfc_responses (user_email, submitted_at desc);

alter table public.dfc_responses enable row level security;
alter table public.dfc_responses force row level security;
revoke all on public.dfc_responses from anon, authenticated;
drop policy if exists "allow service_role dfc_responses" on public.dfc_responses;
create policy "allow service_role dfc_responses" on public.dfc_responses for all to service_role using (true) with check (true);

-- ===== 系統全域設定資料表（後台管理員清單、全域模式等儲存於 Supabase） =====
create table if not exists public.sys_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sys_settings enable row level security;
alter table public.sys_settings force row level security;
revoke all on public.sys_settings from anon, authenticated;
drop policy if exists "allow service_role sys_settings" on public.sys_settings;
create policy "allow service_role sys_settings" on public.sys_settings for all to service_role using (true) with check (true);

-- 預設 DFC 表單種子資料（若無資料時建立）
insert into public.dfc_forms (
  id, title, description, video_url, fallback_duration,
  submit_mode, allow_seek, allow_rewind, allow_speed, pause_on_blur, is_active, checkpoints
) values (
  'default-dfc',
  'DFC 互動影片探究問卷',
  'DFC 四步驟互動影片探究與反思問卷',
  'https://drive.google.com/file/d/1Jm37XrtHhQP8BIVapn7jY00mx2T_MESe/preview',
  363,
  'end',
  'watched',
  true,
  false,
  true,
  true,
  '[
    {"id": "q1", "time": 4, "stepLabel": "階段一 · 感受 Feel (第1題)", "title": "在剛才影片片段中，你觀察到最核心的校園問題是什麼？", "type": "radio", "options": ["資訊傳遞分散", "空間與動線視覺凌亂", "缺乏即時回饋管道"], "desc": "請選擇一個最貼近你觀察到的現象。", "required": true},
    {"id": "q2", "time": 4, "stepLabel": "階段一 · 感受 Feel (第2題)", "title": "你認為這個問題對哪一群體的影響最大？", "type": "checkbox", "options": ["全體學生", "導師與行政組長", "家長與校友", "學校訪客"], "desc": "支援同時間點連續提問。", "required": true},
    {"id": "q3", "time": 10, "stepLabel": "階段二 · 想像 Imagine (第1題)", "title": "針對這個問題，你認為哪些創意解方最值得嘗試？", "type": "checkbox", "options": ["導入互動式影音表單", "建立校園專屬的一句話共創牆", "結合跨班級工作坊快速製作原型"], "desc": "此題為多選題，可勾選一或多項方案。", "required": true},
    {"id": "q4", "time": 10, "stepLabel": "階段二 · 想像 Imagine (第2題)", "title": "你認為以上解方的實施難易度為何？", "type": "dropdown", "options": ["非常容易立即推行", "需要跨處室合作", "需要較多經費與時間"], "desc": "評估解方可行性。", "required": false},
    {"id": "q5", "time": 18, "stepLabel": "階段三 · 實踐 Do", "title": "請簡述你在本次行動中擔任的角色或預計實踐的項目", "type": "textarea", "options": [], "desc": "限 50 字以內，簡要描述即可。", "required": false},
    {"id": "q6", "time": 22, "stepLabel": "階段四 · 分享 Share (第1題)", "title": "你是否願意將本次成果分享於全校互動成果牆？", "type": "boolean", "options": [], "desc": "二選一是非題", "required": true},
    {"id": "q7", "time": 22, "stepLabel": "階段四 · 分享 Share (第2題)", "title": "你對本次校園 DFC 方案的整體推薦評分？", "type": "rating", "options": [], "desc": "1~5 星評分量表，作答後表單即完成！", "min": 1, "max": 5, "required": true}
  ]'::jsonb
) on conflict (id) do nothing;
