// send-price-alerts — بعد تحديث الأسعار الحية.
// تنبيهات لقائمة المراقبة + محفظة المستخدم بروح سياسة المحاكي (وقف ~-8%، تقدم ~+20%).

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
  entry_price?: number | null;
}
interface PortfolioRow {
  user_id: string;
  symbol: string;
  buy_price: number;
  qty: number;
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
    const quoteMap = new Map(
      (await restSelect<LiveQuoteRow>(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `live_quotes?select=symbol,price,change_pct&limit=2000`,
      )).map((q) => [q.symbol.toUpperCase(), q]),
    );

    const watchRows = await restSelect<WatchlistRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `watchlist?select=user_id,symbol,entry_price`,
    );
    const portfolioRows = await restSelect<PortfolioRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `user_portfolio_positions?select=user_id,symbol,buy_price,qty`,
    );

    type AlertLine = { symbol: string; text: string; kind: "move" | "entry" | "exit"; up: boolean };
    const byUser = new Map<string, AlertLine[]>();

    const add = (userId: string, line: AlertLine) => {
      if (!byUser.has(userId)) byUser.set(userId, []);
      byUser.get(userId)!.push(line);
    };

    const moverMap = new Map(movers.map((m) => [m.symbol.toUpperCase(), m]));
    for (const row of watchRows) {
      const sym = String(row.symbol || "").toUpperCase();
      const q = moverMap.get(sym);
      if (!q) continue;
      const sign = q.change_pct >= 0 ? "+" : "";
      add(row.user_id, {
        symbol: sym,
        text: `${sym} ${sign}${q.change_pct.toFixed(2)}%`,
        kind: "move",
        up: q.change_pct >= 0,
      });
    }

    // روح سياسة المحاكي على محفظة المستخدم: قرب وقف الخسارة أو تقدم ملحوظ
    for (const row of portfolioRows) {
      const sym = String(row.symbol || "").toUpperCase();
      const q = quoteMap.get(sym);
      const buy = Number(row.buy_price);
      if (!q || !(buy > 0) || !(q.price > 0)) continue;
      const pct = ((q.price - buy) / buy) * 100;
      if (pct <= -8) {
        add(row.user_id, {
          symbol: sym,
          text: `${sym} قرب منطقة وقف تعليمية (${pct.toFixed(1)}% من شراء $${buy.toFixed(2)})`,
          kind: "exit",
          up: false,
        });
      } else if (pct >= 20) {
        add(row.user_id, {
          symbol: sym,
          text: `${sym} تقدّم تعليمي +${pct.toFixed(1)}% من شراء $${buy.toFixed(2)} — راقب منطقة خروج`,
          kind: "exit",
          up: true,
        });
      } else if (Math.abs(q.change_pct) >= threshold) {
        const sign = q.change_pct >= 0 ? "+" : "";
        add(row.user_id, {
          symbol: sym,
          text: `محفظتك · ${sym} ${sign}${q.change_pct.toFixed(2)}% (شراء $${buy.toFixed(2)})`,
          kind: "move",
          up: q.change_pct >= 0,
        });
      }
    }

    let notifiedUsers = 0;
    let totalSent = 0;
    for (const [userId, lines] of byUser) {
      const eligible: AlertLine[] = [];
      for (const line of lines) {
        const refId = `${userId}|${line.kind}|${line.symbol}`;
        const recently = await wasRecentlyNotified(
          SUPABASE_URL,
          SERVICE_ROLE_KEY,
          line.kind === "move" ? "price_alert" : "portfolio_alert",
          refId,
          cooldown,
        );
        if (!recently) eligible.push(line);
      }
      if (!eligible.length) continue;
      const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY, [userId]);
      if (!devices.length) continue;

      const anyExit = eligible.some((l) => l.kind === "exit");
      const anyUp = eligible.some((l) => l.up);
      const body = eligible.slice(0, 6).map((l) => l.text).join(" · ");
      const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
        title: anyExit ? "🔔 تنبيه محفظة/مراقبة — دخول/خروج تعليمي" : "📈 تحرك سعري في قائمتك",
        body,
        url: "./#portfolio",
        tag: `az-price-${userId}`,
        direction: anyUp ? "up" : "down",
        alertType: "price",
      });
      totalSent += result.sent;
      if (result.sent > 0) {
        notifiedUsers++;
        for (const line of eligible) {
          await logNotified(
            SUPABASE_URL,
            SERVICE_ROLE_KEY,
            line.kind === "move" ? "price_alert" : "portfolio_alert",
            `${userId}|${line.kind}|${line.symbol}`,
          );
        }
      }
    }

    return jsonResponse({
      ok: true,
      movers: movers.length,
      notified_users: notifiedUsers,
      push_sent: totalSent,
    });
  } catch (err) {
    console.error("send-price-alerts error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال تنبيهات الأسعار" }, 500);
  }
});
