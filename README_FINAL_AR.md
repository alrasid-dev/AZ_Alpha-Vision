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

شغّل محتوى `notification_subscriptions.sql` في **Supabase → SQL Editor → New query → Run**.

وظيفة الإرسال مكانها:

```text
supabase/functions/send-signal-notifications/index.ts
```

ولا تضع مفاتيح VAPID الخاصة أو Resend داخل `app.js` أو المستودع.

## ترتيب التشغيل

بعد رفع الملفات، شغّل **Full Market Scan**، وانتظر نجاحه، ثم شغّل **Screener Signals (Confluence Engine)**. بعدها افتح الموقع بتحديث قوي. لتفعيل Push، سجّل الدخول واضغط زر تفعيل إشعار المتصفح. البريد يحتاج إعداد أسرار Supabase ومزود Resend وفق ملف `NOTIFICATIONS_SETUP.md`.

كل النظام تعليمي ومحاكاة فقط ولا ينفذ تداولًا حقيقيًا.
