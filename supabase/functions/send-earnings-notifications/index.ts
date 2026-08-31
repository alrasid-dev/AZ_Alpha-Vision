// send-earnings-notifications — يُستدعى بعد fetch_earnings_calendar.py كل ساعتين.
// يرسل تذكيرًا واحدًا قبل موعد الأرباح بيوم إلى يومين لكل رمز متابَع.

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

interface EarningsRow {
  symbol: string;
  company_name: string | null;
  event_date: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;

  try {
    const today = new Date();
    const windowEnd = new Date(today.getTime() + 2 * 86400000);
    const todayStr = today.toISOString().slice(0, 10);
    const windowEndStr = windowEnd.toISOString().slice(0, 10);

    const rows = await restSelect<EarningsRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `earnings_events?select=symbol,company_name,event_date&event_type=eq.earnings&event_date=gte.${todayStr}&event_date=lte.${windowEndStr}&order=event_date.asc&limit=25`,
    );
    if (!rows.length) {
      return jsonResponse({ ok: true, upcoming: 0, notified: 0, message: "لا أرباح مجدولة خلال اليومين القادمين" });
    }

    const fresh: EarningsRow[] = [];
    for (const row of rows) {
      const refId = `${row.symbol}|${row.event_date}`;
      const repeated = await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "earnings", refId, 60 * 20);
      if (!repeated) fresh.push(row);
    }
    if (!fresh.length) {
      return jsonResponse({ ok: true, upcoming: rows.length, notified: 0, message: "كل التذكيرات المتاحة أُرسلت مسبقًا" });
    }

    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    const top = fresh.slice(0, 6).map((r) => `${r.symbol} (${r.event_date})`).join("، ");

    const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
      title: "📅 تذكير أرباح قادمة",
      body: `مواعيد أرباح تعليمية قريبة: ${top}`,
      url: "./#picks",
      tag: "az-earnings-batch",
      alertType: "earnings",
    });

    for (const row of fresh) {
      await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "earnings", `${row.symbol}|${row.event_date}`);
    }

    return jsonResponse({ ok: true, upcoming: fresh.length, devices_targeted: devices.length, ...result });
  } catch (err) {
    console.error("send-earnings-notifications error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال تذكيرات الأرباح" }, 500);
  }
});
