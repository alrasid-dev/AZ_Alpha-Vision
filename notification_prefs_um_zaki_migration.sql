-- ============================================================
-- AZ Alpha Vision — تفضيلات الإشعارات + أم زكي
-- شغّل مرة واحدة في: Supabase Dashboard → SQL Editor
-- بعد notifications_and_data_schema.sql
-- ============================================================

-- توسيع تفضيلات الإشعارات (فئات + وضع صامت + أم زكي)
alter table public.notification_subscriptions
  add column if not exists portfolio_alerts_enabled boolean not null default true,
  add column if not exists simulator_alerts_enabled boolean not null default true,
  add column if not exists picks_alerts_enabled boolean not null default true,
  add column if not exists screener_alerts_enabled boolean not null default true,
  add column if not exists silent_mode boolean not null default false,
  add column if not exists um_zaki_enabled boolean not null default true,
  add column if not exists price_alerts_enabled boolean not null default true,
  add column if not exists daily_wisdom_enabled boolean not null default true,
  add column if not exists weekly_macro_enabled boolean not null default true;

comment on column public.notification_subscriptions.portfolio_alerts_enabled is 'تنبيهات محفظتي';
comment on column public.notification_subscriptions.simulator_alerts_enabled is 'تنبيهات عمليات المحاكي';
comment on column public.notification_subscriptions.picks_alerts_enabled is 'تنبيهات ترشيحاتي';
comment on column public.notification_subscriptions.screener_alerts_enabled is 'تنبيهات الماسح';
comment on column public.notification_subscriptions.silent_mode is 'وضع صامت: إشعار ملون يظهر بدون صوت/اهتزاز';
comment on column public.notification_subscriptions.um_zaki_enabled is 'تنبيهات أم زكي (طراطيش كلام ثم تحقق)';
comment on column public.notification_subscriptions.daily_wisdom_enabled is 'حكمة يومية عند افتتاح السوق الأمريكي';
comment on column public.notification_subscriptions.weekly_macro_enabled is 'تنبيه ماكرو أسبوعي يوم الاثنين قبل الافتتاح';

-- سجل تحقق أم زكي (تعليمي — لا يخترع حقائق)
create table if not exists public.um_zaki_rumor_events (
  id              uuid primary key default gen_random_uuid(),
  symbol          text not null,
  rumor_summary   text not null,
  buzz_notified_at timestamptz,
  verify_status   text not null default 'pending'
                    check (verify_status in ('pending','verified_true','verified_false','unverified')),
  verify_summary  text,
  verify_notified_at timestamptz,
  source_news_id  uuid,
  source_label    text,
  created_at      timestamptz not null default now()
);

create index if not exists um_zaki_rumor_events_symbol_idx
  on public.um_zaki_rumor_events (symbol, created_at desc);
create index if not exists um_zaki_rumor_events_status_idx
  on public.um_zaki_rumor_events (verify_status, created_at desc);

alter table public.um_zaki_rumor_events enable row level security;
-- الوصول عبر service_role فقط داخل Edge Functions

grant select on public.um_zaki_rumor_events to authenticated, anon;
create policy "um_zaki_rumor_events_read_all"
  on public.um_zaki_rumor_events for select using (true);

-- ============================================================
-- بعد التشغيل انشر الدوال المحدّثة والجديدة (انظر PUSH_NOTIFICATIONS_SETUP_AR.md)
-- ============================================================
