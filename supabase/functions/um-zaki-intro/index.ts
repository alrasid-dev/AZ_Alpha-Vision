// um-zaki-intro — بث تعريف أم زكي لكل الأجهزة النشطة (شامية). تعليمي فقط.
import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  loadNotificationPrefs,
  sendCategorizedPush,
  logNotified,
} from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    const prefsMap = await loadNotificationPrefs(SUPABASE_URL, SERVICE_ROLE_KEY);
    const result = await sendCategorizedPush(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      devices,
      prefsMap,
      "um_zaki",
      {
        title: "👂 أنا أم زكي",
        body:
          "هلا فيكم عيني… أنا أم زكي 😋😂 بتتبّع الطراطيش والإشاعات اللي تدور على الأسهم (محفظتك / المحاكي / الترشيحات)، ولما أتأكد بخبركم بصراحة. تعليمي بس — مو توصية تداول.",
        url: "./#dashboard",
        tag: "az-um-zaki-intro",
        alertType: "um_zaki",
        direction: "neutral",
        requireInteraction: false,
      },
    );
    await logNotified(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      "um_zaki_intro",
      `intro|${new Date().toISOString().slice(0, 13)}`,
    );
    return jsonResponse({
      ok: true,
      mode: "intro",
      devices_targeted: devices.length,
      ...result,
    });
  } catch (err) {
    console.error("um-zaki-intro error:", err);
    return jsonResponse({ error: "فشل بث تعريف أم زكي" }, 500);
  }
});
