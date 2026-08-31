-- ============================================================
-- ترقية اختيارية: إضافة عمود peak_price لدعم وقف الخسارة المتحرك (Trailing Stop 7%)
-- بعد تحقيق ربح 20% في المحاكي الافتراضي.
-- شغّل هذا الملف مرة واحدة إذا كانت جداول المحاكي منشأة مسبقاً عبر virtual_trader_schema.sql
-- قبل إضافة هذه الميزة. إن كان الجدول جديداً بالكامل فـ virtual_trader_schema.sql المحدّث كافٍ.
-- ============================================================

alter table public.shared_virtual_positions
  add column if not exists peak_price numeric;

-- تهيئة القيمة الابتدائية للمراكز المفتوحة حالياً بأعلى سعر معروف لها حتى الآن.
update public.shared_virtual_positions
set peak_price = greatest(coalesce(last_price, entry_price), entry_price)
where peak_price is null;
