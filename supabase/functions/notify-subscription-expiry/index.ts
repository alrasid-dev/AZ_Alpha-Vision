// notify-subscription-expiry — يُستدعى يوميًا 6:15 صباحًا UTC (بدون JWT — انشرها
// عبر: supabase functions deploy notify-subscription-expiry --no-verify-jwt)
// يذكّر أي مستخدم تنتهي تجربته المجانية خلال 3 أيام.

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

interface ProfileRow {
  id: string;
  name: string | null;
  trial_end: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "SUBSCRIPTION_CRON_KEY", "x-cron-key");
  if (authFail) return authFail;

  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * 86400000);

    const rows = await restSelect<ProfileRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `profiles?select=id,name,trial_end&role=eq.user&approved=eq.true&trial_end=gte.${now.toISOString()}&trial_end=lte.${soon.toISOString()}`,
    );
    if (!rows.length) {
      return jsonResponse({ ok: true, expiring: 0, notified: 0, message: "لا اشتراكات تنتهي خلال 3 أيام" });
    }

    let notified = 0;
    for (const profile of rows) {
      const repeated = await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "trial_expiry", profile.id, 60 * 20);
      if (repeated) continue;

      const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY, [profile.id]);
      if (!devices.length) continue;

      const daysLeft = Math.max(1, Math.ceil((new Date(profile.trial_end).getTime() - now.getTime()) / 86400000));
      const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
        title: "⏳ تنبيه انتهاء التجربة المجانية",
        body: `تجربتك في AZ Alpha Vision تنتهي خلال ${daysLeft} يوم${daysLeft > 1 ? "ًا" : ""}. جدّد من تبويب الحساب لمواصلة الاستخدام.`,
        url: "./#admin",
        tag: `az-trial-${profile.id}`,
        alertType: "trial",
      });
      if (result.sent > 0) {
        notified++;
        await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "trial_expiry", profile.id);
      }
    }

    return jsonResponse({ ok: true, expiring: rows.length, notified });
  } catch (err) {
    console.error("notify-subscription-expiry error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال تذكيرات الاشتراك" }, 500);
  }
});
