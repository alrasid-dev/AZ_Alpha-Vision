const axios = require('axios');
const { getRecentTweets } = require('./history');

const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const BASE_RULES = `أنت محرر محتوى لحساب AZ Alpha Vision على X.
المنصة محاكٍ تعليمي افتراضي لإشارات الأسهم الأمريكية ولوحة إدارية ذكية، وليست وسيطاً مالياً.
قواعد صارمة على كل الأساليب:
- اكتب بالعربية الفصحى المبسطة.
- لا توصية شراء أو بيع، لا وعد ربح، لا أرقام مخترعة.
- إن كان الحدث خبراً أو صفقة محاكاة أو موعد أرباح فالتزم بالبيانات المعطاة فقط واذكر أنها تعليمية/افتراضية عند ذكر محاكاة.
- لا تضع روابط ولا هاشتاقات؛ النظام يضيفها لاحقاً مع رابط الاشتراك.`;

const STYLE_PROMPTS = {
  soft_sell: `${BASE_RULES}
الأسلوب: تسويق غير مباشر (Soft Selling) — نبرة هادئة وإدارية، أثِر الفضول حول التعلم والمسح والإشارات دون ضغط بيع.
النص لا يتجاوز 160 حرفاً.`,
  meme_trend: `${BASE_RULES}
الأسلوب: تفاعل ذكي مع الأخبار العاجلة/التريندات (خفيف الظل وجذّاب لكنه محترم ومؤسسي، بلا سخرية مسيئة) — استخدم إيموجي واحداً أو اثنين بحكمة، واربط الخبر بفكرة تعليمية بسيطة عن السوق أو الإدارة تشجّع على المتابعة.
النص لا يتجاوز 180 حرفاً.`,
};

const THREAD_SYSTEM = `${BASE_RULES}
الأسلوب: ثريد تقني/تعليمي مكوّن من 3 تغريدات متتابعة (Thread).
أعد الناتج بصيغة JSON فقط دون أي نص خارجها، على الشكل:
{"parts": ["التغريدة الأولى (خطّافة قصيرة تلفت الانتباه)", "التغريدة الثانية (شرح الفكرة التعليمية بعمق أكبر)", "التغريدة الثالثة (خلاصة أو سؤال تفاعلي)"]}
كل تغريدة لا تتجاوز 220 حرفاً ولا تحتوي روابط أو هاشتاقات.`;

function buildPrompt(event) {
  const p = event.payload || {};
  if (event.eventType === 'education') return p.prompt;
  if (event.eventType === 'trend_news') {
    return `خبر ترند في مجال الأسواق/الإدارة: "${p.title}". المصدر: ${p.link || ''}. اربط هذا الخبر بفكرة تعليمية قصيرة تخص قراءة الأسواق أو الإدارة الذكية دون اتخاذ قرار مالي.`;
  }
  if (event.eventType === 'news') {
    return `خبر مهم للسهم ${event.symbol}: ${p.title}. التصنيف: ${p.category}. الأثر المحتمل: ${p.impact}. المصدر: ${event.sourceUrl || ''}. اكتب محتوى يدفع القارئ لفهم الخبر داخل المحاكي لا لاتخاذ قرار مالي.`;
  }
  if (event.eventType === 'earnings') {
    const days = Math.ceil((new Date(p.event_date) - Date.now()) / 86400000);
    return `موعد أرباح متوقع للسهم ${event.symbol} بعد نحو ${days} يوماً. اذكر التقويم كمعلومة تعليمية للمتابعة داخل المنصة دون توقع النتيجة.`;
  }
  return `حدث محاكاة افتراضي: ${p.action === 'buy' ? 'دخول تعليمي' : 'خروج تعليمي'} للسهم ${event.symbol}، الكمية ${p.qty}، السعر ${p.price}، السبب ${p.reason || 'إشارة مؤهلة'}. أكّد أنه محاكٍ وليس توصية.`;
}

async function callGemini({ system, prompt, temperature, maxOutputTokens }) {
  const res = await axios.post(
    `${URL}?key=${process.env.GEMINI_API_KEY}`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens },
    },
    { timeout: 30000 }
  );
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('لم يعط Gemini نصاً');
  return text;
}

function cleanText(text, maxLen) {
  const cleaned = text.replace(/^['"«»]+|['"«»]+$/g, '').trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3)}...` : cleaned;
}

/**
 * يولّد منشوراً بأسلوب واحد من ثلاثة: soft_sell (نص واحد)، meme_trend (نص واحد بنبرة تفاعلية)،
 * أو thread (مصفوفة من 3 تغريدات متتابعة). يعيد { kind: 'single'|'thread', text|parts }.
 */
async function generateEventPost(event, style = 'soft_sell') {
  const basePrompt = buildPrompt(event);
  const recent = await getRecentTweets(event.db, 6);
  const recentBlock = recent.length ? `\nتجنب تكرار هذه الصياغات:\n${recent.slice(0, 6).join('\n')}` : '';

  if (style === 'thread') {
    const raw = await callGemini({
      system: THREAD_SYSTEM,
      prompt: `${basePrompt}${recentBlock}`,
      temperature: 0.5,
      maxOutputTokens: 500,
    });
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (e) {
      parsed = null;
    }
    const parts = Array.isArray(parsed?.parts) ? parsed.parts.filter(Boolean) : null;
    if (!parts || parts.length < 2) {
      // فشل تنسيق JSON: نرجع لأسلوب النص الواحد كحل آمن
      const fallback = await callGemini({
        system: STYLE_PROMPTS.soft_sell,
        prompt: `${basePrompt}${recentBlock}`,
        temperature: 0.45,
        maxOutputTokens: 220,
      });
      return { kind: 'single', text: cleanText(fallback, 160) };
    }
    return { kind: 'thread', parts: parts.slice(0, 4).map((p) => cleanText(p, 220)) };
  }

  const system = STYLE_PROMPTS[style] || STYLE_PROMPTS.soft_sell;
  const maxLen = style === 'meme_trend' ? 180 : 160;
  const text = await callGemini({ system, prompt: `${basePrompt}${recentBlock}`, temperature: 0.5, maxOutputTokens: 240 });
  return { kind: 'single', text: cleanText(text, maxLen) };
}

module.exports = { generateEventPost };
