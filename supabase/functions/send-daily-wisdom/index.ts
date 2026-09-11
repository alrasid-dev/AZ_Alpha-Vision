// send-daily-wisdom — حكمة مالية قصيرة تعليمية عند افتتاح السوق الأمريكي.
// مرة واحدة لكل مستخدم يومياً. يحترم تفضيلات daily_wisdom + وضع الصامت.

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  loadNotificationPrefs,
  sendCategorizedPush,
  wasRecentlyNotified,
  logNotified,
  groupDevicesByUser,
} from "../_shared/push.ts";
import { getUsMarketClock } from "../_shared/usMarketHours.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const QUOTES = [
  "الصبر جزء من إدارة المخاطر — لا تلاحق كل شمعة.",
  "الخطة قبل الصفقة؛ العاطفة بعد إغلاق الدفتر التعليمي.",
  "التنويع تعليمٌ ضد المفاجآت — لا تضع كل الرهان على رمز واحد.",
  "السوق يعلّم كل يوم؛ الدرس الأهم: احترم وقف الخسارة الافتراضي.",
  "السيولة والوضوح أهم من الضجيج — اقرأ الإطار الزمني قبل القرار التعليمي.",
  "الربح التعليمي يأتي من تكرار منضبط، لا من ضربة حظ واحدة.",
  "قبل الافتتاح: راجع قائمتك، لا أخبار الإشاعات.",
  "الخسارة الصغيرة المدروسة أفضل من الإصرار العشوائي.",
  "الوقت في السوق أهم من توقيت السوق — تعلّم الصبر المنهجي.",
  "اكتب سبب الدخول قبل الضغط؛ راجع السبب بعد الخروج.",
  "التقلب فرصة تعليمية… إن كان حجم المركز مناسباً.",
  "لا تحوّل التنبيه إلى أمر — كل إشعار هنا تعليمي فقط.",
];

function dayKeyNY(clock = getUsMarketClock()): string {
  return clock.ny.ymd;
}

function quoteForDay(ymd: string): string {
  let h = 0;
  for (let i = 0; i < ymd.length; i++) h = (h * 31 + ymd.charCodeAt(i)) >>> 0;
  return QUOTES[h % QUOTES.length];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;

  try {
    const clock = getUsMarketClock();
    // نافذة قصيرة حول الافتتاح الرسمي (09:30–10:15 NY) في أيام التداول فقط
    if (clock.session === "weekend" || clock.session === "holiday") {
      return jsonResponse({ ok: true, skipped: true, reason: clock.labelAr });
    }
    const mins = clock.ny.minutes;
    const open = 9 * 60 + 30;
    if (mins < open || mins > open + 45) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "خارج نافذة افتتاح الجلسة الرسمية (09:30–10:15 بتوقيت نيويورك)",
        session: clock.session,
      });
    }

    const ymd = dayKeyNY(clock);
    const quote = quoteForDay(ymd);
    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    if (!devices.length) return jsonResponse({ ok: true, push_sent: 0, message: "لا أجهزة" });

    const prefsMap = await loadNotificationPrefs(SUPABASE_URL, SERVICE_ROLE_KEY);
    const byUser = groupDevicesByUser(devices);
    let sent = 0;
    let skipped = 0;

    for (const [userId, userDevices] of byUser) {
      const refId = `${userId}|${ymd}`;
      if (await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "daily_wisdom", refId, 20 * 60)) {
        skipped += userDevices.length;
        continue;
      }
      const result = await sendCategorizedPush(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        userDevices,
        prefsMap,
        "daily_wisdom",
        {
          title: "📖 حكمة الافتتاح — تعليمية",
          body: `${quote} — تعليمي فقط، ليست توصية.`,
          url: "./#home",
          tag: `az-wisdom-${ymd}`,
          direction: "neutral",
          alertType: "daily_wisdom",
        },
      );
      sent += result.sent;
      skipped += result.skipped;
      if (result.sent > 0) {
        await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "daily_wisdom", refId);
      }
    }

    return jsonResponse({
      ok: true,
      ymd,
      quote,
      push_sent: sent,
      skipped,
      session: clock.session,
    });
  } catch (err) {
    console.error("send-daily-wisdom error:", err);
    return jsonResponse({ error: "خطأ أثناء إرسال حكمة الافتتاح" }, 500);
  }
});
