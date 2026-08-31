-- AZ Alpha Vision — ترقية المسوق الذكي: أساليب نشر متعددة + مصدر أخبار RSS خارجي
-- شغّلها مرة واحدة في محرر SQL بمشروع Supabase (اختياري: النظام يعمل حتى بدون تشغيلها،
-- لكن تشغيلها يتيح تتبع أسلوب آخر منشور بدقة أعلى في التدوير).
alter table if exists public.marketing_posts
add column if not exists content_style text;

alter table if exists public.marketing_posts
drop constraint if exists marketing_posts_event_type_check;

alter table if exists public.marketing_posts
add constraint marketing_posts_event_type_check
check (event_type in ('trade','news','earnings','milestone','education','trend_news'));

notify pgrst, 'reload schema';

-- trend_news: عناوين مجمّعة من خلاصات RSS عامة ومجانية (أسواق/إدارة/أعمال)، تُعاد صياغتها
-- بأسلوب المنصة قبل النشر — لا نشر حرفي لأي مصدر خارجي.
