-- ============================================================
-- AZ Alpha Vision — الجداول المفقودة لتفعيل الإشعارات الفورية
-- والبث الإداري وجدولي الأخبار/الأرباح بشكل كامل 100%.
-- شغّل هذا الملف مرة واحدة في: Supabase Dashboard → SQL Editor
-- بعد supabase_schema.sql و market_data_schema.sql و screener_schema.sql
-- ============================================================

-- ----------------------------------------------------------------
-- 1) أجهزة اشتراك Push (Web Push) — يكتبها app.js عبر savePushDevice()
-- ----------------------------------------------------------------
create table if not exists public.notification_push_devices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  endpoint          text not null unique,
  push_subscription jsonb not null,
  push_enabled      boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.notification_push_devices enable row level security;

create policy "push_devices_owner_all"
  on public.notification_push_devices for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.notification_push_devices to authenticated;

-- ----------------------------------------------------------------
-- 2) تفضيلات إشعارات البريد الإلكتروني — يكتبها saveEmailAlerts()
-- ----------------------------------------------------------------
create table if not exists public.notification_subscriptions (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  email         text,
  email_enabled boolean not null default false,
  updated_at    timestamptz not null default now()
);

alter table public.notification_subscriptions enable row level security;

create policy "notification_subscriptions_owner_all"
  on public.notification_subscriptions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.notification_subscriptions to authenticated;

-- ----------------------------------------------------------------
-- 3) سجل إرسال الإشعارات (لمنع التكرار بين كل تشغيل Cron)
-- ----------------------------------------------------------------
create table if not exists public.push_notification_log (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,          -- signal / price_alert / news / earnings / trial_expiry / admin_broadcast
  ref_id      text not null,          -- symbol / preset|symbol / news.id / user_id حسب النوع
  sent_at     timestamptz not null default now()
);
create index if not exists push_notification_log_kind_ref_idx
  on public.push_notification_log (kind, ref_id, sent_at desc);

alter table public.push_notification_log enable row level security;
-- لا صلاحية قراءة أو كتابة من العميل؛ الوصول فقط عبر service_role داخل Edge Functions.

-- ----------------------------------------------------------------
-- 4) بث الإدارة (النحلة النشطة / الإعلانات) — تكتبه لوحة الأدمن
-- ----------------------------------------------------------------
create table if not exists public.admin_broadcasts (
  id             uuid primary key default gen_random_uuid(),
  created_by     uuid references public.profiles(id),
  title          text not null,
  body           text not null,
  image_url      text,
  audience_type  text not null default 'all' check (audience_type in ('all','user')),
  target_user_id uuid references public.profiles(id),
  popup_enabled  boolean not null default true,
  push_enabled   boolean not null default false,
  email_enabled  boolean not null default false,
  status         text not null default 'published' check (status in ('draft','published','archived')),
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz,
  published_at   timestamptz default now(),
  created_at     timestamptz not null default now()
);

alter table public.admin_broadcasts enable row level security;

create policy "admin_broadcasts_read_targeted"
  on public.admin_broadcasts for select
  using (
    status = 'published'
    and (audience_type = 'all' or target_user_id = auth.uid() or public.is_admin())
  );

create policy "admin_broadcasts_admin_write"
  on public.admin_broadcasts for insert
  with check (public.is_admin());

create policy "admin_broadcasts_admin_update"
  on public.admin_broadcasts for update
  using (public.is_admin());

grant select, insert, update on public.admin_broadcasts to authenticated;

insert into storage.buckets (id, name, public)
values ('broadcast-media', 'broadcast-media', true)
on conflict (id) do nothing;

create policy "broadcast_media_admin_upload"
  on storage.objects for insert
  with check (bucket_id = 'broadcast-media' and public.is_admin());

create policy "broadcast_media_public_read"
  on storage.objects for select
  using (bucket_id = 'broadcast-media');

-- ----------------------------------------------------------------
-- 5) أخبار الشركات المادية — يكتبها fetch_company_news.py
-- ----------------------------------------------------------------
create table if not exists public.company_news (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null,
  company_name  text,
  title         text not null,
  summary       text,
  source_name   text,
  source_url    text not null unique,
  category      text,
  impact        text,
  impact_reason text,
  is_material   boolean not null default false,
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

alter table public.company_news enable row level security;
create policy "company_news_read_all" on public.company_news for select using (true);
grant select on public.company_news to authenticated, anon;

-- ----------------------------------------------------------------
-- 6) تقويم الأرباح — يكتبه fetch_earnings_calendar.py
-- ----------------------------------------------------------------
create table if not exists public.earnings_events (
  id                    uuid primary key default gen_random_uuid(),
  symbol                text not null,
  company_name          text,
  event_date            date not null,
  event_type            text not null default 'earnings',
  source_name           text,
  source_url            text,
  tracking_sources      jsonb,
  analyst_eps_avg       numeric,
  analyst_eps_low       numeric,
  analyst_eps_high      numeric,
  analyst_count         int,
  estimate_period       text,
  estimates_fetched_at  timestamptz,
  created_at            timestamptz not null default now(),
  unique (symbol, event_type, event_date)
);

alter table public.earnings_events enable row level security;
create policy "earnings_events_read_all" on public.earnings_events for select using (true);
grant select on public.earnings_events to authenticated, anon;

-- ============================================================
-- Done. بعد التشغيل: أضف أسرار Edge Functions التالية من
-- Supabase Dashboard → Edge Functions → Secrets:
--   VAPID_PRIVATE_KEY      (يقابل المفتاح العام المضمّن في app.js)
--   VAPID_SUBJECT           mailto:azalphavision2026@gmail.com
--   NOTIFY_RUN_KEY           أي نص عشوائي طويل — نفس القيمة في GitHub Secrets
--   SUBSCRIPTION_CRON_KEY    أي نص عشوائي طويل — نفس القيمة في GitHub Secrets
-- ثم انشر الدوال الجديدة تحت supabase/functions/ عبر:
--   supabase functions deploy send-signal-notifications
--   supabase functions deploy send-price-alerts
--   supabase functions deploy send-news-notifications
--   supabase functions deploy send-earnings-notifications
--   supabase functions deploy send-admin-broadcast
--   supabase functions deploy notify-subscription-expiry --no-verify-jwt
-- ============================================================
