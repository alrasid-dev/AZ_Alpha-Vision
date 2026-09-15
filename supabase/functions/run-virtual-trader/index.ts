// run-virtual-trader — محرك المحاكي المالي الحقيقي (Buy/Sell Engine)
// يُستدعى كل 15 دقيقة؛ التنفيذ الفعلي فقط خلال ساعات NYSE الممتدة
// (قبل التداول / الجلسة الرسمية / بعد التداول) مع وقوف تام في الإجازات وعطل نهاية الأسبوع.
// يراقب إشارات screener_signals لحظة بلحظة: إشارة دخول قوية ← شراء تلقائي فوري،
// إشارة/شرط خروج حقيقي على مركز مفتوح ← بيع تلقائي فوري + حساب الربح/الخسارة وتحديث المحفظة.
// محاكاة تعليمية بالكامل — لا أموال حقيقية ولا تنفيذ فعلي في أي وسيط.
// Balance sync: shared_virtual_* is the single source of truth (50k / 10% / 30% reserve / session gates).

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  restSelect,
  restInsert,
  restUpsert,
  restUpdate,
  restDelete,
  loadNotificationPrefs,
  sendCategorizedPush,
  filterTradableSymbols,
  isTradableCommonEquity,
} from "../_shared/push.ts";
import { getUsMarketClock } from "../_shared/usMarketHours.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SIMULATION_ID = "global";
const STARTING_CASH = 50000;
const MAX_OPEN_POSITIONS = 8;
const MAX_POSITION_PCT = 0.1; // ~10% من حقوق الملكية لكل فرصة — نفس app.js
const MAX_NEW_BUYS_PER_RUN = 3;
const CASH_RESERVE_PCT = 0.3; // احتفظ بنحو 30% نقداً للفرص الذهبية
const MIN_CASH_RESERVE = STARTING_CASH * CASH_RESERVE_PCT;
const STOP_LOSS_PCT = -8;
// بعد تحقيق ربح 20% من سعر الدخول يتحول المركز تلقائياً إلى وقف خسارة متحرك (Trailing Stop)
// بنسبة 7% من أعلى سعر تم بلوغه، بدل بيع فوري عند +20% فقط — لإتاحة الاستمرار في الربح
// مع حماية جزء كبير منه إن انعكس السعر.
const TRAILING_ACTIVATION_PCT = 20;
const TRAILING_STOP_PCT = 7;

interface PortfolioRow {
  simulation_id: string;
  cash: number;
}
interface PositionRow {
  simulation_id: string;
  symbol: string;
  qty: number;
  entry_price: number;
  last_price: number | null;
  peak_price: number | null;
  entry_tier: string | null;
  reason: string | null;
  entered_at: string;
}
interface SignalRow {
  preset: string;
  symbol: string;
  company: string | null;
  price: number | null;
  entry_score: number;
  entry_tier: string;
}
interface QuoteRow {
  symbol: string;
  price: number;
}
interface TechnicalRow {
  symbol: string;
  price: number | null;
  rsi14: number | null;
  sma50: number | null;
}

async function insertRunLog(stats: Record<string, unknown>): Promise<void> {
  await restInsert(SUPABASE_URL, SERVICE_ROLE_KEY, "virtual_trader_runs", [stats]);
}

