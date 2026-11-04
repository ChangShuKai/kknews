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
  add column if not exists ip_address text,
  add column if not exists image_url text,
  add column if not exists ig_post_id text,
  add column if not exists ig_permalink text,
  add column if not exists ig_status text,
  add column if not exists ig_posted_at timestamptz;

-- Instagram 自動發布歷史紀錄表
create table if not exists public.instagram_logs (
  id bigint generated always as identity primary key,
  proverb_id bigint references public.proverbs(id) on delete set null,
  content text,
  author text,
  image_url text,
  status text not null, -- 'success', 'failed', 'skipped'
  ig_media_id text,
  ig_permalink text,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.instagram_logs enable row level security;
alter table public.instagram_logs force row level security;
revoke all on public.instagram_logs from anon, authenticated;
drop policy if exists "allow service_role instagram_logs" on public.instagram_logs;
create policy "allow service_role instagram_logs" on public.instagram_logs for all to service_role using (true) with check (true);

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

-- ===== DFC 問卷個別題目資料表（每道題目獨立一筆 Row，原生儲存於 Supabase，支援隨時查詢、修改與統計） =====
create table if not exists public.dfc_questions (
  id text primary key,
  form_id text not null references public.dfc_forms(id) on delete cascade,
  question_order integer not null default 0,
  time_seconds numeric not null default 0,
  step_label text default '',
  title text not null,
  type text not null default 'radio' check (type in ('radio', 'checkbox', 'rating', 'dropdown', 'boolean', 'text', 'textarea')),
  options jsonb not null default '[]'::jsonb,
  description text default '',
  required boolean not null default true,
  placeholder text default '',
  min_val integer default 1,
  max_val integer default 5,
  entry_id text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dfc_questions_form_order on public.dfc_questions (form_id, question_order asc);
create index if not exists dfc_questions_form_time on public.dfc_questions (form_id, time_seconds asc);

alter table public.dfc_questions enable row level security;
alter table public.dfc_questions force row level security;
revoke all on public.dfc_questions from anon, authenticated;
drop policy if exists "allow service_role dfc_questions" on public.dfc_questions;
create policy "allow service_role dfc_questions" on public.dfc_questions for all to service_role using (true) with check (true);

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

-- 提供後台即時取得 DFC 表單數、題目數與填答紀錄數指標（僅供 service_role 呼叫）
create or replace function public.get_dfc_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  forms_count int;
  questions_count int;
  responses_count int;
  access_count int;
begin
  select count(*) into forms_count from public.dfc_forms;
  select count(*) into questions_count from public.dfc_questions;
  select count(*) into responses_count from public.dfc_responses;
  select count(*) into access_count from public.dfc_access_list;
  return jsonb_build_object(
    'forms_count', coalesce(forms_count, 0),
    'questions_count', coalesce(questions_count, 0),
    'responses_count', coalesce(responses_count, 0),
    'access_count', coalesce(access_count, 0)
  );
end $$;

revoke all on function public.get_dfc_stats() from public, anon, authenticated;
grant execute on function public.get_dfc_stats() to service_role;

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
    {"id": "q2", "time": 4, "stepLabel": "階段一 · 感受 Feel (第2題)", "title": "你認為這個問題對哪一群體的影響最大？", "type": "checkbox", "options": ["全體學生", "導師與行政組長", "家長與校友", "學校訪客"], "desc": "本題為多選題，可複選最關鍵的影響對象。", "required": true},
    {"id": "q3", "time": 10, "stepLabel": "階段二 · 想像 Imagine (第1題)", "title": "針對這個問題，你認為哪些創意解方最值得嘗試？", "type": "checkbox", "options": ["導入互動式影音表單", "建立校園專屬的一句話共創牆", "結合跨班級工作坊快速製作原型"], "desc": "此題為多選題，可勾選一或多項方案。", "required": true},
    {"id": "q4", "time": 10, "stepLabel": "階段二 · 想像 Imagine (第2題)", "title": "你認為以上解方的實施難易度為何？", "type": "dropdown", "options": ["非常容易立即推行", "需要跨處室合作", "需要較多經費與時間"], "desc": "請評估此項解方在校園推行的可行性與難易度。", "required": false},
    {"id": "q5", "time": 18, "stepLabel": "階段三 · 實踐 Do", "title": "請簡述你在本次行動中擔任的角色或預計實踐的項目", "type": "textarea", "options": [], "desc": "限 50 字以內，簡要描述即可。", "required": false},
    {"id": "q6", "time": 22, "stepLabel": "階段四 · 分享 Share (第1題)", "title": "你是否願意將本次成果分享於全校互動成果牆？", "type": "boolean", "options": [], "desc": "請選擇是否願意公開分享。", "required": true},
    {"id": "q7", "time": 22, "stepLabel": "階段四 · 分享 Share (第2題)", "title": "你對本次校園 DFC 方案的整體推薦評分？", "type": "rating", "options": [], "desc": "請給予 1 至 5 星綜合推薦評分（1 星最低，5 星最高）。", "min": 1, "max": 5, "required": true}
  ]'::jsonb
) on conflict (id) do nothing;

