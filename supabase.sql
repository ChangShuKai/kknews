-- 在 Supabase Dashboard > SQL Editor 執行一次

create table if not exists public.proverbs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  user_email text not null default (auth.jwt() ->> 'email'),
  user_name text,
  content text not null check (char_length(content) between 1 and 100),
  author text not null check (char_length(author) between 1 and 30),
  created_at timestamptz not null default now()
);

alter table public.proverbs enable row level security;

-- 學校帳號才能投稿，且只能以自己身分寫入
create policy "school users insert own" on public.proverbs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (auth.jwt() ->> 'email') like '%@hlc.edu.tw'
  );

-- 使用者可看自己的投稿
create policy "users read own" on public.proverbs
  for select to authenticated
  using (user_id = auth.uid());

-- 管理員可看全部/刪除
create policy "admin read all" on public.proverbs
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@sixstarculture.com');

create policy "admin delete" on public.proverbs
  for delete to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@sixstarculture.com');

-- 後端強制：非 @hlc.edu.tw 帳號(管理員除外)無法註冊(Google 或 Email 皆適用)
create or replace function public.enforce_school_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) not like '%@hlc.edu.tw'
     and lower(new.email) <> 'admin@sixstarculture.com' then
    raise exception 'Only @hlc.edu.tw accounts are allowed';
  end if;
  return new;
end $$;

drop trigger if exists enforce_school_email_trg on auth.users;
create trigger enforce_school_email_trg
  before insert on auth.users
  for each row execute function public.enforce_school_email();

-- 之後請到 Dashboard > Authentication > Users > Add user
-- 建立管理員：admin@sixstarculture.com / sixstarculture.password（勾選 Auto Confirm User）
