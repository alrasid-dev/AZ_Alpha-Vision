const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { fetchTrendingHeadlines } = require('./rssFeeds');

function getDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY مطلوبان');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function used(data) {
  return data && data.id;
}

async function unused(db, eventKey) {
  const { data } = await db.from('marketing_posts').select('id,status').eq('event_key', eventKey).maybeSingle();
  return used(data) ? null : true;
}

async function getNextEvent({ priorityOnly = false } = {}) {
  const db = getDb();
  const now = new Date();
  const [newsRes, tradesRes, earningsRes, tasksRes] = await Promise.all([
    db.from('company_news').select('id,symbol,title,source_url,impact,category,published_at').eq('is_material', true).order('published_at', { ascending: false }).limit(20),
    db.from('shared_virtual_trades').select('id,symbol,action,qty,price,pnl,reason,created_at').order('created_at', { ascending: false }).limit(20),
    db.from('earnings_events').select('id,symbol,event_date,source_url').gte('event_date', now.toISOString()).lte('event_date', new Date(now.getTime() + 14 * 86400000).toISOString()).order('event_date', { ascending: true }).limit(20),
    db.from('platform_tasks').select('id,title,due_at,symbol,notes').gte('due_at', now.toISOString()).lte('due_at', new Date(now.getTime() + 14 * 86400000).toISOString()).order('due_at', { ascending: true }).limit(20),
  ]);

  for (const result of [newsRes, tradesRes, earningsRes, tasksRes]) {
    if (result.error) {
      const msg = String(result.error.message || '');
      if (/does not exist|schema cache|could not find/i.test(msg)) {
        console.warn('جدول اختياري غير متاح بعد؛ تخطيه:', msg);
      } else {
        console.warn('تعذر قراءة مصدر أحداث (لا يوقف التشغيل):', msg);
      }
    }
  }

  const candidates = [];
  const recentCutoff = Date.now() - 15 * 60 * 1000;

  // ربح موثّق عبر الوقف المتحرك يُعالَج أولاً وبلا حد زمني — حتى لو كان الـ Cron متوقفاً
  // ساعة كاملة، المنشور يُلتقط في أول تشغيل ناجح ولا يضيع في طابور الأخبار.
  for (const t of tradesRes.data || []) {
    const isTrailingWin =
      t.action === 'sell' && Number(t.pnl) > 0 && /trailing stop|متحرك/i.test(String(t.reason || ''));
    if (isTrailingWin) {
      candidates.push({
        eventKey: `trade:${t.id}`,
        eventType: 'milestone',
        symbol: t.symbol,
        sourceId: String(t.id),
        payload: t,
      });
    } else if (!priorityOnly) {
      candidates.push({
        eventKey: `trade:${t.id}`,
        eventType: 'trade',
        symbol: t.symbol,
        sourceId: String(t.id),
        payload: t,
      });
    }
  }

  for (const n of newsRes.data || []) {
    const isRecent = new Date(n.published_at).getTime() >= recentCutoff;
    if (!priorityOnly || isRecent) {
      candidates.push({
        eventKey: `news:${n.id}`,
        eventType: 'news',
        symbol: n.symbol,
        sourceId: String(n.id),
        sourceUrl: n.source_url,
        payload: n,
      });
    }
  }

  if (!priorityOnly) {
    for (const e of earningsRes.data || []) {
      candidates.push({
        eventKey: `earnings:${e.id}`,
        eventType: 'earnings',
        symbol: e.symbol,
        sourceId: String(e.id),
        sourceUrl: e.source_url,
        payload: e,
      });
    }
    if (!tasksRes.error) {
      for (const task of tasksRes.data || []) {
        candidates.push({
          eventKey: `task:${task.id}`,
          eventType: 'education',
          symbol: task.symbol || null,
          sourceId: String(task.id),
          payload: {
            prompt: `حوّل مهمة المنصة التالية إلى محتوى تشويقي تعليمي غير مباشر (soft selling) دون توصية مالية: ${task.title}. الموعد: ${task.due_at}. ملاحظات: ${task.notes || 'لا توجد'}.`,
          },
        });
      }
    }
  }

  for (const candidate of candidates) {
    if (await unused(db, candidate.eventKey)) return { ...candidate, db };
  }
  return null;
}

/**
 * تغذية إخبارية تلقائية من خلاصات RSS مجانية (إدارة/أعمال/أسواق) عند عدم توفر
 * حدث داخلي جديد — تجعل الحساب مصدراً موثوقاً للأخبار حتى في هدوء بيانات المنصة.
 */
async function getTrendNewsEvent() {
  const db = getDb();
  let headlines = [];
  try {
    headlines = await fetchTrendingHeadlines({ maxAgeHours: 12, limit: 8 });
  } catch (err) {
    console.warn('تعذر جلب خلاصات RSS:', err.message);
    return null;
  }
  for (const headline of headlines) {
    const hash = crypto.createHash('sha1').update(headline.link).digest('hex').slice(0, 16);
    const eventKey = `trend:${hash}`;
    if (await unused(db, eventKey)) {
      return {
        eventKey,
        eventType: 'trend_news',
        symbol: null,
        sourceId: hash,
        sourceUrl: headline.link,
        payload: { title: headline.title, link: headline.link, tag: headline.tag },
        db,
      };
    }
  }
  return null;
}

module.exports = { getNextEvent, getTrendNewsEvent, getDb };
