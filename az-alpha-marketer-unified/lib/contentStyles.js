// محرك تنويع أساليب النشر: يمنع تكرار نفس الأسلوب في منشورين متتاليين، ويوزّع الأساليب
// بذكاء بحسب نوع الحدث المتاح (لا عشوائية بلا معنى).
const STYLES = ['soft_sell', 'thread', 'meme_trend'];

/**
 * يختار الأسلوب المناسب بحسب: نوع الحدث، عدد المنشورات المنشورة اليوم (لتدوير الأساليب)،
 * ووجود بديل مناسب (لا نستخدم "ثريد" لحدث صفقة محاكاة قصيرة مثلاً).
 */
function pickStyle({ event, postedToday = 0, lastStyle = null }) {
  // ثريد تعليمي مناسب فقط للمحتوى التعليمي/الإخباري العميق، وليس لصفقات المحاكي القصيرة.
  const threadEligible = ['education', 'news', 'trend_news', 'earnings'].includes(event.eventType);
  // ميم/تريند مناسب لخبر عاجل أو ترند فعلي، وأيضاً لإنجاز ربح موثّق (milestone) لأنه خبر
  // إيجابي فوري يستحق نبرة أكثر حيوية بدل الأسلوب الإداري الهادئ المعتاد.
  const memeEligible = ['news', 'trend_news', 'milestone'].includes(event.eventType);

  const eligible = STYLES.filter((s) => {
    if (s === 'thread' && !threadEligible) return false;
    if (s === 'meme_trend' && !memeEligible) return false;
    return true;
  });

  // تدوير غير عشوائي: نستخدم عدد منشورات اليوم كمؤشر دوران بين الأساليب المتاحة،
  // مع تفادي تكرار آخر أسلوب مستخدم مباشرة إن وُجد بديل.
  let idx = postedToday % eligible.length;
  let style = eligible[idx];
  if (style === lastStyle && eligible.length > 1) {
    idx = (idx + 1) % eligible.length;
    style = eligible[idx];
  }
  return style;
}

const TRENDING_HASHTAG_POOL = {
  management: ['#الإدارة_الذكية', '#ريادة_الأعمال', '#تطوير_الأعمال', '#الإنتاجية'],
  finance_ar: ['#أسواق_المال', '#تحليل_فني', '#الأسهم_الأمريكية', '#استثمار'],
  finance_en: ['#StockMarket', '#FinTok', '#Investing', '#MarketNews'],
  brand: ['#AZAlphaVision'],
};

function hashtagForSymbol(symbol) {
  const clean = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '');
  return clean && clean.length <= 15 ? `#${clean}` : null;
}

/**
 * يبني وسم هاشتاق ذكي حسب نوع الحدث والأسلوب: يمزج بين وسم الرمز (إن وجد)،
 * وسوم إدارية/مالية شائعة التفاعل، ووسم الهوية دائماً في الأخير.
 */
function smartHashtags({ event, style, dayIndex = 0 }) {
  const symbolTag = hashtagForSymbol(event.symbol);
  let pool;
  if (event.eventType === 'milestone') {
    // ربح موثّق من المحاكي — نمزج وسوماً عربية وإنجليزية معاً لأوسع انتشار ممكن لهذا الخبر الإيجابي.
    pool = TRENDING_HASHTAG_POOL.finance_ar.concat(TRENDING_HASHTAG_POOL.finance_en);
  } else if (event.eventType === 'trend_news' || style === 'meme_trend') {
    pool = TRENDING_HASHTAG_POOL.finance_en.concat(TRENDING_HASHTAG_POOL.management);
  } else if (event.eventType === 'news' || event.eventType === 'earnings') {
    pool = TRENDING_HASHTAG_POOL.finance_ar;
  } else {
    pool = TRENDING_HASHTAG_POOL.management.concat(TRENDING_HASHTAG_POOL.finance_ar);
  }
  const rotated = pool[dayIndex % pool.length];
  const secondary = pool[(dayIndex + 1) % pool.length];
  // وسم الهوية #AZAlphaVision يبقى مضموناً دائماً في الناتج؛ سابقاً كان القص عند 3 وسوم
  // يُسقطه بصمت كلما وُجد وسم رمز سهم (لأن الترتيب [رمز، موضوع1، موضوع2، هوية] يقصّه القص).
  const topicTags = [...new Set([rotated, secondary])].filter(Boolean);
  const tags = [symbolTag, ...topicTags].filter(Boolean).slice(0, 3);
  if (!tags.includes(TRENDING_HASHTAG_POOL.brand[0])) tags.push(TRENDING_HASHTAG_POOL.brand[0]);
  return [...new Set(tags)].join(' ');
}

module.exports = { STYLES, pickStyle, smartHashtags, hashtagForSymbol };
