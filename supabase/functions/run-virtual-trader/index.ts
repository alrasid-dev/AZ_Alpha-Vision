// run-virtual-trader — محرك المحاكي المالي الحقيقي (Buy/Sell Engine)
// يُستدعى كل 15 دقيقة أيام العمل عبر .github/workflows/virtual_trader.yml
// يراقب إشارات screener_signals لحظة بلحظة: إشارة دخول قوية ← شراء تلقائي فوري،
// إشارة/شرط خروج حقيقي على مركز مفتوح ← بيع تلقائي فوري + حساب الربح/الخسارة وتحديث المحفظة.
// محاكاة تعليمية بالكامل — لا أموال حقيقية ولا تنفيذ فعلي في أي وسيط.

import {
  CORS_HEADERS,
  jsonResponse,
  checkRunKey,
  fetchActiveDevices,
  sendPushToDevices,
  restSelect,
  restInsert,
  restUpsert,
  restUpdate,
  restDelete,
} from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SIMULATION_ID = "global";
const STARTING_CASH = 10000;
const MAX_OPEN_POSITIONS = 8;
const MAX_POSITION_PCT = 0.2; // نفس VIRTUAL_MAX_POSITION_PCT في app.js
const MAX_NEW_BUYS_PER_RUN = 3;
const MIN_CASH_RESERVE = 200;
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

function isMarketOpen(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekday = map.weekday || "";
  const minutesSinceMidnight = Number(map.hour) * 60 + Number(map.minute);
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const afterOpen = minutesSinceMidnight >= 9 * 60 + 30;
  const beforeClose = minutesSinceMidnight < 16 * 60;
  return isWeekday && afterOpen && beforeClose;
}

async function insertRunLog(stats: Record<string, unknown>): Promise<void> {
  await restInsert(SUPABASE_URL, SERVICE_ROLE_KEY, "virtual_trader_runs", [stats]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const authFail = checkRunKey(req, "NOTIFY_RUN_KEY", "x-trader-key");
  if (authFail) return authFail;

  try {
    const marketOpen = isMarketOpen();

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

    if (!marketOpen) {
      await insertRunLog({
        status: "closed",
        market_open: false,
        candidate_count: 0,
        entry_candidates: 0,
        near_entries: 0,
        blocked_by_plan: 0,
        blocked_by_price: 0,
        run_note: `السوق الأمريكي مغلق حالياً — المحاكي في وضع المراقبة فقط (${positions.length} مركز مفتوح).`,
      });
      return jsonResponse({ ok: true, market_open: false, message: "السوق مغلق؛ لا تنفيذ صفقات في هذه الجولة" });
    }

    const heldSymbols = positions.map((p) => p.symbol.toUpperCase());

    // إشارات الدخول القوية الحالية (نفس الإشارات المعروضة أعلى تبويب "الماسح")
    const entryCandidatesRaw = await restSelect<SignalRow>(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      `screener_signals?select=preset,symbol,company,price,entry_score,entry_tier&entry_tier=in.(${encodeURIComponent("صريح")},${encodeURIComponent("مؤكد")})&order=entry_score.desc&limit=80`,
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
    const candidates = Array.from(bestBySymbol.values())
      .filter((c) => !heldSymbols.includes(c.symbol.toUpperCase()))
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
      const allocation = Math.min(cash * MAX_POSITION_PCT, cash - MIN_CASH_RESERVE);
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
    const runNote = runNoteParts.join(" · ");

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

    if (trades.length) {
      const devices = await fetchActiveDevices(SUPABASE_URL, SERVICE_ROLE_KEY);
      const buys = trades.filter((t) => t.action === "buy");
      const sells = trades.filter((t) => t.action === "sell");
      const lines: string[] = [];
      if (buys.length) lines.push(`شراء: ${buys.map((t) => t.symbol).join("، ")}`);
      if (sells.length) lines.push(`بيع: ${sells.map((t) => t.symbol).join("، ")}`);
      await sendPushToDevices(SUPABASE_URL, SERVICE_ROLE_KEY, devices, {
        title: "🤖 المحاكي نفّذ صفقات تلقائية",
        body: lines.join(" | "),
        url: "./#portfolio",
        tag: "az-virtual-trade",
        alertType: "trade",
      });
    }

    return jsonResponse({
      ok: true,
      market_open: true,
      bought: boughtCount,
      sold: soldSymbols.size,
      realized_pnl: Number(realizedPnl.toFixed(2)),
      cash_remaining: Number(cash.toFixed(2)),
      candidates: candidates.length,
      run_note: runNote,
    });
  } catch (err) {
    console.error("run-virtual-trader error:", err);
    return jsonResponse({ error: "خطأ غير متوقع أثناء تشغيل المحاكي" }, 500);
  }
});
