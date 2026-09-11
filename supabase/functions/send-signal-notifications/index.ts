// send-signal-notifications — يُستدعى بعد fetch_screener_signals.py
// إشعارات دخول صريح/مؤكد مع السعر، وإشعارات خروج للترشيحات/الماسح.

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
  exit_score: number | null;
  exit_tier: string | null;
  exit_signals: Record<string, unknown> | null;
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
      `screener_signals?select=preset,symbol,company,price,entry_score,entry_tier,entry_signals,exit_score,exit_tier,exit_signals,updated_at&updated_at=gte.${since}&order=entry_score.desc&limit=80`,
    );

    const entryFresh: SignalRow[] = [];
    const exitFresh: SignalRow[] = [];
    for (const s of signals) {
      const isStrongEntry =
        s.entry_tier === "صريح" || s.entry_tier === "مؤكد" || Number(s.entry_score || 0) >= 3;
      const isExit =
        Boolean(s.exit_tier) || Number(s.exit_score || 0) >= 2;
      if (isStrongEntry) {
        const refId = `entry|${s.preset}|${s.symbol}`;
        const repeated = await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "signal", refId, minutes);
        if (!repeated) entryFresh.push(s);
      }
      if (isExit) {
        const refId = `exit|${s.preset}|${s.symbol}`;
        const repeated = await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "signal_exit", refId, minutes);
        if (!repeated) exitFresh.push(s);
      }
    }

    if (!entryFresh.length && !exitFresh.length) {
      return jsonResponse({ ok: true, new_alerts: 0, notified: 0, message: "لا إشارات دخول/خروج جديدة خلال هذه النافذة" });
    }

    if (entryFresh.length) {
      await restInsert(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        "screener_alerts",
        entryFresh.map((s) => ({
          preset: s.preset,
          symbol: s.symbol,
          type: "entry",
          tier: s.entry_tier,
          score: s.entry_score,
          price: s.price,
          signals: s.entry_signals,
        })),
      );
      for (const s of entryFresh) {
        await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "signal", `entry|${s.preset}|${s.symbol}`);
      }
    }
    if (exitFresh.length) {
      await restInsert(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        "screener_alerts",
        exitFresh.map((s) => ({
          preset: s.preset,
          symbol: s.symbol,
          type: "exit",
          tier: s.exit_tier,
          score: s.exit_score,
          price: s.price,
          signals: s.exit_signals,
        })),
      );
      for (const s of exitFresh) {
        await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "signal_exit", `exit|${s.preset}|${s.symbol}`);
      }
    }

    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    let pushSent = 0;

    if (entryFresh.length) {
      const lines = entryFresh.slice(0, 5).map((s) => {
        const px = Number(s.price);
        return Number.isFinite(px) && px > 0
          ? `${s.symbol} @ $${px.toFixed(2)} (${s.entry_tier || "دخول"})`
          : `${s.symbol} (${s.entry_tier || "دخول"})`;
      });
      const extra = entryFresh.length > 5 ? ` و${entryFresh.length - 5} أخرى` : "";
      const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
        title: "📌 ترشيح — دخول تعليمي صريح",
        body: `سعر الدخول المقترح: ${lines.join(" · ")}${extra}. تعليمي فقط — افتح تبويب الترشيحات.`,
        url: "./#picks",
        tag: "az-pick-entry",
        direction: "up",
        alertType: "signal",
      });
      pushSent += result.sent;
    }

    if (exitFresh.length) {
      const lines = exitFresh.slice(0, 5).map((s) => {
        const px = Number(s.price);
        return Number.isFinite(px) && px > 0
          ? `${s.symbol} @ $${px.toFixed(2)} (${s.exit_tier || "خروج"})`
          : `${s.symbol} (${s.exit_tier || "خروج"})`;
      });
      const extra = exitFresh.length > 5 ? ` و${exitFresh.length - 5} أخرى` : "";
      const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
        title: "🚪 ترشيح — إشارة خروج تعليمية",
        body: `مناطق الخروج المقترحة: ${lines.join(" · ")}${extra}. تعليمي فقط — راجع الترشيحات.`,
        url: "./#picks",
        tag: "az-pick-exit",
        direction: "down",
        alertType: "signal",
      });
      pushSent += result.sent;
    }

    return jsonResponse({
      ok: true,
      entry_alerts: entryFresh.length,
      exit_alerts: exitFresh.length,
      devices_targeted: devices.length,
      push_sent: pushSent,
    });
  } catch (err) {
    console.error("send-signal-notifications error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال إشعارات الإشارات" }, 500);
  }
});
