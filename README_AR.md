# AZ Alpha Vision — نظرة عامة على المنصة

منصة ويب تعليمية لمحاكاة الأسواق الأمريكية: شاشة إشارات، بيانات سوق، أخبار/أرباح، إشعارات، ومحاكي تداول افتراضي. **لا يوجد تنفيذ تداول حقيقي** — كل شيء تعليمي ومحاكاة فقط.

## المكوّنات الرئيسية

| المكوّن | الموقع |
|--------|--------|
| واجهة SPA (HTML/JS) | `index.html`, `app.js`, `sw.js`, `us_market_hours.js`, `manifest.json` |
| جالبات Python للبيانات | `fetch_market_data.py`, `fetch_screener_signals.py`, `fetch_company_news.py`, `fetch_earnings_calendar.py` (+ `scripts/`) |
| مخططات Supabase | `supabase_schema.sql`, `market_data_schema.sql`, `screener_schema.sql`, `notifications_and_data_schema.sql`, `virtual_trader_schema.sql` |
| دوال Edge | `supabase/functions/` (إشعارات، محاكي افتراضي، az-ai، …) |
| GitHub Actions | `.github/workflows/` (بيانات السوق، إشارات، أخبار، أرباح، صفحات، APK، محاكي، انتهاء اشتراك) |
| تطبيق أندرويد (Capacitor) | `mobile/` |
| المسوق الموحد لـ X | `az-alpha-marketer-unified/` (نظام فرعي مستقل) |

## ترتيب إعداد قاعدة البيانات (Supabase SQL Editor)

1. `supabase_schema.sql`
2. `market_data_schema.sql`
3. `screener_schema.sql`
4. `notifications_and_data_schema.sql`
5. `virtual_trader_schema.sql` ثم `virtual_trader_trailing_stop_migration.sql` عند الحاجة

تفاصيل الإشعارات وVAPID في `PUSH_NOTIFICATIONS_SETUP_AR.md`. لا تضع مفاتيح سرية داخل المستودع.

## المسوق الموحد (`az-alpha-marketer-unified/`)

توثيق المسوق الكامل موجود **فقط** تحت ذلك المجلد (`az-alpha-marketer-unified/README_AR.md`). لإعداد جدول المنشورات لأول مرة:

1. `az-alpha-marketer-unified/marketing_posts_unified.sql` — إنشاء الجدول
2. `az-alpha-marketer-unified/marketing_posts_education_migration.sql`
3. `az-alpha-marketer-unified/marketing_style_migration.sql`

الإعداد الآمن: `PUBLISH_MODE=draft` (افتراضي في `render.yaml`) حتى تُراجع المسودات في `marketing_posts` قبل التحويل إلى `publish`.

## النشر

- **Vercel / Netlify / GitHub Pages**: ملفات ثابتة من الجذر (`vercel.json`, `netlify.toml`, `.github/workflows/deploy_pages.yml`).
- **Render Cron**: إعداد المسوق عبر `render.yaml` أو `az-alpha-marketer-unified/render.yaml`.
- **أندرويد**: `.github/workflows/build_android_apk.yml` ينسخ واجهة الجذر إلى `mobile/www` ويبني APK.

للتفصيل الأقدم عن ترتيب الرفع والحزم، راجع `README_FINAL_AR.md`.
