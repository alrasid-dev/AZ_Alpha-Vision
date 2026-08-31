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

شغّل محتوى `supabase_schema.sql` ثم `market_data_schema.sql` ثم `screener_schema.sql` ثم `notifications_and_data_schema.sql` في **Supabase → SQL Editor → New query → Run** (بهذا الترتيب).

دوال الإرسال الست جاهزة بالكامل في:

```text
supabase/functions/send-signal-notifications/index.ts
supabase/functions/send-price-alerts/index.ts
supabase/functions/send-news-notifications/index.ts
supabase/functions/send-earnings-notifications/index.ts
supabase/functions/send-admin-broadcast/index.ts
supabase/functions/notify-subscription-expiry/index.ts
```

خطوات النشر الكاملة وأسرار VAPID/النشر موثقة في `PUSH_NOTIFICATIONS_SETUP_AR.md`. لا تضع مفاتيح VAPID الخاصة داخل `app.js` أو المستودع — فقط في أسرار Supabase.

## ترتيب التشغيل

بعد رفع الملفات، شغّل **Full Market Scan**، وانتظر نجاحه، ثم شغّل **Screener Signals (Confluence Engine)**. بعدها افتح الموقع بتحديث قوي. لتفعيل Push، سجّل الدخول واضغط زر تفعيل إشعار المتصفح، ثم اتبع `PUSH_NOTIFICATIONS_SETUP_AR.md` لتفعيل الإرسال الفعلي من الخادم.

كل النظام تعليمي ومحاكاة فقط ولا ينفذ تداولًا حقيقيًا.
