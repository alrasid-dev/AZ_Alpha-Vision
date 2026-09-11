-- ============================================================
-- AZ Alpha Vision — جدول المسوق الموحد (marketing_posts)
-- شغّل مرة واحدة في: Supabase → SQL Editor
-- بعد جداول company_news و earnings_events (notifications_and_data_schema.sql).
-- بعدها شغّل بالترتيب:
--   1) marketing_posts_education_migration.sql
--   2) marketing_style_migration.sql
-- الأعمدة مطابقة لما يقرأه/يكتبه az-alpha-marketer-unified/index.js
-- (الكتابة عبر service_role فقط؛ لا صلاحيات عميل).
-- ============================================================

create table if not exists public.marketing_posts (
  id           uuid primary key default gen_random_uuid(),
  event_key    text not null,
  event_type   text not null
                 check (event_type in ('trade','news','earnings','milestone')),
  symbol       text,
  source_id    text,
  tweet_text   text not null,
  source_url   text,
  status       text not null default 'draft'
                 check (status in ('draft','posted')),
  tweet_id     text,
  posted_at    timestamptz,
  created_at   timestamptz not null default now()
);

-- يمنع تكرار نفس الحدث (صفقة / خبر / أرباح / …)
create unique index if not exists marketing_posts_event_key_uidx
  on public.marketing_posts (event_key);

-- استعلامات الحصة وآخر منشور حسب الحالة والتاريخ
create index if not exists marketing_posts_status_created_idx
  on public.marketing_posts (status, created_at desc);

alter table public.marketing_posts enable row level security;
-- لا سياسات قراءة/كتابة للعميل (anon/authenticated).
-- المشغل الموحد يستخدم SUPABASE_SERVICE_ROLE_KEY ويتجاوز RLS.

notify pgrst, 'reload schema';
