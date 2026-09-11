// وحدة مشتركة لإرسال Web Push حقيقي عبر VAPID لكل الدوال الخلفية
// (send-signal-notifications, send-price-alerts, send-news-notifications,
//  send-earnings-notifications, notify-subscription-expiry, send-admin-broadcast).
// مجانية 100%: web-push + VAPID لا يحتاجان أي خدمة مدفوعة.

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY =
  Deno.env.get("VAPID_PUBLIC_KEY") ||
  "BNk6hCs1rlvB-_8NSo0cxXNLR964XlRSwVE6THODXYwST84y8OMfzY_EsIkwnpTzQV8c4XY_whs4C1SBaphooIM";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT =
  Deno.env.get("VAPID_SUBJECT") || "mailto:azalphavision2026@gmail.com";

if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-notify-key, x-cron-key, x-trader-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// تحقّق من مفتاح تشغيل الجدولة السحابية (GitHub Actions cron) قبل تنفيذ أي دالة إرسال
export function checkRunKey(req: Request, envVar: string, header: string): Response | null {
  const expected = Deno.env.get(envVar) || "";
  const provided = req.headers.get(header) || "";
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const headerOk = Boolean(expected) && provided === expected;
  const serviceOk = Boolean(serviceRole) && auth === serviceRole;
  if (!headerOk && !serviceOk) {
    return jsonResponse({ error: "unauthorized — مفتاح التشغيل السحابي غير صحيح أو غير معرّف" }, 401);
  }
  return null;
}

export interface PushDeviceRow {
  id: string;
  user_id: string;
  endpoint: string;
  push_subscription: { endpoint: string; keys?: { p256dh: string; auth: string } };
}

async function restFetch(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function fetchActiveDevices(
  supabaseUrl: string,
  serviceRoleKey: string,
  userIds?: string[],
): Promise<PushDeviceRow[]> {
  let path = `notification_push_devices?select=id,user_id,endpoint,push_subscription&push_enabled=eq.true`;
  if (userIds && userIds.length) {
    path += `&user_id=in.(${userIds.join(",")})`;
  }
  const res = await restFetch(supabaseUrl, serviceRoleKey, path);
  if (!res.ok) return [];
  return await res.json();
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  direction?: "up" | "down" | "neutral";
  alertType?: string;
  icon?: string;
  image?: string;
  requireInteraction?: boolean;
}

export async function sendPushToDevices(
  supabaseUrl: string,
  serviceRoleKey: string,
  devices: PushDeviceRow[],
  payload: PushPayload,
): Promise<{ sent: number; failed: number; pruned: number }> {
  if (!VAPID_PRIVATE_KEY) {
    console.warn("VAPID_PRIVATE_KEY غير معرّف كسرّ Edge Function — تخطي الإرسال الفعلي.");
    return { sent: 0, failed: devices.length, pruned: 0 };
  }
  let sent = 0;
  let failed = 0;
  const staleEndpoints: string[] = [];
  await Promise.all(
    devices.map(async (device) => {
      if (!device.push_subscription?.endpoint) return;
      try {
        await webpush.sendNotification(
          device.push_subscription,
          JSON.stringify(payload),
        );
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          staleEndpoints.push(device.endpoint);
        } else {
          failed++;
          console.error("push send error:", device.endpoint, err);
        }
      }
    }),
  );
  if (staleEndpoints.length) {
    await restFetch(
      supabaseUrl,
      serviceRoleKey,
      `notification_push_devices?endpoint=in.(${staleEndpoints
        .map((e) => `"${e}"`)
        .join(",")})`,
      { method: "DELETE" },
    ).catch(() => {});
  }
  return { sent, failed, pruned: staleEndpoints.length };
}

