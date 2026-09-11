# تفعيل نظام الإشعارات الفورية الخلفية بالكامل (Push Notifications)

هذا الدليل يشرح تفعيل الإشعارات 100%: **تشغيل ملفات SQL** ثم **نشر دوال Supabase Edge Functions** وتشغيل الـ Workflows. الموقع يبقى على `azalphavision.vercel.app`.

## 1) شغّل ملفات SQL مرة واحدة

افتح **Supabase Dashboard → SQL Editor → New query**، ثم Run لكل ملف بالترتيب المناسب:

```text
notifications_and_data_schema.sql
virtual_trader_schema.sql
notification_prefs_um_zaki_migration.sql
```

الملف الجديد `notification_prefs_um_zaki_migration.sql` يضيف:
- مفاتيح التفضيلات: محفظتي / عمليات المحاكي / ترشيحاتي / الماسح / وضع صامت / أم زكي / حكمة يومية / ماكرو أسبوعي
- جدول `um_zaki_rumor_events` لتدفق طراطيش الكلام ثم التحقق التعليمي

## 2) أسرار Edge Functions

من **Supabase Dashboard → Edge Functions → Manage secrets**:

| السر | القيمة |
|---|---|
| `VAPID_PRIVATE_KEY` | المفتاح الخاص المطابق للمفتاح العام في `app.js` |
| `VAPID_SUBJECT` | `mailto:azalphavision2026@gmail.com` |
| `NOTIFY_RUN_KEY` | نص عشوائي طويل (نفس GitHub Secrets) |
| `SUBSCRIPTION_CRON_KEY` | نص عشوائي طويل آخر |

## 3) انشر / أعد نشر الدوال

```bash
supabase link --project-ref <project-ref>
supabase functions deploy send-signal-notifications
supabase functions deploy send-price-alerts
supabase functions deploy send-news-notifications
supabase functions deploy send-earnings-notifications
supabase functions deploy send-admin-broadcast
supabase functions deploy notify-subscription-expiry --no-verify-jwt
supabase functions deploy run-virtual-trader
supabase functions deploy send-daily-wisdom
supabase functions deploy send-weekly-macro
supabase functions deploy send-um-zaki-rumors
```

### قائمة إعادة النشر لهذه الحزمة (مهم)

**محدَّثة:**
1. `send-signal-notifications`
2. `send-price-alerts`
3. `send-news-notifications`
4. `run-virtual-trader`
5. (يُعاد نشر أي دالة تعتمد على `_shared/push.ts` تلقائياً مع الدالة نفسها)

**جديدة:**
6. `send-daily-wisdom`
7. `send-weekly-macro`
8. `send-um-zaki-rumors`

> ملاحظة: تعديلات `_shared/push.ts` و`_shared/usMarketHours.ts` تُضمَّن عند نشر الدوال التي تستوردها.

## 4) GitHub Actions الجديدة

- `daily_wisdom.yml` — حكمة قصيرة عند افتتاح السوق الأمريكي
- `weekly_macro.yml` — ماكرو/فيد/عطل يوم الاثنين قبل الافتتاح (🟢/⚪/🔴)
- `um_zaki_rumors.yml` — أم زكي: طراطيش ثم تحقق

تتطلب نفس الأسرار: `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` و `NOTIFY_RUN_KEY`.

## 5) سلوك المنتج (ملخص)

- **وضع صامت:** الإشعار الملون يظهر على شاشة الهاتف، بدون صوت/اهتزاز (`silent: true` في SW).
- **لوحة الفئات:** محفظتي · عمليات المحاكي · ترشيحاتي · الماسح · وضع صامت · أم زكي.
- **المحاكي:** تنفيذ وتنبيهات فقط في premarket / regular / afterhours؛ مع فلتر الأسهم القابلة للتداول.
- **الترشيحات:** استبعاد المتوقفة/غير القابلة للتداول قدر الإمكان.
- **أم زكي:** لهجة شامية فقط؛ نطاق الرموز = محفظة المستخدم أو المحاكي أو الترشيحات؛ تعليمي بلا اختراع حقائق.
- كل الإشعارات تعليمية — ليست توصية مالية.

## 6) تحقق سريع

1. سجّل الدخول على `https://azalphavision.vercel.app` → فعّل إشعار المتصفح.
2. اضبط لوحة الفئات (جرّب وضع صامت).
3. شغّل Workflow يدوياً من Actions أو استدعِ الدالة بـ curl مع المفاتيح.
4. يجب أن يصل إشعار حتى والتطبيق مغلق؛ في الوضع الصامت بدون صوت.
