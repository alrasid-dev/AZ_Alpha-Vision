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
    "authorization, x-client-info, apikey, content-type, x-notify-key, x-cron-key",
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
  if (!expected || provided !== expected) {
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
