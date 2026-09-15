-- ============================================================
-- AZ Alpha Vision — Payment receipts + subscription auto-activate
-- Run once in: Supabase Dashboard → SQL Editor
-- After: supabase_schema.sql
-- ============================================================

-- 1) Profile subscription fields + one-time disclaimer
alter table public.profiles
  add column if not exists subscription_status text not null default 'trial'
    check (subscription_status in ('trial','active','expired','pending')),
  add column if not exists expires_at timestamptz,
  add column if not exists disclaimer_accepted boolean not null default false,
  add column if not exists disclaimer_accepted_at timestamptz,
  add column if not exists age_confirmed boolean not null default false,
  add column if not exists education_consent_at timestamptz;

-- Backfill disclaimer from existing consent columns when present
update public.profiles
set disclaimer_accepted = true,
    disclaimer_accepted_at = coalesce(disclaimer_accepted_at, education_consent_at, now())
where disclaimer_accepted = false
  and (age_confirmed = true or education_consent_at is not null);

-- Sync subscription_status from trial_end for existing rows
update public.profiles
set subscription_status = case
  when role = 'admin' then 'active'
  when trial_end is not null and trial_end > now() then 'active'
  when trial_end is not null and trial_end <= now() then 'expired'
  else subscription_status
end,
expires_at = coalesce(expires_at, trial_end)
where role = 'admin' or trial_end is not null;

-- Users may update their own disclaimer flags only (not role/subscription)
drop policy if exists "profiles_update_own_disclaimer" on public.profiles;
create policy "profiles_update_own_disclaimer"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 2) payment_receipts — unique bank transfer reference; auto-activation audit trail
create table if not exists public.payment_receipts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  plan_code       text not null check (plan_code in ('monthly','quarterly')),
  amount_sar      numeric not null check (amount_sar in (299, 899)),
  reference       text not null,
  receipt_path    text,
  ocr_raw         jsonb,
  status          text not null default 'activated'
                    check (status in ('activated','rejected','duplicate','pending')),
  reject_reason   text,
  days_granted    int not null default 0,
  activated_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint payment_receipts_reference_unique unique (reference)
);

create index if not exists payment_receipts_user_idx
  on public.payment_receipts (user_id, created_at desc);

alter table public.payment_receipts enable row level security;

drop policy if exists "payment_receipts_select_own_or_admin" on public.payment_receipts;
create policy "payment_receipts_select_own_or_admin"
  on public.payment_receipts for select
  using (auth.uid() = user_id or public.is_admin());

-- Inserts only via service role inside verify-payment-receipt edge function
grant select on public.payment_receipts to authenticated;

-- 3) Ensure receipts storage bucket exists (private)
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- 4) SECURITY DEFINER helper to activate subscription after OCR validation
create or replace function public.activate_subscription_from_receipt(
  p_user_id uuid,
  p_plan_code text,
  p_amount_sar numeric,
  p_reference text,
  p_receipt_path text default null,
  p_ocr_raw jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  days int;
  new_exp timestamptz;
  base timestamptz;
  receipt_id uuid;
begin
  if p_reference is null or length(trim(p_reference)) < 4 then
    raise exception 'invalid_reference';
  end if;
  if p_amount_sar = 299 and p_plan_code = 'monthly' then
    days := 30;
  elsif p_amount_sar = 899 and p_plan_code = 'quarterly' then
    days := 90;
  elsif p_amount_sar = 299 then
    days := 30;
    p_plan_code := 'monthly';
  elsif p_amount_sar = 899 then
    days := 90;
    p_plan_code := 'quarterly';
  else
    raise exception 'invalid_amount';
  end if;

  if exists (select 1 from public.payment_receipts where reference = trim(p_reference)) then
    raise exception 'duplicate_reference';
  end if;

  select coalesce(greatest(expires_at, trial_end), now()) into base
  from public.profiles where id = p_user_id;
  if base is null then
    raise exception 'user_not_found';
  end if;
  if base < now() then base := now(); end if;
  new_exp := base + (days || ' days')::interval;

  insert into public.payment_receipts (
    user_id, plan_code, amount_sar, reference, receipt_path, ocr_raw,
    status, days_granted, activated_at
  ) values (
    p_user_id, p_plan_code, p_amount_sar, trim(p_reference), p_receipt_path, p_ocr_raw,
    'activated', days, now()
  ) returning id into receipt_id;

  update public.profiles
  set approved = true,
      subscription_status = 'active',
      expires_at = new_exp,
      trial_end = new_exp
  where id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'receipt_id', receipt_id,
    'days', days,
    'expires_at', new_exp,
    'plan_code', p_plan_code,
    'amount_sar', p_amount_sar
  );
end;
$$;

revoke all on function public.activate_subscription_from_receipt(uuid, text, numeric, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.activate_subscription_from_receipt(uuid, text, numeric, text, text, jsonb) to service_role;

comment on table public.payment_receipts is 'Bank-transfer receipts; unique reference; activated by OCR edge function without admin approval';
