require('dotenv').config();
const { getNextEvent, getTrendNewsEvent, getDb } = require('./lib/events');
const { generateEventPost } = require('./lib/generateEventPost');
const { postTweet, postThread } = require('./lib/postToX');
const { generateImage } = require('./lib/generateImage');
const { pickStyle, smartHashtags } = require('./lib/contentStyles');
const { isPeakHour, nextPeakWindowLabel } = require('./lib/scheduler');
const themes = require('./themes');

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.POSTING_TIMEZONE || 'Asia/Riyadh' }).format(date);
}

const FALLBACK_PROMPTS = [
  'اشرح باختصار لماذا لا يكفي مؤشر واحد لاتخاذ قرار تعليمي، وكيف يمكن مقارنة RSI مع الاتجاه والمتوسطات دون تقديم توصية.',
  'اكتب فكرة تعليمية قصيرة عن التنويع: توزيع المخاطر بين قطاعات مختلفة لا يعني ضمان الربح.',
  'عرّف بإدارة المخاطر في المحاكاة الافتراضية: حجم الصفقة ووقف الحماية قبل الدخول، والمثال تعليمي فقط.',
  'اشرح للمبتدئ معنى المتوسط المتحرك وكيف يساعد على قراءة الاتجاه، دون ذكر سهم محدد أو توقع سعر.',
  'عرّف بماسح AZ Alpha Vision: يجمع الفلاتر والقوالب ويعرض سبب الإشارة بدل الاكتفاء بلون أو رقم.',
  'اكتب قصة قصيرة عن متداول افتراضي تعلّم أن الانتظار جزء من الخطة عندما لا يصل السعر إلى منطقة الدخول.',
  'اشرح الفرق بين الخبر المؤثر والضجيج، ولماذا تُقرأ المصدر والتاريخ قبل تكوين رأي تعليمي.',
  'ذكّر أن سجل المحاكي الافتراضي وسيلة للتعلم والاختبار، وليس حساباً مالياً حقيقياً.',
];

function fallbackEvent(db) {
  const now = new Date();
  const day = dayKey(now);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.POSTING_TIMEZONE || 'Asia/Riyadh',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now)
  );
  const slot = Math.floor(hour / 2);
  const index = (slot + Number(day.replace(/-/g, ''))) % FALLBACK_PROMPTS.length;
  const theme = themes[index % themes.length];
  return {
    eventKey: `education:${day}:${slot}`,
    eventType: 'education',
    symbol: null,
    sourceId: `${day}:${slot}`,
    sourceUrl: null,
    payload: { prompt: FALLBACK_PROMPTS[index], theme },
    db,
  };
}

