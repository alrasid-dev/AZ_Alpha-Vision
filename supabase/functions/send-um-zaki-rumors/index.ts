// send-um-zaki-rumors — «أُم زِكي»: تنبيهات طراطيش كلام (إشاعات) ثم تحقق صادق.
// النطاق فقط: رموز في محفظة المستخدم أو المحاكي أو الترشيحات.
// اللهجة الشامية لأم زكي فقط. تعليمي — لا يخترع حقائق ولا يسيء للكرامة/الدين.

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  loadNotificationPrefs,
  sendCategorizedPush,
  restSelect,
  restInsert,
  restUpdate,
  wasRecentlyNotified,
  logNotified,
  loadSimulatorSymbols,
  umZakiSourceLabel,
  groupDevicesByUser,
} from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface NewsRow {
  id: string;
  symbol: string;
  title: string;
  summary: string | null;
  impact: string | null;
  is_material: boolean;
  published_at: string;
  source_name: string | null;
}
interface RumorEvent {
  id: string;
  symbol: string;
  rumor_summary: string;
  verify_status: string;
  source_news_id: string | null;
  created_at: string;
}
interface OwnerRow { user_id: string; symbol: string }
interface PickRow { symbol: string }

const RUMOR_RE =
  /rumor|hearsay|unconfirmed|speculat|allegedly| reportedly|may be|could be|sources say|طراطيش|إشاع|غير مؤكد|يُقال|وفقا.? لمصادر|تسريبات/i;

function looksLikeRumor(n: NewsRow): boolean {
  const blob = `${n.title || ""} ${n.summary || ""} ${n.source_name || ""}`;
  if (RUMOR_RE.test(blob)) return true;
  // أخبار مادية بلا مصدر واضح تُعامل بحذر كـ«طراطيش» للمرحلة الأولى فقط
  if (n.is_material && /blog|forum|social|telegram|twitter|x\.com/i.test(String(n.source_name || ""))) {
    return true;
  }
  return false;
}

function shamiBuzz(symbol: string, sourceLabel: string, hint: string): { title: string; body: string } {
  const short = String(hint || "").replace(/\s+/g, " ").trim().slice(0, 90);
  return {
    title: `👂 أم زكي · طراطيش كلام · ${symbol}`,
    body: `هلا انتا عيني… في طراطيش كلام عن ${symbol} (${sourceLabel}). ${short ? `يعني: ${short}. ` : ""}بعد التحقق منحكيلك بصراحة. تعليمي بس — مو توصية.`,
  };
}

function shamiVerify(
  symbol: string,
  sourceLabel: string,
  status: "verified_true" | "verified_false" | "unverified",
  summary: string,
): { title: string; body: string; direction: "up" | "down" | "neutral" } {
  if (status === "verified_true") {
    return {
      title: `✅ أم زكي · صار في شي واضح · ${symbol}`,
      body: `يا عيني، بعد ما دقّينا بالموضوع عن ${symbol} (${sourceLabel}): يبدو إن الخبر صار أوضح — ${summary.slice(0, 120)}. بس تذكّر: تعليمي، مو توصية تداول.`,
      direction: "up",
    };
  }
  if (status === "verified_false") {
    return {
      title: `❎ أم زكي · طراطيش وتبين ضعيف · ${symbol}`,
      body: `سمعيني منيح: اللي انقال عن ${symbol} (${sourceLabel}) ما تماسك مع التحقق — ${summary.slice(0, 120)}. تجاهل الضجيج بهدوء. تعليمي فقط.`,
      direction: "down",
    };
  }
  return {
    title: `⚪ أم زكي · لسا مو مأكّد · ${symbol}`,
    body: `والله يا عيني، دقّينا وما قدرنا نأكّد قصة ${symbol} (${sourceLabel}) لهلق. الوضع: غير مؤكد — ${summary.slice(0, 120)}. منبخترع شي. تعليمي فقط.`,
    direction: "neutral",
  };
}

