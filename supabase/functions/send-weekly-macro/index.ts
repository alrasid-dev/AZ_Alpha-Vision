// send-weekly-macro — تنبيه ماكرو/فيد/عطل يوم الاثنين قبل افتتاح السوق.
// تلوين أخضر/رمادي/أحمر تعليمي. لا يخترع أحداثاً مؤثرة؛ يعتمد تقويم NYSE + تلميحات عامة.

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
import { getUsMarketClock, nyseCalendar } from "../_shared/usMarketHours.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Tone = "green" | "gray" | "red";

function toneVisual(tone: Tone): { emoji: string; label: string; direction: "up" | "down" | "neutral" } {
  if (tone === "green") return { emoji: "🟢", label: "هادئ/داعم", direction: "up" };
  if (tone === "red") return { emoji: "🔴", label: "حذر", direction: "down" };
  return { emoji: "⚪", label: "محايد", direction: "neutral" };
}

function upcomingWeekItems(clock = getUsMarketClock()): { tone: Tone; text: string }[] {
  const items: { tone: Tone; text: string }[] = [];
  const y = clock.ny.year;
  const m = clock.ny.month;
  const d = clock.ny.day;
  const cal = nyseCalendar(y);
  // ابحث عن عطل خلال الأيام السبعة القادمة
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const ymd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    const holiday = cal.holidays.get(ymd) || nyseCalendar(y + 1).holidays.get(ymd) || nyseCalendar(y - 1).holidays.get(ymd);
    if (holiday) {
      items.push({ tone: "red", text: `إجازة سوق محتملة هذا الأسبوع: ${holiday} (${ymd}) — وقوف تام متوقع` });
    }
    if (nyseCalendar(y).earlyCloses.has(ymd) || nyseCalendar(y + 1).earlyCloses.has(ymd)) {
      items.push({ tone: "gray", text: `إغلاق مبكر محتمل (${ymd}) — راقب ساعات ما بعد التداول` });
    }
  }

  // تلميحات ماكرو عامة تعليمية حسب الشهر (ليست توقعات)
  if (m === 1 || m === 7) {
    items.push({ tone: "gray", text: "موسم بيانات اقتصادية مكثّف غالباً — راجع التقويم الرسمي قبل أي قرار تعليمي" });
  } else if (m === 3 || m === 6 || m === 9 || m === 12) {
    items.push({ tone: "red", text: "نوافذ اجتماعات بنك الاحتياطي الفيدرالي شائعة في هذا الربع — تقلب محتمل حول البيانات (تعليمي)" });
  } else {
    items.push({ tone: "green", text: "لا عطلة NYSE فورية ظاهرة في المسح السريع — أسبوع دراسي اعتيادي للمحاكي" });
  }

  if (!items.length) {
    items.push({ tone: "green", text: "بداية أسبوع تعليمية هادئة ظاهرياً — راجع قائمتك بهدوء" });
  }
  return items.slice(0, 3);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;

  try {
    const clock = getUsMarketClock();
    // الاثنين فقط، قبل/مع بداية ما قبل التداول (04:00–09:30 NY)
    if (clock.ny.weekday !== "Mon") {
      return jsonResponse({ ok: true, skipped: true, reason: "التنبيه الأسبوعي يوم الاثنين فقط" });
    }
    if (clock.session === "holiday" || clock.session === "weekend") {
      return jsonResponse({ ok: true, skipped: true, reason: clock.labelAr });
    }
    const mins = clock.ny.minutes;
    if (mins < 4 * 60 || mins >= 9 * 60 + 30) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "خارج نافذة ما قبل الافتتاح يوم الاثنين (04:00–09:30 نيويورك)",
      });
    }

    const weekKey = clock.ny.ymd;
    const items = upcomingWeekItems(clock);
    const primary = items[0];
    const visual = toneVisual(primary.tone);
    const body = items.map((it) => `${toneVisual(it.tone).emoji} ${it.text}`).join(" · ") +
      " — تعليمي فقط، ليست توصية.";

    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    const prefsMap = await loadNotificationPrefs(SUPABASE_URL, SERVICE_ROLE_KEY);
    const byUser = groupDevicesByUser(devices);
    let sent = 0;
    let skipped = 0;

    for (const [userId, userDevices] of byUser) {
      const refId = `${userId}|week|${weekKey}`;
      if (await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "weekly_macro", refId, 6 * 24 * 60)) {
        skipped += userDevices.length;
        continue;
      }
      const result = await sendCategorizedPush(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        userDevices,
        prefsMap,
        "weekly_macro",
        {
          title: `${visual.emoji} ماكرو الاثنين · ${visual.label}`,
          body,
          url: "./#home",
          tag: `az-macro-${weekKey}`,
          direction: visual.direction,
          alertType: "weekly_macro",
        },
      );
      sent += result.sent;
      skipped += result.skipped;
      if (result.sent > 0) {
        await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "weekly_macro", refId);
      }
    }

    return jsonResponse({ ok: true, week: weekKey, items, push_sent: sent, skipped });
  } catch (err) {
    console.error("send-weekly-macro error:", err);
    return jsonResponse({ error: "خطأ أثناء إرسال تنبيه الماكرو الأسبوعي" }, 500);
  }
});