// يمنع تكرار نفس الإشعار (نفس kind+ref_id) خلال نافذة زمنية معيّنة
export async function wasRecentlyNotified(
  supabaseUrl: string,
  serviceRoleKey: string,
  kind: string,
  refId: string,
  windowMinutes: number,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const res = await restFetch(
    supabaseUrl,
    serviceRoleKey,
    `push_notification_log?select=id&kind=eq.${encodeURIComponent(kind)}&ref_id=eq.${encodeURIComponent(refId)}&sent_at=gte.${since}&limit=1`,
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function logNotified(
  supabaseUrl: string,
  serviceRoleKey: string,
  kind: string,
  refId: string,
): Promise<void> {
  await restFetch(supabaseUrl, serviceRoleKey, "push_notification_log", {
    method: "POST",
    body: JSON.stringify({ kind, ref_id: refId }),
  }).catch(() => {});
}

export async function restSelect<T = unknown>(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
): Promise<T[]> {
  const res = await restFetch(supabaseUrl, serviceRoleKey, path);
  if (!res.ok) return [];
  return await res.json();
}

export async function restInsert(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  rows: Record<string, unknown>[],
): Promise<boolean> {
  if (!rows.length) return true;
  const res = await restFetch(supabaseUrl, serviceRoleKey, table, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  return res.ok;
}

// upsert (insert-or-update) باستخدام on_conflict — مطلوب لمحرك الصفقات (شراء/تحديث مركز)
export async function restUpsert(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
): Promise<boolean> {
  if (!rows.length) return true;
  const res = await restFetch(
    supabaseUrl,
    serviceRoleKey,
    `${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    },
  );
  return res.ok;
}

export async function restUpdate(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const res = await restFetch(supabaseUrl, serviceRoleKey, path, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

export async function restDelete(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
): Promise<boolean> {
  const res = await restFetch(supabaseUrl, serviceRoleKey, path, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return res.ok;
}

// —— تخصيص مصدر الرمز للمستخدم (محفظة / مفضلة / ترشيحات) ——

export type UserSymbolSets = {
  /** user_id → رموز في user_portfolio_positions */
  portfolio: Map<string, Set<string>>;
  /** user_id → رموز في watchlist (مفضلة) */
  watchlist: Map<string, Set<string>>;
};

interface SymbolOwnerRow {
  user_id: string;
  symbol: string;
}

function addToUserSymbolMap(
  map: Map<string, Set<string>>,
  userId: string,
  symbol: string,
): void {
  if (!userId || !symbol) return;
  if (!map.has(userId)) map.set(userId, new Set());
  map.get(userId)!.add(symbol);
}

/** تحميل محفظة + مفضلة دفعة واحدة لرموز الدفعة (تجنّب N+1). */
export async function loadUserSymbolSets(
  supabaseUrl: string,
  serviceRoleKey: string,
  symbols: string[],
): Promise<UserSymbolSets> {
  const portfolio = new Map<string, Set<string>>();
  const watchlist = new Map<string, Set<string>>();
  const unique = Array.from(
    new Set(
      symbols
        .map((s) => String(s || "").toUpperCase().trim())
        .filter(Boolean),
    ),
  );
  if (!unique.length) return { portfolio, watchlist };

  const symbolFilter = unique.map((s) => `"${s}"`).join(",");
  const [watchRows, portfolioRows] = await Promise.all([
    restSelect<SymbolOwnerRow>(
      supabaseUrl,
      serviceRoleKey,
      `watchlist?select=user_id,symbol&symbol=in.(${symbolFilter})`,
    ),
    restSelect<SymbolOwnerRow>(
      supabaseUrl,
      serviceRoleKey,
      `user_portfolio_positions?select=user_id,symbol&symbol=in.(${symbolFilter})`,
    ),
  ]);

  for (const row of watchRows) {
    addToUserSymbolMap(
      watchlist,
      row.user_id,
      String(row.symbol || "").toUpperCase(),
    );
  }
  for (const row of portfolioRows) {
    addToUserSymbolMap(
      portfolio,
      row.user_id,
      String(row.symbol || "").toUpperCase(),
    );
  }
  return { portfolio, watchlist };
}

/**
 * عبارة عربية قصيرة توضّح أين يقع الرمز لهذا المستخدم.
 * أولوية الدمج: محفظة > مفضلة > ترشيحات (أو دمج مختصر عند التعدد).
 * @param asPick true عندما يكون الإشعار أصلاً من ترشيحات الماسح (broadcast).
 */
export function symbolSourcePhrase(
  inPortfolio: boolean,
  inWatchlist: boolean,
  asPick = false,
): string {
  if (inPortfolio && inWatchlist) {
    // أولوية الدمج المختصر: محفظة + مفضلة (الترشيح واضح من نوع الإشعار)
    return "في محفظتك ومفضلتك";
  }
  if (inPortfolio) {
    return asPick ? "في محفظتك وترشيحاتك" : "في محفظتك";
  }
  if (inWatchlist) {
    return asPick ? "في مفضلتك وترشيحاتك" : "في مفضلتك";
  }
  return asPick ? "في ترشيحاتك" : "في قائمتك";
}

/** تسمية قصيرة للرمز داخل سطر الإشعار، مثل: «سهم في محفظتك». */
export function symbolSourceLabel(
  inPortfolio: boolean,
  inWatchlist: boolean,
  asPick = false,
): string {
  if (inPortfolio && inWatchlist) return "سهم في محفظتك ومفضلتك";
  if (inPortfolio) return "سهم في محفظتك";
  if (inWatchlist) return "سهم في مفضلتك";
  if (asPick) return "سهم في ترشيحاتك";
  return "سهم في قائمتك";
}

export type SourceKind = "portfolio" | "watchlist" | "picks";

/** المصدر الأعلى أولوية عبر رموز الدفعة لهذا المستخدم (محفظة > مفضلة > ترشيحات). */
export function dominantSourceForUser(
  symbols: string[],
  portfolio: Set<string> | undefined,
  watchlist: Set<string> | undefined,
  asPickFallback = true,
): SourceKind {
  const pf = portfolio || new Set<string>();
  const wl = watchlist || new Set<string>();
  let anyPf = false;
  let anyWl = false;
  for (const raw of symbols) {
    const sym = String(raw || "").toUpperCase();
    if (pf.has(sym)) anyPf = true;
    if (wl.has(sym)) anyWl = true;
  }
  if (anyPf) return "portfolio";
  if (anyWl) return "watchlist";
  return asPickFallback ? "picks" : "watchlist";
}

export function groupDevicesByUser(
  devices: PushDeviceRow[],
): Map<string, PushDeviceRow[]> {
  const map = new Map<string, PushDeviceRow[]>();
  for (const d of devices) {
    if (!d.user_id) continue;
    if (!map.has(d.user_id)) map.set(d.user_id, []);
    map.get(d.user_id)!.push(d);
  }
  return map;
}
