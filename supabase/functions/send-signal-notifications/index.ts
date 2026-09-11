// send-signal-notifications — بعد fetch_screener_signals.py
// إشعارات دخول/خروج تعليمية، رمز واحد لكل إشعار (واجهة جوال أوضح)،
// مع فلتر الأسهم القابلة للتداول واحترام تفضيلات ترشيحاتي/الماسح + الصامت.

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  restSelect,
  restInsert,
  wasRecentlyNotified,
  logNotified,
  loadUserSymbolSets,
  symbolSourceLabel,
  loadNotificationPrefs,
  sendCategorizedPush,
  filterTradableSymbols,
  groupDevicesByUser,
  type PushDeviceRow,
  type SourceKind,
  type NotifyCategory,
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
  exchange?: string | null;
  industry?: string | null;
  sector?: string | null;
  finviz_sector?: string | null;
}

function entryTitle(kind: SourceKind, symbol: string): string {
  if (kind === "portfolio") return `📌 ${symbol} · ترشيح في محفظتك`;
  if (kind === "watchlist") return `📌 ${symbol} · ترشيح في مفضلتك`;
  return `📌 ${symbol} · دخول تعليمي`;
}

function exitTitle(kind: SourceKind, symbol: string): string {
  if (kind === "portfolio") return `🚪 ${symbol} · خروج · محفظتك`;
  if (kind === "watchlist") return `🚪 ${symbol} · خروج · مفضلتك`;
  return `🚪 ${symbol} · خروج تعليمي`;
}

async function pushOneSymbolBatches(
  devices: PushDeviceRow[],
  signals: SignalRow[],
  mode: "entry" | "exit",
  sets: Awaited<ReturnType<typeof loadUserSymbolSets>>,
  prefsMap: Awaited<ReturnType<typeof loadNotificationPrefs>>,
  category: NotifyCategory,
): Promise<number> {
  if (!signals.length || !devices.length) return 0;
  const byUser = groupDevicesByUser(devices);
  let pushSent = 0;

  // رمز واحد لكل إشعار — أفضل للجوال من تجميع قبيح
  for (const s of signals.slice(0, 12)) {
    const sym = String(s.symbol || "").toUpperCase();
    const px = Number(s.price);
    const priceBit = Number.isFinite(px) && px > 0 ? ` @ $${px.toFixed(2)}` : "";
    const tier = mode === "entry" ? s.entry_tier || "دخول" : s.exit_tier || "خروج";

    for (const [userId, userDevices] of byUser) {
      const pf = sets.portfolio.get(userId);
      const wl = sets.watchlist.get(userId);
      const inPf = Boolean(pf?.has(sym));
      const inWl = Boolean(wl?.has(sym));
      const label = symbolSourceLabel(inPf, inWl, true);
      const kind: SourceKind = inPf ? "portfolio" : inWl ? "watchlist" : "picks";
      const title = mode === "entry" ? entryTitle(kind, sym) : exitTitle(kind, sym);
      const body =
        mode === "entry"
          ? `${tier}${priceBit} · ${label}. تعليمي فقط — افتح الترشيحات.`
          : `${tier}${priceBit} · ${label}. تعليمي فقط — راجع الخروج.`;

      const result = await sendCategorizedPush(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        userDevices,
        prefsMap,
        category,
        {
          title,
          body,
          url: "./#picks",
          tag: `az-pick-${mode}-${sym}`,
          direction: mode === "entry" ? "up" : "down",
          alertType: "signal",
        },
      );
      pushSent += result.sent;
    }
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
      `screener_signals?select=preset,symbol,company,price,entry_score,entry_tier,entry_signals,exit_score,exit_tier,exit_signals,updated_at,exchange,industry,sector,finviz_sector&updated_at=gte.${since}&order=entry_score.desc&limit=80`,
    );

    const tradable = await filterTradableSymbols(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      signals.map((s) => s.symbol),
    );

    const entryFresh: SignalRow[] = [];
    const exitFresh: SignalRow[] = [];
    for (const s of signals) {
      const sym = String(s.symbol || "").toUpperCase();
      if (!tradable.has(sym)) continue;
      const isStrongEntry =
        s.entry_tier === "صريح" || s.entry_tier === "مؤكد" || Number(s.entry_score || 0) >= 3;
      const isExit = Boolean(s.exit_tier) || Number(s.exit_score || 0) >= 2;
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
      return jsonResponse({
        ok: true,
        new_alerts: 0,
        notified: 0,
        filtered_non_tradable: true,
        message: "لا إشارات دخول/خروج جديدة قابلة للتداول خلال هذه النافذة",
      });
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
    const allSymbols = [...entryFresh, ...exitFresh].map((s) => s.symbol);
    const sets = await loadUserSymbolSets(SUPABASE_URL, SERVICE_ROLE_KEY, allSymbols);
    const prefsMap = await loadNotificationPrefs(SUPABASE_URL, SERVICE_ROLE_KEY);

    let pushSent = 0;
    // الترشيحات تستخدم فئة picks؛ الماسح screener لنفس القناة عند البث العام
    if (entryFresh.length) {
      pushSent += await pushOneSymbolBatches(devices, entryFresh, "entry", sets, prefsMap, "picks");
    }
    if (exitFresh.length) {
      pushSent += await pushOneSymbolBatches(devices, exitFresh, "exit", sets, prefsMap, "picks");
    }

    return jsonResponse({
      ok: true,
      entry_alerts: entryFresh.length,
      exit_alerts: exitFresh.length,
      devices_targeted: devices.length,
      push_sent: pushSent,
      one_symbol_per_notification: true,
      filtered_non_tradable: true,
    });
  } catch (err) {
    console.error("send-signal-notifications error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال إشعارات الإشارات" }, 500);
  }
});
