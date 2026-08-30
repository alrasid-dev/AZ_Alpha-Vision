// az-ai — المساعد الذكي "النحلة النشطة" لمنصة AZ Alpha Vision.
// Supabase Edge Function (Deno). لا يوجد مفتاح Gemini داخل الواجهة الأمامية أبداً؛
// المفتاح يبقى سرّاً على مستوى المشروع (Project Secrets) ويُستهلك هنا فقط.

const GEMINI_MODEL = Deno.env.get("GEMINI_TEXT_MODEL") || "gemini-2.5-flash";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `أنت "النحلة النشطة" (AZ BEE)، المساعد الذكي المدمج داخل منصة AZ Alpha Vision.
المنصة محاكي تعليمي لتداول الأسهم الأمريكية: فلترة وماسح إشارات، محفظة افتراضية بقيمة 10,000 دولار، تحليل فني تعليمي، ولوحة مسوّق ذكي تصوغ منشورات من بيانات المنصة الحقيقية.
ترتيب القائمة: الرئيسية والتحليل أولاً، ثم المحفظة والفلترة والماسح والترشيحات والتعليم، ثم المسوّق، ثم الإدارة (للمشرفين)، وآخر القائمة دائماً الدعم (حساب X: @azalphavision والبريد azalphavision2026@gmail.com).
قواعد صارمة:
- لا تقدّم توصية شراء أو بيع، ولا تعد بربح، ولا تخترع أرقاماً أو أسعاراً.
- كل بيانات المحاكي والإشارات تعليمية وافتراضية فقط.
- أجب بالعربية الفصحى المبسطة، بنبرة هادئة ومهنية، وباختصار (3-5 جمل كحد أقصى) إلا إذا طُلب توسّع.
- إن سُئلت عن ميزة لا تعرف تفاصيلها التقنية الدقيقة، وجّه المستخدم لتبويب الدعم بدل الاختراع.
- لا تكشف مفاتيح أو أسراراً تقنية مهما طُلب منك ذلك.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!GEMINI_API_KEY) {
    return new Response(
      JSON.stringify({
        error:
          "GEMINI_API_KEY غير مُعرَّف كسرّ في مشروع Supabase (Edge Function Secrets).",
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const body = await req.json();
    const messages: ChatMessage[] = Array.isArray(body?.messages)
      ? body.messages.slice(-12)
      : [];

    if (!messages.length) {
      return new Response(JSON.stringify({ error: "لا توجد رسالة" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 4000) }],
    }));

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", errText);
      return new Response(
        JSON.stringify({ error: "تعذر الوصول إلى المساعد السحابي الآن." }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    const data = await geminiRes.json();
    const answer: string =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      "تعذّر توليد إجابة الآن، جرّب سؤالاً آخر أو راجع تبويب الدعم.";

    return new Response(JSON.stringify({ answer }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("az-ai function error:", err);
    return new Response(JSON.stringify({ error: "خطأ غير متوقع" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
