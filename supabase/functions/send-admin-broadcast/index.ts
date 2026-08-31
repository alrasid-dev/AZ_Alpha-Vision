// send-admin-broadcast — يُستدعى من لوحة الأدمن (app.js) فور نشر إعلان بث جديد.
// يتحقق أن المستدعي أدمن فعليًا، ثم يرسل Push فوري حسب جمهور الإعلان (الكل أو مستخدم محدد).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CORS_HEADERS,
  jsonResponse,
  fetchActiveDevices,
  sendPushToDevices,
  restSelect,
} from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface BroadcastRow {
  id: string;
  title: string;
  body: string;
  image_url: string | null;
  audience_type: "all" | "user";
  target_user_id: string | null;
  push_enabled: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "مطلوب تسجيل الدخول" }, 401);

    const authedClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await authedClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return jsonResponse({ error: "جلسة غير صالحة" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: profile } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!profile || profile.role !== "admin") {
      return jsonResponse({ error: "هذا الإجراء متاح للمشرفين فقط" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const broadcastId = body?.broadcast_id;
    if (!broadcastId) return jsonResponse({ error: "broadcast_id مطلوب" }, 400);

    const rows = await restSelect<BroadcastRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `admin_broadcasts?select=id,title,body,image_url,audience_type,target_user_id,push_enabled&id=eq.${broadcastId}&limit=1`,
    );
    const broadcast = rows[0];
    if (!broadcast) return jsonResponse({ error: "الإعلان غير موجود" }, 404);
    if (!broadcast.push_enabled) {
      return jsonResponse({ ok: true, push_sent: 0, message: "الإشعار الفوري غير مفعّل لهذا الإعلان" });
    }

    const userIds =
      broadcast.audience_type === "user" && broadcast.target_user_id
        ? [broadcast.target_user_id]
        : undefined;
    const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY, userIds);

    const result = await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
      title: `📢 ${broadcast.title}`,
      body: broadcast.body,
      url: "./#dashboard",
      tag: `az-broadcast-${broadcast.id}`,
      image: broadcast.image_url || undefined,
      alertType: "broadcast",
      requireInteraction: true,
    });

    return jsonResponse({ ok: true, devices_targeted: devices.length, ...result });
  } catch (err) {
    console.error("send-admin-broadcast error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء إرسال البث" }, 500);
  }
});
