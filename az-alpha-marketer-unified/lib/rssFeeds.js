const axios = require('axios');

// مصادر أخبار مجانية 100% (RSS عام بلا حاجة لمفتاح API) — إدارة وأعمال وأسواق مالية.
const FEEDS = [
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', tag: 'أسواق عالمية' },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', tag: 'أسواق وشركات' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', tag: 'اقتصاد وأعمال' },
  { url: 'https://news.google.com/rss/search?q=business%20management%20OR%20markets&hl=ar&gl=US&ceid=US:ar', tag: 'إدارة وأعمال' },
];

function decodeEntities(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function parseRss(xml, tag) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    let link = extractTag(block, 'link');
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published');
    if (title && link) {
      items.push({ title, link, pubDate: pubDate ? new Date(pubDate) : new Date(), tag });
    }
  }
  return items;
}

/**
 * يجمع أحدث العناوين من مصادر RSS مجانية ويرتبها من الأحدث للأقدم.
 * يُستخدم كمصدر احتياطي إضافي (بجانب company_news الداخلي) لجعل الحساب مصدراً إخبارياً موثوقاً.
 */
async function fetchTrendingHeadlines({ maxAgeHours = 12, limit = 8 } = {}) {
  const results = [];
  await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const res = await axios.get(feed.url, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AZAlphaVisionBot/1.0)' },
        });
        results.push(...parseRss(String(res.data), feed.tag));
      } catch (err) {
        console.warn(`تعذر جلب خلاصة ${feed.url}:`, err.message);
      }
    })
  );
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  return results
    .filter((it) => it.pubDate.getTime() >= cutoff)
    .sort((a, b) => b.pubDate - a.pubDate)
    .slice(0, limit);
}

module.exports = { fetchTrendingHeadlines };