-- 預設 DFC 問卷個別題目種子資料（對應 DFC_問卷題目範例.csv 與 DFC_問卷題目範本.csv 全部 7 道題目，儲存至 public.dfc_questions）
insert into public.dfc_questions (
  id, form_id, question_order, time_seconds, step_label, title, type, options, description, required, min_val, max_val, entry_id
) values
  ('q1', 'default-dfc', 1, 4, '階段一 · 感受 Feel (第1題)', '在剛才影片片段中，你觀察到最核心的校園問題是什麼？', 'radio', '["資訊傳遞分散", "空間與動線視覺凌亂", "缺乏即時回饋管道"]'::jsonb, '請選擇一個最貼近你觀察到的現象。', true, 1, 5, 'entry.111111111'),
  ('q2', 'default-dfc', 2, 4, '階段一 · 感受 Feel (第2題)', '你認為這個問題對哪一群體的影響最大？', 'checkbox', '["全體學生", "導師與行政組長", "家長與校友", "學校訪客"]'::jsonb, '本題為多選題，可複選最關鍵的影響對象。', true, 1, 5, 'entry.111111112'),
  ('q3', 'default-dfc', 3, 10, '階段二 · 想像 Imagine (第1題)', '針對這個問題，你認為哪些創意解方最值得嘗試？', 'checkbox', '["導入互動式影音表單", "建立校園專屬的一句話共創牆", "結合跨班級工作坊快速製作原型"]'::jsonb, '此題為多選題，可勾選一或多項方案。', true, 1, 5, 'entry.222222222'),
  ('q4', 'default-dfc', 4, 10, '階段二 · 想像 Imagine (第2題)', '你認為以上解方的實施難易度為何？', 'dropdown', '["非常容易立即推行", "需要跨處室合作", "需要較多經費與時間"]'::jsonb, '請評估此項解方在校園推行的可行性與難易度。', false, 1, 5, 'entry.22222223'),
  ('q5', 'default-dfc', 5, 18, '階段三 · 實踐 Do', '請簡述你在本次行動中擔任的角色或預計實踐的項目', 'textarea', '[]'::jsonb, '限 50 字以內，簡要描述即可。', false, 1, 5, 'entry.333333333'),
  ('q6', 'default-dfc', 6, 22, '階段四 · 分享 Share (第1題)', '你是否願意將本次成果分享於全校互動成果牆？', 'boolean', '[]'::jsonb, '請選擇是否願意公開分享。', true, 1, 5, 'entry.555555555'),
  ('q7', 'default-dfc', 7, 22, '階段四 · 分享 Share (第2題)', '你對本次校園 DFC 方案的整體推薦評分？', 'rating', '[]'::jsonb, '請給予 1 至 5 星綜合推薦評分（1 星最低，5 星最高）。', true, 1, 5, 'entry.666666666')
on conflict (id) do update set
  title = excluded.title,
  step_label = excluded.step_label,
  time_seconds = excluded.time_seconds,
  type = excluded.type,
  options = excluded.options,
  description = excluded.description,
  required = excluded.required,
  min_val = excluded.min_val,
  max_val = excluded.max_val,
  entry_id = excluded.entry_id,
  updated_at = now();