async function quota(db) {
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const { data: rows, error } = await db
    .from('marketing_posts')
    .select('created_at,status,content_style')
    .eq('status', 'posted')
    .gte('created_at', new Date(Date.now() - 3 * 86400000).toISOString());
  if (error) throw error;
  const postedToday = (rows || []).filter((r) => dayKey(new Date(r.created_at)) === today).length;
  const postedYesterday = (rows || []).filter((r) => dayKey(new Date(r.created_at)) === yesterday).length;
  const carry = Math.min(6, Math.max(0, 12 - postedYesterday));
  const sortedRecent = (rows || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const lastStyle = sortedRecent[0]?.content_style || null;
  return { postedToday, limit: 12 + carry, remaining: Math.max(0, 12 + carry - postedToday), lastStyle };
}

function registrationUrl(event) {
  const campaign =
    event.eventType === 'earnings'
      ? 'earnings'
      : event.eventType === 'news'
        ? 'news'
        : event.eventType === 'trend_news'
          ? 'trend'
          : event.eventType === 'trade'
            ? 'simulator'
            : 'education';
  const base = (process.env.SITE_URL || 'https://azalphavision.com').replace(/\/$/, '');
  return `${base}/?register=1&utm_source=x&utm_medium=organic&utm_campaign=${campaign}`;
}

async function maybeImage(event) {
  if (String(process.env.GENERATE_IMAGES || '0') !== '1') return null;
  try {
    const theme = event.payload?.theme || themes[0];
    return await generateImage({
      imageStyle: theme.imageStyle || 'هوية هادئة مؤسسية لكحلي وبرونزي',
      type: theme.type || 'تعليمي',
    });
  } catch (err) {
    console.warn('تعذر توليد الصورة، سيُنشر النص فقط:', err.message);
    return null;
  }
}

/** يبني النص/الأجزاء النهائية جاهزة للنشر بحسب نوع المحتوى (نص واحد أو ثريد). */
function buildFinalContent({ generated, event, hashtags, url }) {
  const subscribeLine = `جرّب المحاكي التعليمي مجاناً وسجّل من هنا: ${url}${event.sourceUrl ? `\nالمصدر: ${event.sourceUrl}` : ''}`;
  if (generated.kind === 'thread') {
    const parts = [...generated.parts];
    parts[parts.length - 1] = `${parts[parts.length - 1]}\n\n${hashtags}\n${subscribeLine}`;
    return { kind: 'thread', parts, recordText: parts.join('\n---\n') };
  }
  const fullText = `${generated.text}\n\n${hashtags}\n${subscribeLine}`;
  return { kind: 'single', text: fullText, recordText: fullText };
}

async function run() {
  console.log(`[${new Date().toISOString()}] بدء المشغل الموحد المرتبط ببيانات المنصة`);
  const db = getDb();
  const q = await quota(db);
  if (q.remaining <= 0) {
    console.log(`اكتملت الحصة اليومية: ${q.postedToday}/${q.limit}`);
    return;
  }

  const priority = await getNextEvent({ priorityOnly: true });
  let event = priority;

  if (!event) {
    // خارج ساعات الذروة ولا يوجد خبر عاجل: نوفّر الحصة لأوقات التفاعل الأعلى.
    if (!isPeakHour()) {
      console.log(`خارج نافذة الذروة الآن؛ الانتظار حتى الساعة ${nextPeakWindowLabel()} (بتوقيت ${process.env.POSTING_TIMEZONE || 'Asia/Riyadh'})`);
      return;
    }
    const { data: last } = await db
      .from('marketing_posts')
      .select('created_at')
      .eq('status', 'posted')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && Date.now() - new Date(last.created_at).getTime() < 2 * 60 * 60 * 1000) {
      console.log('لم تمر ساعتان على آخر منشور؛ لا نشر عادي الآن');
      return;
    }
    event = await getNextEvent();
  }
  if (!event) {
    event = await getTrendNewsEvent();
    if (event) console.log(`لا يوجد حدث داخلي جديد؛ استخدام خبر ترند خارجي: ${event.payload.title}`);
  }
  if (!event) {
    event = fallbackEvent(db);
    console.log(`لا يوجد حدث سوقي جديد؛ محتوى تعليمي احتياطي ${event.eventKey}`);
  }

  const style = pickStyle({ event, postedToday: q.postedToday, lastStyle: q.lastStyle });
  console.log(`الأسلوب المختار لهذا المنشور: ${style}`);

  const generated = await generateEventPost(event, style);
  const hashtags = smartHashtags({ event, style, dayIndex: q.postedToday });
  const url = registrationUrl(event);
  const final = buildFinalContent({ generated, event, hashtags, url });

  const { data: existing } = await event.db
    .from('marketing_posts')
    .select('id,status,tweet_text')
    .eq('event_key', event.eventKey)
    .maybeSingle();
  let draft = existing;
  if (!draft) {
    const basePayload = {
      event_key: event.eventKey,
      event_type: event.eventType,
      symbol: event.symbol,
      source_id: event.sourceId,
      tweet_text: final.recordText,
      source_url: event.sourceUrl || null,
      status: 'draft',
    };
    let created, draftError;
    ({ data: created, error: draftError } = await event.db
      .from('marketing_posts')
      .insert({ ...basePayload, content_style: style })
      .select('id,status,tweet_text')
      .single());
    if (draftError && /content_style/i.test(draftError.message || '')) {
      // العمود الاختياري غير موجود بعد (لم تُشغَّل ترقية الـ SQL) — نعيد المحاولة بدونه.
      ({ data: created, error: draftError } = await event.db
        .from('marketing_posts')
        .insert(basePayload)
        .select('id,status,tweet_text')
        .single());
    }
    if (draftError && /event_type|check constraint/i.test(draftError.message || '') && basePayload.event_type === 'trend_news') {
      // قيد event_type القديم لم يُحدَّث بعد (ترقية الـ SQL اختيارية) — نخزّنه كنوع "news" المتوافق
      // مع القيد الحالي، مع الحفاظ على محتوى الخبر ورابط المصدر كما هو.
      ({ data: created, error: draftError } = await event.db
        .from('marketing_posts')
        .insert({ ...basePayload, event_type: 'news' })
        .select('id,status,tweet_text')
        .single());
    }
    if (draftError) throw draftError;
    draft = created;
    console.log(`تم إنشاء مسودة ${draft.id} (${final.kind === 'thread' ? `ثريد من ${final.parts.length} تغريدات` : 'منشور واحد'}):\n${final.recordText}`);
  } else {
    console.log(`المحتوى موجود مسبقاً ${draft.id} بحالة ${draft.status}؛ لن يُكرر`);
  }

  if (String(process.env.PUBLISH_MODE || 'draft').toLowerCase() !== 'publish') {
    console.log('وضع المعاينة مفعّل؛ لم يتم النشر على X');
    return;
  }
  if (draft.status === 'posted') return;

  const imageBuffer = await maybeImage(event);
  const tweet =
    final.kind === 'thread'
      ? await postThread({ parts: final.parts, imageBuffer })
      : await postTweet({ text: final.text, imageBuffer });

  const { error } = await event.db
    .from('marketing_posts')
    .update({ status: 'posted', tweet_id: tweet.data.id, posted_at: new Date().toISOString() })
    .eq('id', draft.id);
  if (error) throw error;
  console.log('تم النشر على X:', tweet.data.id, tweet.threadIds ? `(ثريد: ${tweet.threadIds.join(', ')})` : '');
}

run()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('فشل المشغل الموحد:', err?.response?.data || err.message || err);
    process.exit(1);
  });
