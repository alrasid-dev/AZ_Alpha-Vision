-- AZ Alpha Vision — allow safe educational fallback posts
-- Run once in Supabase SQL Editor.
alter table if exists public.marketing_posts
drop constraint if exists marketing_posts_event_type_check;

alter table if exists public.marketing_posts
add constraint marketing_posts_event_type_check
check (event_type in ('trade','news','earnings','milestone','education'));

notify pgrst, 'reload schema';

-- Educational only: no broker, no real-money execution.
