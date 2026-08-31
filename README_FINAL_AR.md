# الحزمة النهائية — AZ Alpha Vision

هذه الحزمة مرتبة لتقليل الالتباس. ارفع الملفات الموجودة في قسم **جذر GitHub** إلى جذر المستودع، وملفات workflow إلى مجلد `.github/workflows`، وملف محرك الإشارات إلى `scripts`. ملف SQL يُشغّل داخل Supabase ولا يكفي رفعه إلى GitHub.

## جذر GitHub

```text
app.js
index.html
sw.js
manifest.json
icon.svg
fetch_market_data.py
```

## مجلد GitHub Actions

```text
.github/workflows/market_data_full.yml
.github/workflows/screener_signals.yml
```

لا تستبدل `market_data_live.yml` إذا لم تكن هناك نسخة محدثة منه.

## مجلد السكربتات

```text
scripts/fetch_screener_signals.py
```

## Supabase

شغّل محتوى `supabase_schema.sql` ثم `market_data_schema.sql` ثم `screener_schema.sql` ثم `notifications_and_data_schema.sql` ثم `virtual_trader_schema.sql` في **Supabase → SQL Editor → New query → Run** (بهذا الترتيب).

دوال الإرسال الست جاهزة بالكامل في:

```text
supabase/functions/send-signal-notifications/index.ts
supabase/functions/send-price-alerts/index.ts
supabase/functions/send-news-notifications/index.ts
supabase/functions/send-earnings-notifications/index.ts
supabase/functions/send-admin-broadcast/index.ts
supabase/functions/notify-subscription-expiry/index.ts
```

ومحرك المحاكي المالي الحقيقي (شراء/بيع تلقائي مربوط بإشارات الدخول/الخروج) في:

```text
supabase/functions/run-virtual-trader/index.ts
```

هذه الدالة يستدعيها `.github/workflows/virtual_trader.yml` تلقائيًا كل 15 دقيقة أيام العمل، وتحتاج نفس أسرار `NOTIFY_RUN_KEY` و`SUPABASE_SERVICE_ROLE_KEY` الموثقة في `PUSH_NOTIFICATIONS_SETUP_AR.md`. بعد نشرها، ستراقب إشارات `screener_signals` لحظيًا: دخول قوي (صريح/مؤكد) ← شراء تلقائي فوري ضمن حدود إدارة مخاطر آلية (حد أقصى 8 مراكز، 20% من السيولة لكل مركز)، وخروج حقيقي (وقف خسارة −8%، جني أرباح +20%، أو انعكاس فني RSI/SMA50) ← بيع تلقائي فوري مع تحديث المحفظة والربح/الخسارة لحظيًا.

خطوات النشر الكاملة وأسرار VAPID/النشر موثقة في `PUSH_NOTIFICATIONS_SETUP_AR.md`. لا تضع مفاتيح VAPID الخاصة داخل `app.js` أو المستودع — فقط في أسرار Supabase.

## ترتيب التشغيل

بعد رفع الملفات، شغّل **Full Market Scan**، وانتظر نجاحه، ثم شغّل **Screener Signals (Confluence Engine)**. بعدها افتح الموقع بتحديث قوي. لتفعيل Push، سجّل الدخول واضغط زر تفعيل إشعار المتصفح، ثم اتبع `PUSH_NOTIFICATIONS_SETUP_AR.md` لتفعيل الإرسال الفعلي من الخادم.

كل النظام تعليمي ومحاكاة فقط ولا ينفذ تداولًا حقيقيًا.

## النشر على Vercel

الموقع ملفات ثابتة بالكامل (HTML/JS بدون خطوة بناء)، لذلك `vercel.json` في الجذر لا يحدد `buildCommand` ولا `installCommand` عمداً — يعتمد بالكامل على السلوك الافتراضي لـ Vercel (`framework: null`, `outputDirectory: "."`). إذا ظهر أي خطأ نشر قديم عالق في لوحة Vercel، افتح تبويب **Deployments** وتأكد أن آخر عملية نشر مرتبطة برقم Commit الأحدث في هذا المستودع، أو اضغط **Redeploy** يدويًا على آخر Commit من هناك.
