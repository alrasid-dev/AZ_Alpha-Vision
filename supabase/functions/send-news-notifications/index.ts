// send-news-notifications — يُستدعى بعد fetch_company_news.py كل ساعة أيام العمل.
// يرسل Push شخصي عندما يمسّ خبر مادي رمزاً في محفظة المستخدم أو قائمة مراقبته.
// الأثر: إيجابي (أخضر) / محايد (رمادي) / سلبي (أحمر) في العنوان والنص.
// يميّز النص: محفظتك vs مفضلتك (أو الاثنين).

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  restSelect,
  wasRecentlyNotified,
  logNotified,
  symbolSourceLabel,
  groupDevicesByUser,
  loadNotificationPrefs,
  sendCategorizedPush,
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
interface SymbolOwner {
  user_id: string;
  symbol: string;
}

function impactVisual(impact: string | null): { emoji: string; label: string } {
  const key = String(impact || "").toLowerCase();
  if (key === "positive") return { emoji: "🟢", label: "إيجابي" };
  if (key === "negative") return { emoji: "🔴", label: "سلبي" };
  return { emoji: "⚪", label: "محايد" };
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
      `company_news?select=id,symbol,title,impact,published_at&is_material=eq.true&published_at=gte.${since}&order=published_at.desc&limit=40`,
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

    const symbols = Array.from(new Set(fresh.map((n) => n.symbol.toUpperCase())));
    const symbolFilter = symbols.map((s) => `"${s}"`).join(",");

    const [watchRows, portfolioRows] = await Promise.all([
      restSelect<SymbolOwner>(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `watchlist?select=user_id,symbol&symbol=in.(${symbolFilter})`,
      ),
      restSelect<SymbolOwner>(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `user_portfolio_positions?select=user_id,symbol&symbol=in.(${symbolFilter})`,
      ),
    ]);

    // user_id → symbols per source (محفظة / مفضلة) — للتمييز في النص
    const portfolioByUser = new Map<string, Set<string>>();
    const watchlistByUser = new Map<string, Set<string>>();
    const ownersBySymbol = new Map<string, Set<string>>();

    const addOwner = (
      map: Map<string, Set<string>>,
      userId: string,
      sym: string,
    ) => {
      if (!map.has(userId)) map.set(userId, new Set());
      map.get(userId)!.add(sym);
      if (!ownersBySymbol.has(sym)) ownersBySymbol.set(sym, new Set());
      ownersBySymbol.get(sym)!.add(userId);
    };

    for (const row of watchRows) {
      const sym = String(row.symbol || "").toUpperCase();
      addOwner(watchlistByUser, row.user_id, sym);
    }
    for (const row of portfolioRows) {
      const sym = String(row.symbol || "").toUpperCase();
      addOwner(portfolioByUser, row.user_id, sym);
    }

    const prefsMap = await loadNotificationPrefs(SUPABASE_URL, SERVICE_ROLE_KEY);
    let sent = 0;
    let targeted = 0;
    for (const item of fresh.slice(0, 12)) {
      const sym = item.symbol.toUpperCase();
      const owners = Array.from(ownersBySymbol.get(sym) || []);
      if (!owners.length) continue;
      const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY, owners);
      if (!devices.length) continue;

      const visual = impactVisual(item.impact);
      const byUser = groupDevicesByUser(devices);
      const groups = new Map<
        string,
        { devices: typeof devices; title: string; body: string }
      >();

      for (const [userId, userDevices] of byUser) {
        const inPf = Boolean(portfolioByUser.get(userId)?.has(sym));
        const inWl = Boolean(watchlistByUser.get(userId)?.has(sym));
        const sourceLabel = symbolSourceLabel(inPf, inWl, false);
        const title = `${visual.emoji} خبر ${visual.label}: ${item.symbol} · ${sourceLabel}`;
        const body = `${item.title} — ${sourceLabel}.`;
        const key = `${title}||${body}`;
        if (!groups.has(key)) groups.set(key, { devices: [], title, body });
        groups.get(key)!.devices.push(...userDevices);
      }

      for (const group of groups.values()) {
        const result = await sendCategorizedPush(
          SUPABASE_URL,
          SERVICE_ROLE_KEY,
          group.devices,
          prefsMap,
          "news",
          {
            title: group.title,
            body: `${group.body} تعليمي فقط.`,
            url: "./#portfolio",
            tag: `az-news-${item.id}`,
            alertType: "news",
            direction: item.impact === "positive" ? "up" : item.impact === "negative" ? "down" : "neutral",
          },
        );
        sent += result.sent;
      }
      targeted += owners.length;
      await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "news", item.id);
    }

    return jsonResponse({
      ok: true,
      new_items: fresh.length,
      users_targeted: targeted,
      push_sent: sent,
      scoped_to_portfolio_or_watchlist: true,
      personalized_by_source: true,
    });
  } catch (err) {
    console.error("send-news-notifications error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال إشعارات الأخبار" }, 500);
  }
});