function classifyVerify(n: NewsRow | null, rumorTitle: string): {
  status: "verified_true" | "verified_false" | "unverified";
  summary: string;
} {
  if (!n) {
    return {
      status: "unverified",
      summary: "ما لقينا مصدراً مادياً واضحاً يدعم أو ينفي الطرطشة.",
    };
  }
  const blob = `${n.title} ${n.summary || ""}`;
  if (RUMOR_RE.test(blob) || /unverified|unconfirmed|غير مؤكد/i.test(blob)) {
    return { status: "unverified", summary: n.title };
  }
  // إن وُجد خبر مادي لاحق بنفس الرمز بلا لغة إشاعة → نعتبره أوضح (تعليمي)
  if (n.is_material && n.impact === "negative") {
    return { status: "verified_true", summary: `خبر مادي أوضح (أثر محتمل سلبي تعليمياً): ${n.title}` };
  }
  if (n.is_material && n.impact === "positive") {
    return { status: "verified_true", summary: `خبر مادي أوضح (أثر محتمل إيجابي تعليمياً): ${n.title}` };
  }
  if (n.is_material) {
    return { status: "verified_true", summary: `تغطية أوضح ظهرت: ${n.title}` };
  }
  // إن العنوان يناقض بوضوح
  if (/deny|false|debunk|نفي|غير صحيح|شائعة كاذبة/i.test(blob)) {
    return { status: "verified_false", summary: n.title };
  }
  return {
    status: "unverified",
    summary: `ما اكتمل التحقق بشكل قاطع حول: ${rumorTitle.slice(0, 80)}`,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-notify-key");
  if (authFail) return authFail;

  try {
    const url = new URL(req.url);
    const minutes = Number(url.searchParams.get("minutes") || "180");
    const since = new Date(Date.now() - minutes * 60000).toISOString();
    const verifyAfterMin = Number(url.searchParams.get("verify_after_minutes") || "90");

    const [portfolioRows, pickRows, simSymbols] = await Promise.all([
      restSelect<OwnerRow>(SUPABASE_URL, SERVICE_ROLE_KEY, `user_portfolio_positions?select=user_id,symbol`),
      restSelect<PickRow>(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `screener_signals?select=symbol&entry_score=gte.2&order=entry_score.desc&limit=200`,
      ),
      loadSimulatorSymbols(SUPABASE_URL, SERVICE_ROLE_KEY),
    ]);

    const portfolioByUser = new Map<string, Set<string>>();
    const interestedSymbols = new Set<string>();
    for (const row of portfolioRows) {
      const sym = String(row.symbol || "").toUpperCase();
      if (!sym) continue;
      interestedSymbols.add(sym);
      if (!portfolioByUser.has(row.user_id)) portfolioByUser.set(row.user_id, new Set());
      portfolioByUser.get(row.user_id)!.add(sym);
    }
    const pickSet = new Set(pickRows.map((p) => String(p.symbol || "").toUpperCase()).filter(Boolean));
    for (const s of pickSet) interestedSymbols.add(s);
    for (const s of simSymbols) interestedSymbols.add(s);

    if (!interestedSymbols.size) {
      return jsonResponse({ ok: true, message: "لا رموز في النطاق (محفظة/محاكي/ترشيحات)" });
    }

    const symbolFilter = Array.from(interestedSymbols).slice(0, 300).map((s) => `"${s}"`).join(",");
    const news = await restSelect<NewsRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `company_news?select=id,symbol,title,summary,impact,is_material,published_at,source_name&symbol=in.(${symbolFilter})&published_at=gte.${since}&order=published_at.desc&limit=80`,
    );

    const prefsMap = await loadNotificationPrefs(SUPABASE_URL, SERVICE_ROLE_KEY);
    let buzzSent = 0;
    let verifySent = 0;
    let created = 0;

    // —— مرحلة 1: طراطيش جديدة ——
    for (const item of news) {
      const sym = String(item.symbol || "").toUpperCase();
      if (!interestedSymbols.has(sym) || !looksLikeRumor(item)) continue;
      const refBuzz = `buzz|${item.id}`;
      if (await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "um_zaki_buzz", refBuzz, minutes * 4)) {
        continue;
      }

      // أنشئ حدثاً إن لم يوجد لنفس الخبر
      const existing = await restSelect<RumorEvent>(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `um_zaki_rumor_events?select=id,symbol,rumor_summary,verify_status,source_news_id,created_at&source_news_id=eq.${item.id}&limit=1`,
      );
      let eventId = existing[0]?.id;
      if (!eventId) {
        const ok = await restInsert(SUPABASE_URL, SERVICE_ROLE_KEY, "um_zaki_rumor_events", [{
          symbol: sym,
          rumor_summary: item.title,
          buzz_notified_at: new Date().toISOString(),
          verify_status: "pending",
          source_news_id: item.id,
          source_label: item.source_name || null,
        }]);
        if (!ok) continue;
        created++;
        const again = await restSelect<RumorEvent>(
          SUPABASE_URL,
          SERVICE_ROLE_KEY,
          `um_zaki_rumor_events?select=id,symbol,rumor_summary,verify_status,source_news_id,created_at&source_news_id=eq.${item.id}&limit=1`,
        );
        eventId = again[0]?.id;
      }
      if (!eventId) continue;

      // المستلمون: من لديهم الرمز في محفظة أو (رمز محاكي/ترشيح → كل من فعّل أم زكي)
      const ownerIds = new Set<string>();
      for (const [uid, set] of portfolioByUser) {
        if (set.has(sym)) ownerIds.add(uid);
      }
      const devicesAll = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
      const byUser = groupDevicesByUser(devicesAll);
      for (const [userId, userDevices] of byUser) {
        const inPortfolio = Boolean(portfolioByUser.get(userId)?.has(sym));
        const inSimulator = simSymbols.has(sym);
        const inPicks = pickSet.has(sym);
        if (!inPortfolio && !inSimulator && !inPicks) continue;
        // إن لم يكن في محفظته، نرسل فقط إن الرمز في المحاكي أو الترشيحات (اهتمام عام للمنصة)
        const sourceLabel = umZakiSourceLabel({ inPortfolio, inSimulator, inPicks });
        const msg = shamiBuzz(sym, sourceLabel, item.title);
        const result = await sendCategorizedPush(
          SUPABASE_URL,
          SERVICE_ROLE_KEY,
          userDevices,
          prefsMap,
          "um_zaki",
          {
            title: msg.title,
            body: msg.body,
            url: "./#portfolio",
            tag: `az-umzaki-buzz-${sym}-${eventId}`,
            direction: "neutral",
            alertType: "um_zaki",
          },
        );
        buzzSent += result.sent;
      }
      await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "um_zaki_buzz", refBuzz);
    }

    // —— مرحلة 2: تحقق للأحداث المعلّقة ——
    const pending = await restSelect<RumorEvent>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `um_zaki_rumor_events?select=id,symbol,rumor_summary,verify_status,source_news_id,created_at&verify_status=eq.pending&order=created_at.asc&limit=40`,
    );
    const cutoff = Date.now() - verifyAfterMin * 60000;
    for (const ev of pending) {
      const createdAt = new Date(ev.created_at).getTime();
      if (!(createdAt > 0) || createdAt > cutoff) continue;
      const sym = String(ev.symbol || "").toUpperCase();
      const refVerify = `verify|${ev.id}`;
      if (await wasRecentlyNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "um_zaki_verify", refVerify, 24 * 60)) {
        continue;
      }

      // ابحث عن خبر لاحق أوضح لنفس الرمز (غير مصدر الطرطشة إن أمكن)
      const later = await restSelect<NewsRow>(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `company_news?select=id,symbol,title,summary,impact,is_material,published_at,source_name&symbol=eq.${encodeURIComponent(sym)}&published_at=gte.${ev.created_at}&order=published_at.desc&limit=8`,
      );
      const candidate =
        later.find((n) => n.id !== ev.source_news_id && n.is_material && !looksLikeRumor(n)) ||
        later.find((n) => n.id !== ev.source_news_id) ||
        null;
      const verdict = classifyVerify(candidate, ev.rumor_summary);

      await restUpdate(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `um_zaki_rumor_events?id=eq.${ev.id}`,
        {
          verify_status: verdict.status,
          verify_summary: verdict.summary,
          verify_notified_at: new Date().toISOString(),
        },
      );

      const devicesAll = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
      const byUser = groupDevicesByUser(devicesAll);
      for (const [userId, userDevices] of byUser) {
        const inPortfolio = Boolean(portfolioByUser.get(userId)?.has(sym));
        const inSimulator = simSymbols.has(sym);
        const inPicks = pickSet.has(sym);
        if (!inPortfolio && !inSimulator && !inPicks) continue;
        const sourceLabel = umZakiSourceLabel({ inPortfolio, inSimulator, inPicks });
        const msg = shamiVerify(sym, sourceLabel, verdict.status, verdict.summary);
        const result = await sendCategorizedPush(
          SUPABASE_URL,
          SERVICE_ROLE_KEY,
          userDevices,
          prefsMap,
          "um_zaki",
          {
            title: msg.title,
            body: msg.body,
            url: "./#portfolio",
            tag: `az-umzaki-verify-${sym}-${ev.id}`,
            direction: msg.direction,
            alertType: "um_zaki",
            requireInteraction: true,
          },
        );
        verifySent += result.sent;
      }
      await logNotified(SUPABASE_URL, SERVICE_ROLE_KEY, "um_zaki_verify", refVerify);
    }

    return jsonResponse({
      ok: true,
      scoped_symbols: interestedSymbols.size,
      events_created: created,
      buzz_push_sent: buzzSent,
      verify_push_sent: verifySent,
      dialect: "shami",
      educational_only: true,
    });
  } catch (err) {
    console.error("send-um-zaki-rumors error:", err);
    return jsonResponse({ error: "خطأ أثناء تشغيل أم زكي" }, 500);
  }
});
