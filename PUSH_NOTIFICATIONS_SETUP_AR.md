# تفعيل نظام الإشعارات الفورية الخلفية بالكامل (Push Notifications)

هذا الدليل يشرح الخطوة الوحيدة المتبقية لتفعيل الإشعارات 100%: **نشر 6 دوال Supabase Edge Functions** التي تمت برمجتها بالكامل في `supabase/functions/`، ثم تشغيل ملف SQL واحد. كل شيء آخر (الاشتراك من المتصفح، Service Worker، الأزرار) جاهز وشغّال فعلياً من قبل.

## 1) شغّل ملف SQL مرة واحدة

افتح **Supabase Dashboard → SQL Editor → New query**، الصق محتوى:

```text
notifications_and_data_schema.sql
```

ثم اضغط Run. هذا ينشئ الجداول المفقودة: `notification_push_devices`, `notification_subscriptions`, `admin_broadcasts` (+ Storage bucket), `company_news`, `earnings_events`, `push_notification_log`.

## 2) أضف أسرار Edge Functions (مرة واحدة)

من **Supabase Dashboard → Edge Functions → Manage secrets**:

| السر | القيمة |
|---|---|
| `VAPID_PRIVATE_KEY` | المفتاح الخاص المطابق لمفتاح `WEB_PUSH_PUBLIC_KEY` في `app.js` (شغّل `node generate_vapid_keys.js` إذا لم يكن محفوظاً لديك، وحدّث المفتاح العام في `app.js` بالمقابل) |
| `VAPID_SUBJECT` | `mailto:azalphavision2026@gmail.com` |
| `NOTIFY_RUN_KEY` | نص عشوائي طويل (نفس القيمة المضافة في GitHub Secrets) |
| `SUBSCRIPTION_CRON_KEY` | نص عشوائي طويل آخر (نفس القيمة المضافة في GitHub Secrets) |

وفي **GitHub → Settings → Secrets and variables → Actions** أضف نفس قيمتَي `NOTIFY_RUN_KEY` و `SUBSCRIPTION_CRON_KEY` (تُستخدم في ملفات `.github/workflows/*.yml` الموجودة مسبقاً).

## 3) انشر الدوال الست عبر Supabase CLI

```bash
supabase link --project-ref <project-ref-الخاص-بك>
supabase functions deploy send-signal-notifications
supabase functions deploy send-price-alerts
supabase functions deploy send-news-notifications
supabase functions deploy send-earnings-notifications
supabase functions deploy send-admin-broadcast
supabase functions deploy notify-subscription-expiry --no-verify-jwt
```

الدالة الأخيرة فقط تحتاج `--no-verify-jwt` لأن GitHub يستدعيها بمفتاح `x-cron-key` مباشرة بدون توكن جلسة.

## 4) تحقق من العمل

- شغّل أي Workflow يدوياً من تبويب **Actions** في GitHub (مثلاً "AZ Alpha Vision - Ready Filter Templates") وتأكد أن خطوة "Send signal notifications" تنجح (HTTP 200).
- من المنصة: سجّل الدخول → فعّل "إشعارات المتصفح" من الأعلى → أغلق المتصفح تماماً → انتظر تشغيل أي Workflow (أو شغّله يدوياً) → يجب أن يصلك إشعار حتى والتطبيق مغلق بالكامل.

## ما الذي يعمل الآن بدون أي خطوة إضافية؟

- تسجيل جهاز المستخدم (`savePushDevice`) والاشتراك عبر Service Worker: **يعمل فعلياً 100%**.
- استقبال وعرض الإشعارات في الخلفية حتى مع إغلاق التطبيق (`sw.js` → `push` + `notificationclick`): **يعمل فعلياً 100%**.
- إرسال الإشعارات من الخادم (الماسح المالي، تحركات الأسعار، الأخبار، الأرباح، انتهاء الاشتراك، بث الأدمن): **الكود جاهز بالكامل**، وينتظر فقط تنفيذ الخطوات 1-3 أعلاه (مجانية 100% ولا تحتاج أي بطاقة دفع).

كل الجداول والدوال تستخدم `service_role` فقط للكتابة، ولا صلاحية كتابة مباشرة من المتصفح — بنفس منهج الأمان المتبع في بقية المشروع.