async function logClosedIfNeeded(note: string): Promise<void> {
  const last = await restSelect<{ started_at: string; status: string; run_note: string | null }>(
    SUPABASE_URL,
    SERVICE_ROLE_KEY,
    "virtual_trader_runs?select=started_at,status,run_note&order=started_at.desc&limit=1",
  );
  const prev = last[0];
  const recentClosed =
    prev?.status === "closed" &&
    prev?.run_note === note &&
    prev?.started_at &&
    Date.now() - new Date(prev.started_at).getTime() < 4 * 60 * 60 * 1000;
  if (recentClosed) return;
  await insertRunLog({
    status: "closed",
    market_open: false,
    candidate_count: 0,
    entry_candidates: 0,
    near_entries: 0,
    blocked_by_plan: 0,
    blocked_by_price: 0,
    run_note: note,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-trader-key");
  if (authFail) return authFail;

  try {
    const clock = getUsMarketClock();
    const marketOpen = clock.tradable;

    const portfolios = await restSelect<PortfolioRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `shared_virtual_portfolios?select=*&simulation_id=eq.${SIMULATION_ID}&limit=1`,
    );
    let cash = portfolios[0] ? Number(portfolios[0].cash) : STARTING_CASH;
    if (!portfolios[0]) {
      await restUpsert(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        "shared_virtual_portfolios",
        [{ simulation_id: SIMULATION_ID, cash: STARTING_CASH }],
        "simulation_id",
      );
    }

    const positions = await restSelect<PositionRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `shared_virtual_positions?select=*&simulation_id=eq.${SIMULATION_ID}`,
    );

    // Reconcile cash vs trade ledger when desynced (stuck balance / orphan opens).
    // Policy: STARTING_CASH + sum(sell proceeds - buy costs) should match portfolio.cash.
    try {
      const ledgerTrades = await restSelect<{ action: string; qty: number; price: number }>(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `shared_virtual_trades?select=action,qty,price&simulation_id=eq.${SIMULATION_ID}&order=created_at.asc&limit=5000`,
      );
      if (ledgerTrades.length) {
        let rebuilt = STARTING_CASH;
        for (const t of ledgerTrades) {
          const q = Number(t.qty) || 0;
          const px = Number(t.price) || 0;
          if (t.action === "buy") rebuilt -= q * px;
          else if (t.action === "sell") rebuilt += q * px;
        }
        rebuilt = Math.max(0, Number(rebuilt.toFixed(2)));
        const drift = Math.abs(rebuilt - cash);
        // Only repair large drift (> $1) to avoid noisy float churn.
        if (drift > 1) {
          console.warn(`VT cash reconcile: db=${cash} rebuilt=${rebuilt} drift=${drift}`);
          cash = rebuilt;
          await restUpdate(
            SUPABASE_URL,
            SERVICE_ROLE_KEY,
            `shared_virtual_portfolios?simulation_id=eq.${SIMULATION_ID}`,
            { cash, updated_at: new Date().toISOString() },
          );
        }
      }
    } catch (reconErr) {
      console.warn("VT cash reconcile skipped:", reconErr);
    }

    if (!marketOpen) {
      // Mark-to-market last_price حتى خارج الجلسة (للواجهة / السجل)
      try {
        const held = positions.map((pos) => pos.symbol.toUpperCase()).filter(Boolean);
        if (held.length) {
          const symbolFilter = held.map((s) => `"${s}"`).join(",");
          const [liveQuotes, technicals] = await Promise.all([
            restSelect<QuoteRow>(SUPABASE_URL, SERVICE_ROLE_KEY, `live_quotes?select=symbol,price&symbol=in.(${symbolFilter})`),
            restSelect<TechnicalRow>(SUPABASE_URL, SERVICE_ROLE_KEY, `market_technicals?select=symbol,price,rsi14,sma50&symbol=in.(${symbolFilter})`),
          ]);
          const priceMap = new Map<string, number>();
          for (const t of technicals) if (t.price != null) priceMap.set(t.symbol.toUpperCase(), Number(t.price));
          for (const q of liveQuotes) if (q.price != null) priceMap.set(q.symbol.toUpperCase(), Number(q.price));
          for (const pos of positions) {
            const sym = pos.symbol.toUpperCase();
            const px = priceMap.get(sym);
            if (!(Number.isFinite(px) && (px as number) > 0)) continue;
            const peak = Math.max(Number(pos.peak_price) || 0, px as number, Number(pos.entry_price) || 0);
            await restUpdate(
              SUPABASE_URL,
              SERVICE_ROLE_KEY,
              `shared_virtual_positions?simulation_id=eq.${SIMULATION_ID}&symbol=eq.${encodeURIComponent(sym)}`,
              { last_price: px, peak_price: peak, updated_at: new Date().toISOString() },
            );
          }
        }
      } catch (mtmErr) {
        console.warn("VT closed-session MTM skipped:", mtmErr);
      }
      const note = `${clock.labelAr} — المحاكي متوقف تماماً (${positions.length} مركز مفتوح).`;
      await logClosedIfNeeded(note);
      return jsonResponse({
        ok: true,
        market_open: false,
        session: clock.session,
        message: clock.labelAr,
        mtm_refreshed: true,
      });
    }

    const heldSymbols = positions.map((p) => p.symbol.toUpperCase());

    // إشارات الدخول القوية الحالية (نفس الإشارات المعروضة أعلى تبويب "الماسح")
    const entryCandidatesRaw = await restSelect<SignalRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `screener_signals?select=preset,symbol,company,price,entry_score,entry_tier&entry_score=gte.3&order=entry_score.desc&limit=120`,
    );
    const nearEntryRows = await restSelect<{ symbol: string }>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `screener_signals?select=symbol&entry_tier=eq.${encodeURIComponent("دخول")}&limit=200`,
    );

    // أفضل إشارة فريدة لكل رمز (قد يظهر نفس الرمز في أكثر من قالب)
    const bestBySymbol = new Map<string, SignalRow>();
    for (const row of entryCandidatesRaw) {
      const sym = row.symbol.toUpperCase();
      const existing = bestBySymbol.get(sym);
      if (!existing || row.entry_score > existing.entry_score) bestBySymbol.set(sym, row);
    }
    // فلتر الأسهم القابلة للتداول وفق سياسة الأسهم العادية قبل الشراء
    const tradableSet = await filterTradableSymbols(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      Array.from(bestBySymbol.keys()),
    );
    const candidates = Array.from(bestBySymbol.values())
      .filter((c) => !heldSymbols.includes(c.symbol.toUpperCase()))
      .filter((c) => tradableSet.has(c.symbol.toUpperCase()))
      .filter((c) =>
        isTradableCommonEquity({
          symbol: c.symbol,
          company: c.company,
        })
      )
      .sort((a, b) => b.entry_score - a.entry_score);

    const allSymbols = Array.from(
      new Set([...heldSymbols, ...candidates.map((c) => c.symbol.toUpperCase())]),
    );
    const symbolFilter = allSymbols.map((s) => `"${s}"`).join(",");
    const [liveQuotes, technicals] = symbolFilter
      ? await Promise.all([
          restSelect<QuoteRow>(SUPABASE_URL, SERVICE_ROLE_KEY, `live_quotes?select=symbol,price&symbol=in.(${symbolFilter})`),
          restSelect<TechnicalRow>(SUPABASE_URL, SERVICE_ROLE_KEY, `market_technicals?select=symbol,price,rsi14,sma50&symbol=in.(${symbolFilter})`),
        ])
      : [[], []];
    const priceMap = new Map<string, number>();
    for (const t of technicals) if (t.price != null) priceMap.set(t.symbol.toUpperCase(), Number(t.price));
    for (const q of liveQuotes) if (q.price != null) priceMap.set(q.symbol.toUpperCase(), Number(q.price)); // الأسعار الحية أدق فتُطبَّق أخيراً فوق الفنية
    const techMap = new Map(technicals.map((t) => [t.symbol.toUpperCase(), t]));

    // ===== 1) منطق الخروج الحقيقي على المراكز المفتوحة =====
    const soldSymbols = new Set<string>();
    const positionsToUpdate: { symbol: string; last_price: number; peak_price: number }[] = [];
    const trades: Record<string, unknown>[] = [];
    let realizedPnl = 0;

    for (const pos of positions) {
      const sym = pos.symbol.toUpperCase();
      const currentPrice = priceMap.get(sym) ?? Number(pos.last_price) ?? Number(pos.entry_price);
      const entryPrice = Number(pos.entry_price);
      const qty = Number(pos.qty);
      const pctChange = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
      const tech = techMap.get(sym);

      // تتبّع أعلى سعر بلغه المركز منذ الدخول لحساب وقف الخسارة المتحرك.
      const priorPeak = Number(pos.peak_price) > 0 ? Number(pos.peak_price) : entryPrice;
      const peakPrice = Math.max(priorPeak, currentPrice, entryPrice);
      const peakPct = entryPrice > 0 ? ((peakPrice - entryPrice) / entryPrice) * 100 : 0;
      const trailingArmed = peakPct >= TRAILING_ACTIVATION_PCT;
      const trailingStopPrice = peakPrice * (1 - TRAILING_STOP_PCT / 100);

      let exitReason = "";
      if (pctChange <= STOP_LOSS_PCT) {
        exitReason = `وقف خسارة تلقائي عند ${pctChange.toFixed(1)}%`;
      } else if (trailingArmed && currentPrice <= trailingStopPrice) {
        exitReason = `وقف خسارة متحرك (Trailing Stop) — تحقق ربح ${peakPct.toFixed(1)}% ثم تراجع ${TRAILING_STOP_PCT}% من القمة عند $${peakPrice.toFixed(2)}`;
      } else if (!trailingArmed && tech?.rsi14 != null && tech.rsi14 >= 75) {
        exitReason = "تشبع شرائي حاد (RSI ≥ 75) — إشارة خروج فنية";
      } else if (!trailingArmed && tech?.sma50 != null && currentPrice < tech.sma50 * 0.97) {
        exitReason = "كسر المتوسط المتحرك 50 يوم — إشارة خروج فنية";
      }

      if (exitReason) {
        const pnl = (currentPrice - entryPrice) * qty;
        realizedPnl += pnl;
        cash += currentPrice * qty;
        soldSymbols.add(sym);
        trades.push({
          simulation_id: SIMULATION_ID,
          symbol: sym,
          action: "sell",
          qty,
          price: currentPrice,
          entry_price: entryPrice,
          tier: pos.entry_tier || "Entry",
          pnl,
          reason: exitReason,
        });
      } else {
        positionsToUpdate.push({ symbol: sym, last_price: currentPrice, peak_price: peakPrice });
      }
    }

    if (soldSymbols.size) {
      const filter = Array.from(soldSymbols).map((s) => `"${s}"`).join(",");
      await restDelete(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `shared_virtual_positions?simulation_id=eq.${SIMULATION_ID}&symbol=in.(${filter})`,
      );
    }
    for (const upd of positionsToUpdate) {
      await restUpdate(
        SUPABASE_URL,
        SERVICE_ROLE_KEY,
        `shared_virtual_positions?simulation_id=eq.${SIMULATION_ID}&symbol=eq.${encodeURIComponent(upd.symbol)}`,
        { last_price: upd.last_price, peak_price: upd.peak_price, updated_at: new Date().toISOString() },
      );
    }

    // ===== 2) منطق الدخول الحقيقي على إشارات جديدة =====
    const openSlotsAfterExits = MAX_OPEN_POSITIONS - (positions.length - soldSymbols.size);
    let openSlots = Math.max(0, openSlotsAfterExits);
    let boughtCount = 0;
    let blockedByPlan = 0;
    let blockedByPrice = 0;
    const newPositions: Record<string, unknown>[] = [];

    for (const candidate of candidates) {
      const sym = candidate.symbol.toUpperCase();
      if (soldSymbols.has(sym)) continue;
      if (boughtCount >= MAX_NEW_BUYS_PER_RUN || openSlots <= 0 || cash <= MIN_CASH_RESERVE) {
        blockedByPlan++;
        continue;
      }
      const price = priceMap.get(sym) ?? Number(candidate.price);
      if (!price || price <= 0) {
        blockedByPrice++;
        continue;
      }
      const openValue = positions
        .filter((p) => !soldSymbols.has(p.symbol.toUpperCase()))
        .reduce((sum, p) => sum + Number(p.qty) * (priceMap.get(p.symbol.toUpperCase()) ?? Number(p.last_price) ?? Number(p.entry_price)), 0);
      const equityNow = cash + openValue;
      const reserveFloor = Math.max(MIN_CASH_RESERVE, equityNow * CASH_RESERVE_PCT);
      const spendable = Math.max(0, cash - reserveFloor);
      const allocation = Math.min(equityNow * MAX_POSITION_PCT, spendable);
      const qty = Math.floor(allocation / price);
      if (qty < 1) {
        blockedByPrice++;
        continue;
      }
      cash -= qty * price;
      openSlots--;
      boughtCount++;
      newPositions.push({
        simulation_id: SIMULATION_ID,
        symbol: sym,
        qty,
        entry_price: price,
        last_price: price,
        peak_price: price,
        entry_tier: candidate.entry_tier,
        reason: `دخول تلقائي (${candidate.preset}) — ${candidate.entry_tier} بقوة ${candidate.entry_score}/4`,
        entered_at: new Date().toISOString(),
      });
      trades.push({
        simulation_id: SIMULATION_ID,
        symbol: sym,
        action: "buy",
        qty,
        price,
        tier: candidate.entry_tier,
        reason: `دخول تلقائي (${candidate.preset}) — قوة الإشارة ${candidate.entry_score}/4`,
      });
    }

    if (newPositions.length) {
      await restUpsert(SUPABASE_URL, SERVICE_ROLE_KEY, "shared_virtual_positions", newPositions, "simulation_id,symbol");
    }
    if (trades.length) {
      await restInsert(SUPABASE_URL, SERVICE_ROLE_KEY, "shared_virtual_trades", trades);
    }
    await restUpdate(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `shared_virtual_portfolios?simulation_id=eq.${SIMULATION_ID}`,
      { cash, updated_at: new Date().toISOString() },
    );

    const runNoteParts: string[] = [];
    if (boughtCount) runNoteParts.push(`تم تنفيذ ${boughtCount} صفقة شراء تلقائية`);
    if (soldSymbols.size) runNoteParts.push(`تم إغلاق ${soldSymbols.size} صفقة (ربح/خسارة محقق: ${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(2)}$)`);
    if (!runNoteParts.length) runNoteParts.push("لا صفقات جديدة هذه الجولة — لا توجد إشارات دخول/خروج قوية كافية");
    const runNote = `${clock.labelAr} · ${runNoteParts.join(" · ")}`;

    await insertRunLog({
      status: "ok",
      market_open: true,
      candidate_count: candidates.length,
      entry_candidates: boughtCount,
      near_entries: nearEntryRows.length,
      blocked_by_plan: blockedByPlan,
      blocked_by_price: blockedByPrice,
      run_note: runNote,
    });

    // إشعار فوري بعد كل شراء/بيع — فئة simulator_alerts مع احترام silent_mode والتفضيلات.
    let pushSent = 0;
    let pushFailed = 0;
    let pushSkipped = 0;
    if (trades.length) {
      try {
        const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
        const prefsMap = await loadNotificationPrefs(SUPABASE_URL, SERVICE_ROLE_KEY);
        const sessionAr =
          clock.session === "premarket"
            ? "ما قبل التداول"
            : clock.session === "afterhours"
              ? "بعد الإغلاق"
              : "الجلسة الرسمية";
        for (const t of trades.slice(0, 8)) {
          const sym = String(t.symbol || "").toUpperCase();
          const isBuy = t.action === "buy";
          const qty = Number(t.qty) || 0;
          const px = Number(t.price) || 0;
          const title = isBuy
            ? `🤖 المحاكي · شراء تعليمي ${sym}`
            : `🤖 المحاكي · بيع تعليمي ${sym}`;
          const pnlBit =
            !isBuy && t.pnl != null
              ? ` · نتيجة المحاكاة ${Number(t.pnl) >= 0 ? "+" : ""}${Number(t.pnl).toFixed(2)}$`
              : "";
          const body = isBuy
            ? `اشترى المحاكي ${qty} سهمًا من ${sym} عند $${px.toFixed(2)} في جلسة ${sessionAr}. محفظة تعليمية مشتركة فقط — ليست توصية ولا تنفيذًا حقيقيًا.`
            : `باع المحاكي ${qty} سهمًا من ${sym} عند $${px.toFixed(2)}${pnlBit} في جلسة ${sessionAr}. تعليمي فقط — راجع السجل في الرئيسية.`;
          const result = await sendCategorizedPush(
            SUPABASE_URL,
            SERVICE_ROLE_KEY,
            devices,
            prefsMap,
            "simulator",
            {
              title,
              body,
              url: "./#home",
              tag: `az-sim-${t.action}-${sym}-${Date.now()}`,
              direction: isBuy ? "up" : Number(t.pnl || 0) >= 0 ? "up" : "down",
              alertType: "simulator",
            },
          );
          pushSent += result.sent;
          pushFailed += result.failed;
          pushSkipped += result.skipped;
        }
      } catch (pushErr) {
        console.warn("VT simulator push skipped:", pushErr);
      }
    }

    return jsonResponse({
      ok: true,
      market_open: true,
      session: clock.session,
      bought: boughtCount,
      sold: soldSymbols.size,
      realized_pnl: Number(realizedPnl.toFixed(2)),
      cash_remaining: Number(cash.toFixed(2)),
      candidates: candidates.length,
      push_sent: pushSent,
      push_failed: pushFailed,
      push_skipped: pushSkipped,
      run_note: runNote,
    });
  } catch (err) {
    console.error("run-virtual-trader error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء تشغيل المحاكي" }, 500);
  }
});