const { createClient } = require('@supabase/supabase-js');

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

  for (const result of [newsRes, tradesRes, earningsRes]) {
    if (result.error && !/does not exist/i.test(result.error.message)) throw result.error;
  }

  const candidates = [];
  const recentCutoff = Date.now() - 15 * 60 * 1000;

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
    for (const t of tradesRes.data || []) {
      candidates.push({
        eventKey: `trade:${t.id}`,
        eventType: 'trade',
        symbol: t.symbol,
        sourceId: String(t.id),
        payload: t,
      });
    }
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

module.exports = { getNextEvent, getDb };
