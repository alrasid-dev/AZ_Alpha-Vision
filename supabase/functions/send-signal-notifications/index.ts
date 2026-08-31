// send-signal-notifications — يُستدعى بعد fetch_screener_signals.py (كل ساعة أيام العمل)
// يرصد إشارات الدخول القوية الجديدة، يسجّلها في screener_alerts، ويرسل Push فوري لكل المستخدمين المفعّلين.

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  sendPushToDevices,
  restSelect,
  restInsert,
  wasRecentlyNotified,
  logNotified,
} from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface SignalRow {
  preset: string;
  symbol: string;
  company: string | null;
  price: number | null;
  entry_score: number | null;
  entry_tier: string | null;
  entry_signals: Record<string, unknown> | null;
  updated_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;

  try {
    const url = new URL(req.url);
    const minutes = Number(url.searchParams.get("minutes") || "120");
    const since = new Date(Date.now() - minutes * 60000).toISOString();

    const signals = await restSelect<SignalRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `screener_signals?select=preset,symbol,company,price,entry_score,entry_tier,entry_signals,updated_at&entry_tier=in.(%D8%B5%D8%B1%D9%8A%D8%AD,%D9%85%D8%A4%D9%83%D8%AF)&updated_at=gte.${since}&order=entry_score.desc&limit=40`,
    );

    if (!signals.length) {
      return jsonResponse({ ok: true, new_alerts: 0, notified: 0, message: "لا إشارات دخول قوية جديدة خلال هذه النافذة الزمنية" });
    }

    // منع تكرار نفس التنبيه (preset+symbol) عدة مرات لكل تشغيل جدولة
    const fresh: SignalRow[] = [];
    for (const s of signals) {
      const refId = `${s.preset}|${s.symbol}`;
      const repeated = await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "signal", refId, minutes);
      if (!repeated) fresh.push(s);
    }

    if (!fresh.length) {
      return jsonResponse({ ok: true, new_alerts: 0, notified: 0, message: "كل الإشارات المتاحة أُرسلت مسبقًا خلال هذه النافذة" });
    }

    await restInsert(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      "screener_alerts",
      fresh.map((s) => ({
        preset: s.preset,
        symbol: s.symbol,
        type: "entry",
        tier: s.entry_tier,
        score: s.entry_score,
        price: s.price,
        signals: s.entry_signals,
      })),
    );

    for (const s of fresh) {
      await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "signal", `${s.preset}|${s.symbol}`);
    }

    const top = fresh.slice(0, 5).map((s) => s.symbol).join("، ");
    const extra = fresh.length > 5 ? ` و${fresh.length - 5} إشارة أخرى` : "";
    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
      title: "🚀 إشارات دخول تعليمية جديدة",
      body: `الماسح رصد ${fresh.length} إشارة قوية: ${top}${extra}. افتح تبويب الماسح الآن.`,
      url: "./#signals",
      tag: "az-signal-batch",
      direction: "up",
      alertType: "signal",
    });

    return jsonResponse({
      ok: true,
      new_alerts: fresh.length,
      devices_targeted: devices.length,
      ...result,
    });
  } catch (err) {
    console.error("send-signal-notifications error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال إشعارات الإشارات" }, 500);
  }
});
