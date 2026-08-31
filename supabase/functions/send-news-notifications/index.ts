// send-news-notifications — يُستدعى بعد fetch_company_news.py كل ساعة أيام العمل.
// يرسل Push فوري عند رصد خبر شركة "مادي" (Material) جديد يخص رموز المحاكي.

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  sendPushToDevices,
  restSelect,
  wasRecentlyNotified,
  logNotified,
} from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface NewsRow {
  id: string;
  symbol: string;
  title: string;
  impact: string | null;
  published_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;

  try {
    const url = new URL(req.url);
    const minutes = Number(url.searchParams.get("minutes") || "120");
    const since = new Date(Date.now() - minutes * 60000).toISOString();

    const news = await restSelect<NewsRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `company_news?select=id,symbol,title,impact,published_at&is_material=eq.true&published_at=gte.${since}&order=published_at.desc&limit=15`,
    );
    if (!news.length) {
      return jsonResponse({ ok: true, new_items: 0, notified: 0, message: "لا أخبار مادية جديدة خلال هذه النافذة الزمنية" });
    }

    const fresh: NewsRow[] = [];
    for (const item of news) {
      const repeated = await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "news", item.id, minutes * 3);
      if (!repeated) fresh.push(item);
    }
    if (!fresh.length) {
      return jsonResponse({ ok: true, new_items: 0, notified: 0, message: "كل الأخبار المادية المتاحة أُرسلت مسبقًا" });
    }

    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    let sent = 0;
    for (const item of fresh.slice(0, 5)) {
      const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
        title: `📰 خبر مادي: ${item.symbol}`,
        body: item.title,
        url: "./#dashboard",
        tag: `az-news-${item.id}`,
        alertType: "news",
      });
      sent += result.sent;
      await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "news", item.id);
    }

    return jsonResponse({ ok: true, new_items: fresh.length, devices_targeted: devices.length, push_sent: sent });
  } catch (err) {
    console.error("send-news-notifications error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال إشعارات الأخبار" }, 500);
  }
});
