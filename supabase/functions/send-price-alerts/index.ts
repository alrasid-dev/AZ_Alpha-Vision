// send-price-alerts — يُستدعى بعد كل تحديث أسعار حي (كل 5 دقائق وقت السوق).
// يرسل Push شخصي فقط لمن يملك السهم المتحرك في قائمة مراقبته الخاصة.

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

interface LiveQuoteRow {
  symbol: string;
  price: number;
  change_pct: number;
}
interface WatchlistRow {
  user_id: string;
  symbol: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;

  try {
    const url = new URL(req.url);
    const threshold = Number(url.searchParams.get("threshold") || "2");
    const cooldown = Number(url.searchParams.get("cooldown_minutes") || "60");

    const movers = await restSelect<LiveQuoteRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `live_quotes?select=symbol,price,change_pct&or=(change_pct.gte.${threshold},change_pct.lte.-${threshold})&limit=200`,
    );
    if (!movers.length) {
      return jsonResponse({ ok: true, movers: 0, notified: 0, message: "لا حركة سعرية تتجاوز الحد المطلوب الآن" });
    }
    const moverMap = new Map(movers.map((m) => [m.symbol, m]));
    const symbolList = movers.map((m) => `"${m.symbol}"`).join(",");

    const watchRows = await restSelect<WatchlistRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `watchlist?select=user_id,symbol&symbol=in.(${symbolList})`,
    );
    if (!watchRows.length) {
      return jsonResponse({ ok: true, movers: movers.length, notified: 0, message: "لا مستخدم يراقب هذه الرموز حاليًا" });
    }

    const byUser = new Map<string, WatchlistRow[]>();
    for (const row of watchRows) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id)!.push(row);
    }

    let notifiedUsers = 0;
    let totalSent = 0;
    for (const [userId, rows] of byUser) {
      const eligible: string[] = [];
      for (const row of rows) {
        const refId = `${userId}|${row.symbol}`;
        const recently = await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "price_alert", refId, cooldown);
        if (!recently) eligible.push(row.symbol);
      }
      if (!eligible.length) continue;

      const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY, [userId]);
      if (!devices.length) continue;

      const lines = eligible
        .map((sym) => {
          const q = moverMap.get(sym)!;
          const sign = q.change_pct >= 0 ? "+" : "";
          return `${sym} ${sign}${q.change_pct.toFixed(2)}%`;
        })
        .join(" · ");
      const anyUp = eligible.some((sym) => (moverMap.get(sym)?.change_pct ?? 0) >= 0);

      const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
        title: "📈 تحرك سعري في قائمة مراقبتك",
        body: lines,
        url: "./#dashboard",
        tag: `az-price-${userId}`,
        direction: anyUp ? "up" : "down",
        alertType: "price",
      });
      totalSent += result.sent;
      if (result.sent > 0) {
        notifiedUsers++;
        for (const sym of eligible) {
          await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "price_alert", `${userId}|${sym}`);
        }
      }
    }

    return jsonResponse({ ok: true, movers: movers.length, notified_users: notifiedUsers, push_sent: totalSent });
  } catch (err) {
    console.error("send-price-alerts error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال تنبيهات الأسعار" }, 500);
  }
});
