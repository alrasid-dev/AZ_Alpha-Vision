require('dotenv').config();
const { getNextEvent } = require('./lib/events');
const { generateEventPost } = require('./lib/generateEventPost');
const { postTweet } = require('./lib/postToX');

function dayKey(date = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.POSTING_TIMEZONE || 'Asia/Riyadh' }).format(date); }
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
  if (!event) { console.log('لا يوجد حدث جديد للنشر'); return; }
  const text = await generateEventPost(event);
  const campaign = event.eventType === 'earnings' ? 'earnings' : event.eventType === 'news' ? 'news' : event.eventType === 'trade' ? 'simulator' : 'education';
  const registrationUrl = `${process.env.SITE_URL || 'https://azalphavision.com'}/?register=1&utm_source=x&utm_medium=organic&utm_campaign=${campaign}`;
  const fullText = `${text}\n\nتفضل بزيارة المحاكي التعليمي والتسجيل: ${registrationUrl}${event.sourceUrl ? `\nالمصدر: ${event.sourceUrl}` : ''}`;
  const { data: draft, error: draftError } = await event.db.from('marketing_posts').insert({ event_key:event.eventKey, event_type:event.eventType, symbol:event.symbol, source_id:event.sourceId, tweet_text:fullText, source_url:event.sourceUrl || null, status:'draft' }).select('id').single();
  if (draftError) throw draftError;
  console.log(`تم إنشاء مسودة ${draft.id}: ${fullText}`);
  if (String(process.env.PUBLISH_MODE || 'draft').toLowerCase() !== 'publish') { console.log('وضع المعاينة مفعل؛ لم يتم النشر على X'); return; }
  const tweet = await postTweet({ text:fullText, imageBuffer:null });
  const { error } = await event.db.from('marketing_posts').update({ status:'posted', tweet_id:tweet.data.id, posted_at:new Date().toISOString() }).eq('id', draft.id);
  if (error) throw error;
  console.log('تم النشر على X:', tweet.data.id);
}
run().then(()=>process.exit(0)).catch(async err=>{ console.error('فشل المشغل الموحد:', err?.response?.data || err.message || err); process.exit(1); });
