// send-signal-notifications — يُستدعى بعد fetch_screener_signals.py
// إشعارات دخول صريح/مؤكد مع السعر، وإشعارات خروج للترشيحات/الماسح.
// يُبقي البث لكل الأجهزة، مع نص مخصّص يوضح مصدر الرمز لكل مستلم
// (محفظتك / مفضلتك / ترشيحاتك).

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
  loadUserSymbolSets,
  symbolSourceLabel,
  symbolSourcePhrase,
  dominantSourceForUser,
  groupDevicesByUser,
  type PushDeviceRow,
  type SourceKind,
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

function formatSignalLine(
  s: SignalRow,
  tierFallback: string,
  priceField: "entry" | "exit",
  sourceLabel: string,
): string {
  const tier =
    priceField === "entry"
      ? s.entry_tier || tierFallback
      : s.exit_tier || tierFallback;
  const px = Number(s.price);
  const priceBit =
    Number.isFinite(px) && px > 0 ? ` @ $${px.toFixed(2)}` : "";
  return `${s.symbol}${priceBit} (${tier} · ${sourceLabel})`;
}

function entryTitle(kind: SourceKind): string {
  if (kind === "portfolio") return "📌 ترشيح — سهم في محفظتك · دخول تعليمي";
  if (kind === "watchlist") return "📌 ترشيح — سهم في مفضلتك · دخول تعليمي";
  return "📌 ترشيح — دخول تعليمي صريح";
}

function exitTitle(kind: SourceKind): string {
  if (kind === "portfolio") return "🚪 ترشيح — خروج تعليمي · سهم في محفظتك";
  if (kind === "watchlist") return "🚪 ترشيح — خروج تعليمي · سهم في مفضلتك";
  return "🚪 ترشيح — إشارة خروج تعليمية";
}

async function pushPersonalizedBatch(
  devices: PushDeviceRow[],
  signals: SignalRow[],
  mode: "entry" | "exit",
  sets: Awaited<ReturnType<typeof loadUserSymbolSets>>,
): Promise<number> {
  if (!signals.length || !devices.length) return 0;

  const byUser = groupDevicesByUser(devices);
  const symbols = signals.map((s) => s.symbol);
  let pushSent = 0;

  // تجميع المستخدمين الذين يحصلون على نفس النص لتقليل عدد الإرسالات المتطابقة
  const groups = new Map<
    string,
    { devices: PushDeviceRow[]; title: string; body: string }
  >();

  for (const [userId, userDevices] of byUser) {
    const pf = sets.portfolio.get(userId);
    const wl = sets.watchlist.get(userId);
    const lines = signals.slice(0, 5).map((s) => {
      const sym = String(s.symbol || "").toUpperCase();
      const inPf = Boolean(pf?.has(sym));
      const inWl = Boolean(wl?.has(sym));
      const label = symbolSourceLabel(inPf, inWl, true);
      return formatSignalLine(
        s,
        mode === "entry" ? "دخول" : "خروج",
        mode,
        label,
      );
    });
    const extra =
      signals.length > 5 ? ` و${signals.length - 5} أخرى` : "";
    const kind = dominantSourceForUser(symbols, pf, wl, true);
    const title = mode === "entry" ? entryTitle(kind) : exitTitle(kind);
    const anyPf = signals.some((s) =>
      pf?.has(String(s.symbol || "").toUpperCase())
    );
    const anyWl = signals.some((s) =>
      wl?.has(String(s.symbol || "").toUpperCase())
    );
    const phrase = symbolSourcePhrase(anyPf, anyWl, true);
    // جملة ختامية تعليمية مع إشارة للمصدر الغالب
    const body =
      mode === "entry"
        ? `سعر الدخول المقترح: ${lines.join(" · ")}${extra}. تعليمي فقط — ${phrase}. افتح تبويب الترشيحات.`
        : `مناطق الخروج المقترحة: ${lines.join(" · ")}${extra}. تعليمي فقط — ${phrase}. راجع الترشيحات.`;

    const groupKey = `${title}||${body}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { devices: [], title, body });
    }
    groups.get(groupKey)!.devices.push(...userDevices);
  }

  for (const group of groups.values()) {
    const result = await sendPushToDevices(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      group.devices,
      {
        title: group.title,
        body: group.body,
        url: "./#picks",
        tag: mode === "entry" ? "az-pick-entry" : "az-pick-exit",
        direction: mode === "entry" ? "up" : "down",
        alertType: "signal",
      },
    );
    pushSent += result.sent;
  }

  return pushSent;
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

    // بث لكل الأجهزة النشطة — مع تخصيص النص حسب محفظة/مفضلة كل مستخدم
    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
    const allSymbols = [...entryFresh, ...exitFresh].map((s) => s.symbol);
    const sets = await loadUserSymbolSets(SUPABASE_URL, SERVICE_ROLE_KEY, allSymbols);

    let pushSent = 0;
    if (entryFresh.length) {
      pushSent += await pushPersonalizedBatch(devices, entryFresh, "entry", sets);
    }
    if (exitFresh.length) {
      pushSent += await pushPersonalizedBatch(devices, exitFresh, "exit", sets);
    }

    return jsonResponse({
      ok: true,
      entry_alerts: entryFresh.length,
      exit_alerts: exitFresh.length,
      devices_targeted: devices.length,
      push_sent: pushSent,
      personalized_by_source: true,
    });
  } catch (err) {
    console.error("send-signal-notifications error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال إشعارات الإشارات" }, 500);
  }
});
