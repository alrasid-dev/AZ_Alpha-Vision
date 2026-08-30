const axios = require('axios');
const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const SYSTEM = `أنت محرر حساب AZ Alpha Vision. اكتب منشور X عربيًا مختصرًا. إذا كان الحدث تعليميًا أو تسويقيًا، اشرح مفهومًا مثل مؤشر RSI أو المتوسطات أو إدارة المخاطر أو التنويع، أو عرّف بميزة في المنصة. إذا كان الحدث خبرًا أو صفقة محاكاة، التزم بالبيانات المعطاة فقط. اذكر أن المحاكي افتراضي وتعليمي، ولا تقدم توصية شراء أو بيع أو وعدًا بالربح. لا تخترع أرقامًا أو أخبارًا. اكتب نصًا قصيرًا لا يتجاوز 150 حرفًا قبل أن يضيف النظام رابط التسجيل والمصدر. لا تضع روابط أو هاشتاقات بنفسك. لا تستخدم لغة جازمة عن اتجاه السعر.`;
async function generateEventPost(event) {
  const p = event.payload;
  let prompt = '';
  if (event.eventType === 'education') prompt = p.prompt; else if (event.eventType === 'news') prompt = `خبر مهم للسهم ${event.symbol}: ${p.title}. التصنيف: ${p.category}. الأثر المحتمل: ${p.impact}. المصدر: ${event.sourceUrl || ''}`;
  else if (event.eventType === 'earnings') { const days = Math.ceil((new Date(p.event_date)-Date.now())/86400000); prompt = `موعد أرباح متوقع للسهم ${event.symbol} بعد ${days} أيام تقريبًا. المصدر: ${event.sourceUrl || ''}`; }
  else prompt = `إنجاز في المحاكي الافتراضي: ${p.action === 'buy' ? 'دخول' : 'خروج'} للسهم ${event.symbol}، الكمية ${p.qty}، السعر ${p.price}، السبب ${p.reason || 'إشارة مؤهلة'}.`;
  const res = await axios.post(`${URL}?key=${process.env.GEMINI_API_KEY}`, { systemInstruction:{parts:[{text:SYSTEM}]}, contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.35,maxOutputTokens:180} }, {timeout:30000});
  let text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('لم يعط Gemini نصًا');
  text = text.replace(/^['"«»]+|['"«»]+$/g,'').trim();
  return text.length > 260 ? `${text.slice(0,257)}...` : text;
}
module.exports = { generateEventPost };
