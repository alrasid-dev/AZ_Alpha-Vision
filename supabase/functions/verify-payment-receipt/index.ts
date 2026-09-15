// verify-payment-receipt — OCR bank receipt via Gemini Vision → auto-activate subscription.
// No admin approval. Rejects duplicate reference and wrong amounts (only 299 / 899 SAR).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = Deno.env.get("GEMINI_VISION_MODEL") ||
  Deno.env.get("GEMINI_TEXT_MODEL") ||
  "gemini-2.5-flash";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SB_ANON_KEY") || "";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function normalizeReference(raw: string): string {
  return String(raw || "").trim().replace(/\s+/g, "").toUpperCase();
}

function planFromAmount(amount: number): { planCode: string; days: number } | null {
  if (amount === 299) return { planCode: "monthly", days: 30 };
  if (amount === 899) return { planCode: "quarterly", days: 90 };
  return null;
}

async function ocrReceipt(base64: string, mimeType: string): Promise<{ amount: number | null; reference: string | null; raw: string }> {
  const prompt =
    `Extract bank transfer details from this Saudi bank receipt image.
Return ONLY compact JSON: {"amount_sar": number|null, "reference": string|null}
- amount_sar: transferred amount in Saudi Riyal (number)
- reference: transfer/operation/reference number (string)
If unclear, use null. No markdown.`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mimeType || "image/jpeg", data: base64 } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini OCR error:", errText);
    throw new Error("ocr_failed");
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  const cleaned = text.replace(/```json|```/g, "").trim();
  let parsed: { amount_sar?: unknown; reference?: unknown } = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const amountMatch = cleaned.match(/(\d{3}(?:\.\d+)?)/);
    const refMatch = cleaned.match(/[A-Z0-9]{6,}/i);
    parsed = {
      amount_sar: amountMatch ? Number(amountMatch[1]) : null,
      reference: refMatch ? refMatch[0] : null,
    };
  }
  const amount = parsed.amount_sar == null ? null : Number(parsed.amount_sar);
  const reference = parsed.reference == null ? null : String(parsed.reference);
  return { amount: Number.isFinite(amount as number) ? (amount as number) : null, reference, raw: text };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!GEMINI_API_KEY) return json(500, { error: "GEMINI_API_KEY missing" });

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "unauthorized" });

  const userClient = createClient(SUPABASE_URL, ANON_KEY || SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json(401, { error: "unauthorized" });
  const userId = userData.user.id;

  let body: {
    receiptBase64?: string;
    mimeType?: string;
    receiptPath?: string;
    planCode?: string;
    manualReference?: string;
    manualAmount?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let amount: number | null = null;
  let reference: string | null = null;
  let ocrRaw: Record<string, unknown> = {};

  if (body.receiptBase64) {
    try {
      const ocr = await ocrReceipt(body.receiptBase64, body.mimeType || "image/jpeg");
      amount = ocr.amount;
      reference = ocr.reference;
      ocrRaw = { text: ocr.raw, amount: ocr.amount, reference: ocr.reference };
    } catch (e) {
      console.error(e);
      return json(502, { error: "ocr_failed", message: "تعذر قراءة الإيصال" });
    }
  }

  // Allow manual override fields only to fill OCR gaps (still validated)
  if ((amount == null || !Number.isFinite(amount)) && body.manualAmount != null) {
    amount = Number(body.manualAmount);
  }
  if ((!reference || reference.length < 4) && body.manualReference) {
    reference = body.manualReference;
  }

  const refNorm = normalizeReference(reference || "");
  if (!refNorm || refNorm.length < 4) {
    return json(400, { error: "invalid_reference", message: "مرجع التحويل غير صالح أو لم يُستخرج من الإيصال" });
  }
  if (amount == null || ![299, 899].includes(Number(amount))) {
    return json(400, {
      error: "wrong_amount",
      message: `المبلغ يجب أن يكون 299 أو 899 ريال (المستخرج: ${amount})`,
      ocr: ocrRaw,
    });
  }

  const plan = planFromAmount(Number(amount));
  if (!plan) return json(400, { error: "wrong_amount" });

  // Prefer planCode from client if consistent
  const planCode = body.planCode === "quarterly" || body.planCode === "monthly"
    ? body.planCode
    : plan.planCode;
  if (
    (planCode === "monthly" && Number(amount) !== 299) ||
    (planCode === "quarterly" && Number(amount) !== 899)
  ) {
    return json(400, {
      error: "plan_amount_mismatch",
      message: "الباقة لا تطابق المبلغ المستخرج من الإيصال",
    });
  }

  const { data: dup } = await admin
    .from("payment_receipts")
    .select("id")
    .eq("reference", refNorm)
    .maybeSingle();
  if (dup) {
    return json(409, { error: "duplicate_reference", message: "مرجع التحويل مستخدم مسبقاً" });
  }

  const { data: activated, error: actErr } = await admin.rpc(
    "activate_subscription_from_receipt",
    {
      p_user_id: userId,
      p_plan_code: planCode,
      p_amount_sar: Number(amount),
      p_reference: refNorm,
      p_receipt_path: body.receiptPath || null,
      p_ocr_raw: ocrRaw,
    },
  );

  if (actErr) {
    const msg = actErr.message || "";
    if (/duplicate_reference/i.test(msg)) {
      return json(409, { error: "duplicate_reference", message: "مرجع التحويل مستخدم مسبقاً" });
    }
    if (/invalid_amount/i.test(msg)) {
      return json(400, { error: "wrong_amount", message: "مبلغ غير صالح" });
    }
    console.error("activate error:", actErr);
    return json(500, { error: "activation_failed", message: msg });
  }

  return json(200, {
    ok: true,
    message: "تم تفعيل الاشتراك تلقائياً بعد التحقق من الإيصال",
    result: activated,
    amount_sar: Number(amount),
    reference: refNorm,
    plan_code: planCode,
    days: plan.days,
  });
});
