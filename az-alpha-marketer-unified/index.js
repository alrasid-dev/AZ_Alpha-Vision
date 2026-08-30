require('dotenv').config();
const { getNextEvent } = require('./lib/events');
const { generateEventPost } = require('./lib/generateEventPost');
const { postTweet } = require('./lib/postToX');

function dayKey(date = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.POSTING_TIMEZONE || 'Asia/Riyadh' }).format(date); }
const FALLBACK_PROMPTS = [
  'اشرح باختصار لماذا لا يكفي مؤشر واحد لاتخاذ قرار تعليمي، وكيف يمكن مقارنة RSI مع الاتجاه والمتوسطات دون تقديم توصية.',
  'اكتب فكرة تعليمية قصيرة عن التنويع: توزيع المخاطر بين قطاعات مختلفة لا يعني ضمان الربح، بل يساعد على فهم أثر التركّز.',
  'عرّف بإدارة المخاطر في المحاكاة الافتراضية: تحديد حجم الصفقة ووقف الحماية قبل الدخول، مع التأكيد أن المثال تعليمي فقط.',
  'اشرح للمبتدئ معنى المتوسط المتحرك وكيف يساعد على قراءة الاتجاه، دون ذكر سهم محدد أو توقع سعر.',
  'عرّف بميزة AZ Alpha Vision: ماسح تعليمي يجمع الفلاتر والقوالب ويعرض سبب الإشارة بدل الاكتفاء بلون أو رقم.',
  'اكتب قصة قصيرة عن متداول افتراضي تعلّم أن الانتظار جزء من الخطة عندما لا يصل السعر إلى منطقة الدخول.',
  'اشرح الفرق بين الخبر المؤثر والضجيج في السوق، ولماذا يجب قراءة المصدر والتاريخ قبل تكوين رأي تعليمي.',
  'اكتب تذكيرًا عربيًا قصيرًا بأن سجل المحاكي الافتراضي وسيلة للتعلم والاختبار، وليس حسابًا ماليًا حقيقيًا.'
];
function fallbackEvent(db) {
  const now = new Date();
  const day = dayKey(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: process.env.POSTING_TIMEZONE || 'Asia/Riyadh', hour:'2-digit', hourCycle:'h23' }).format(now));
  const slot = Math.floor(hour / 2);
  const index = (slot + Number(day.replace(/-/g, ''))) % FALLBACK_PROMPTS.length;
  return { eventKey:`education:${day}:${slot}`, eventType:'education', symbol:null, sourceId:`${day}:${slot}`, sourceUrl:null, payload:{ prompt:FALLBACK_PROMPTS[index] }, db };
}
async function quota(db) {
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const { data: rows, error } = await db.from('marketing_posts').select('created_at,status').eq('status','posted').gte('created_at', new Date(Date.now()-3*86400000).toISOString());
  if (error) throw error;
  const postedToday = (rows || []).filter(r => dayKey(new Date(r.created_at)) === today).length;
  const postedYesterday = (rows || []).filter(r => dayKey(new Date(r.created_at)) === yesterday).length;
  const carry = Math.min(6, Math.max(0, 12 - postedYesterday));
  return { postedToday, limit: 12 + carry, remaining: Math.max(0, 12 + carry - postedToday) };
}
async function run() {
  console.log(`[${new Date().toISOString()}] بدء المشغل الموحد`);
  const db = require('./lib/events').getDb ? require('./lib/events').getDb() : null;
  if (!db) throw new Error('تعذر إنشاء اتصال Supabase');
  const q = await quota(db);
  if (q.remaining <= 0) { console.log(`اكتملت الحصة اليومية: ${q.postedToday}/${q.limit}`); return; }
  const priority = await getNextEvent({ priorityOnly: true });
  let event = priority;
  if (!event) {
    const { data: last } = await db.from('marketing_posts').select('created_at').eq('status','posted').order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (last && Date.now() - new Date(last.created_at).getTime() < 2*60*60*1000) { console.log('لم تمر ساعتان على آخر منشور؛ لا نشر عادي الآن'); return; }
    event = await getNextEvent();
  }
  if (!event) { event = fallbackEvent(db); console.log(`لا يوجد حدث سوقي؛ سيتم إعداد محتوى تعليمي احتياطي ${event.eventKey}`); }
  const text = await generateEventPost(event);
  const campaign = event.eventType === 'earnings' ? 'earnings' : event.eventType === 'news' ? 'news' : event.eventType === 'trade' ? 'simulator' : 'education';
  const registrationUrl = `${process.env.SITE_URL || 'https://azalphavision.com'}/?register=1&utm_source=x&utm_medium=organic&utm_campaign=${campaign}`;
  const fullText = `${text}\n\nتفضل بزيارة المحاكي التعليمي والتسجيل: ${registrationUrl}${event.sourceUrl ? `\nالمصدر: ${event.sourceUrl}` : ''}`;
  const { data: existing } = await event.db.from('marketing_posts').select('id,status,tweet_text').eq('event_key', event.eventKey).maybeSingle();
  let draft = existing;
  if (!draft) {
    const { data: created, error: draftError } = await event.db.from('marketing_posts').insert({ event_key:event.eventKey, event_type:event.eventType, symbol:event.symbol, source_id:event.sourceId, tweet_text:fullText, source_url:event.sourceUrl || null, status:'draft' }).select('id,status,tweet_text').single();
    if (draftError) throw draftError;
    draft = created;
    console.log(`تم إنشاء مسودة ${draft.id}: ${fullText}`);
  } else {
    console.log(`المحتوى موجود مسبقًا ${draft.id} بحالة ${draft.status}؛ لن يتم تكراره`);
  }
  if (String(process.env.PUBLISH_MODE || 'draft').toLowerCase() !== 'publish') { console.log('وضع المعاينة مفعل؛ لم يتم النشر على X'); return; }
  const tweet = await postTweet({ text:fullText, imageBuffer:null });
  const { error } = await event.db.from('marketing_posts').update({ status:'posted', tweet_id:tweet.data.id, posted_at:new Date().toISOString() }).eq('id', draft.id);
  if (error) throw error;
  console.log('تم النشر على X:', tweet.data.id);
}
run().then(()=>process.exit(0)).catch(async err=>{ console.error('فشل المشغل الموحد:', err?.response?.data || err.message || err); process.exit(1); });
