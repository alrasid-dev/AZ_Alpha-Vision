# تفعيل المساعد السحابي "النحلة النشطة" (az-ai)

الواجهة تعمل فوراً بمعرفة محلية داخل المتصفح حتى بدون هذا الملف (`azBeeLocalAnswer` في `app.js`). هذه الخطوة فقط تُضيف طبقة ذكاء سحابي أعمق عبر Gemini المجاني. لا يمكن لأي مساعد تلقائي تنفيذها بدل حساب Supabase الخاص بك لأنها تحتاج تسجيل دخولك الشخصي.

## خطوات التفعيل (مرة واحدة فقط، 5 دقائق)

1. ثبّت أداة Supabase (إن لم تكن مثبتة):

   ```bash
   npm install -g supabase
   ```

2. سجّل الدخول وربط المشروع:

   ```bash
   supabase login
   supabase link --project-ref riktmjqbixqlqwqwqoyc
   ```

3. أضف مفتاح Gemini المجاني (من https://aistudio.google.com/app/apikey) كسرّ:

   ```bash
   supabase secrets set GEMINI_API_KEY=ضع_المفتاح_هنا
   ```

4. نشر الدالة:

   ```bash
   supabase functions deploy az-ai --no-verify-jwt
   ```

بعد هذه الخطوة تتحول إجابات "النحلة النشطة" من إجابة محلية سريعة إلى إجابة محلية فورية + توسّع سحابي ذكي تلقائياً، دون أي تعديل إضافي على الكود.
