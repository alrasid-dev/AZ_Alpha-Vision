const axios = require('axios');
const { getRecentTweets } = require('./history');

const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM = `أنت محرر محتوى تشويقي غير مباشر (soft selling) لحساب AZ Alpha Vision على X.
المنصة محاكٍ تعليمي افتراضي لإشارات الأسهم الأمريكية، وليست وسيطاً مالياً.
قواعد صارمة:
- اكتب بالعربية الفصحى المبسطة، نبرة هادئة وإدارية.
- لا توصية شراء أو بيع، لا وعد ربح، لا أرقام مخترعة.
- إن كان الحدث خبراً أو صفقة محاكاة أو موعد أرباح فالتزم بالبيانات المعطاة فقط واذكر أنها تعليمية/افتراضية عند ذكر محاكاة.
- أثِر الفضول حول التعلم والمسح والإشارات دون ضغط بيع.
- لا تضع روابط ولا هاشتاقات؛ النظام يضيفها لاحقاً مع رابط الاشتراك.
- النص قبل الإضافات لا يتجاوز 160 حرفاً.`;

async function generateEventPost(event) {
  const p = event.payload || {};
  let prompt = '';
  if (event.eventType === 'education') prompt = p.prompt;
  else if (event.eventType === 'news') {
    prompt = `خبر مهم للسهم ${event.symbol}: ${p.title}. التصنيف: ${p.category}. الأثر المحتمل: ${p.impact}. المصدر: ${event.sourceUrl || ''}. اكتب تشويقاً تعليمياً يدفع القارئ لفهم الخبر داخل المحاكي لا لاتخاذ قرار مالي.`;
  } else if (event.eventType === 'earnings') {
    const days = Math.ceil((new Date(p.event_date) - Date.now()) / 86400000);
    prompt = `موعد أرباح متوقع للسهم ${event.symbol} بعد نحو ${days} يوماً. اذكر التقويم كمعلومة تعليمية للمتابعة داخل المنصة دون توقع النتيجة.`;
  } else {
    prompt = `حدث محاكاة افتراضي: ${p.action === 'buy' ? 'دخول تعليمي' : 'خروج تعليمي'} للسهم ${event.symbol}، الكمية ${p.qty}، السعر ${p.price}، السبب ${p.reason || 'إشارة مؤهلة'}. أكّد أنه محاكٍ وليس توصية.`;
  }

  const recent = await getRecentTweets(event.db, 6);
  const recentBlock = recent.length ? `\nتجنب تكرار هذه الصياغات:\n${recent.slice(0, 6).join('\n')}` : '';

  const res = await axios.post(
    `${URL}?key=${process.env.GEMINI_API_KEY}`,
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ parts: [{ text: `${prompt}${recentBlock}` }] }],
      generationConfig: { temperature: 0.45, maxOutputTokens: 220 },
    },
    { timeout: 30000 }
  );
  let text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('لم يعط Gemini نصاً');
  text = text.replace(/^['"«»]+|['"«»]+$/g, '').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

module.exports = { generateEventPost };
