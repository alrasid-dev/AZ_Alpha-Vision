// محرك المحاكي التعليمي — يُشغَّل من Cron على Render كل 10 دقائق
// حتى لا يعتمد التنفيذ على GitHub Actions المتقطع أو ساعات السوق فقط.
// محاكاة فقط: لا أموال حقيقية ولا أوامر وسيط.

const SIMULATION_ID = 'global';
const STARTING_CASH = 10000;
const MAX_OPEN_POSITIONS = 8;
const MAX_POSITION_PCT = 0.2;
const MAX_NEW_BUYS_PER_RUN = 3;
const MIN_CASH_RESERVE = 200;
const STOP_LOSS_PCT = -8;
const TRAILING_ACTIVATION_PCT = 20;
const TRAILING_STOP_PCT = 7;
const STRONG_TIERS = new Set(['صريح', 'مؤكد']);

function nyWeekday() {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(new Date());
  return weekday;
}

function isUsWeekday() {
  return !['Sat', 'Sun'].includes(nyWeekday());
}

async function runVirtualTraderEngine(db) {
  if (!db) throw new Error('قاعدة البيانات مطلوبة لتشغيل المحاكي');

  const { data: lastRun } = await db
    .from('virtual_trader_runs')
    .select('started_at')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastRun?.started_at && Date.now() - new Date(lastRun.started_at).getTime() < 8 * 60 * 1000) {
    return { skipped: true, message: 'المحاكي اشتغل خلال الدقائق الثماني الماضية' };
  }

  const { data: portfolios } = await db
    .from('shared_virtual_portfolios')
    .select('*')
    .eq('simulation_id', SIMULATION_ID)
    .limit(1);
  let cash = portfolios?.[0] ? Number(portfolios[0].cash) : STARTING_CASH;
  if (!portfolios?.[0]) {
    await db.from('shared_virtual_portfolios').upsert(
      [{ simulation_id: SIMULATION_ID, cash: STARTING_CASH }],
      { onConflict: 'simulation_id' },
    );
  }

  const { data: positions = [] } = await db
    .from('shared_virtual_positions')
    .select('*')
    .eq('simulation_id', SIMULATION_ID);

  if (!isUsWeekday()) {
    await db.from('virtual_trader_runs').insert({
      status: 'closed',
      market_open: false,
      candidate_count: 0,
      entry_candidates: 0,
      near_entries: 0,
      blocked_by_plan: 0,
      blocked_by_price: 0,
      run_note: `عطلة نهاية الأسبوع — المحاكي في وضع المراقبة فقط (${positions.length} مركز مفتوح).`,
    });
    return { ok: true, market_open: false, message: 'عطلة نهاية الأسبوع' };
  }

  const heldSymbols = (positions || []).map((p) => String(p.symbol || '').toUpperCase());

  const { data: entryRows = [] } = await db
    .from('screener_signals')
    .select('preset,symbol,company,price,entry_score,entry_tier')
    .gte('entry_score', 3)
    .order('entry_score', { ascending: false })
    .limit(120);

  const bestBySymbol = new Map();
  for (const row of entryRows || []) {
    const tier = String(row.entry_tier || '').trim();
    const score = Number(row.entry_score || 0);
    const strong = STRONG_TIERS.has(tier) || score >= 3;
    if (!strong) continue;
    const sym = String(row.symbol || '').toUpperCase();
    if (!sym) continue;
    const existing = bestBySymbol.get(sym);
    if (!existing || score > existing.entry_score) bestBySymbol.set(sym, { ...row, symbol: sym });
  }
  const candidates = Array.from(bestBySymbol.values())
    .filter((c) => !heldSymbols.includes(c.symbol))
    .sort((a, b) => Number(b.entry_score) - Number(a.entry_score));

  const allSymbols = [...new Set([...heldSymbols, ...candidates.map((c) => c.symbol)])];
  let liveQuotes = [];
  let technicals = [];
  if (allSymbols.length) {
    const [qRes, tRes] = await Promise.all([
      db.from('live_quotes').select('symbol,price,volume').in('symbol', allSymbols),
      db.from('market_technicals').select('symbol,price,rsi14,sma50,volume').in('symbol', allSymbols),
    ]);
    liveQuotes = qRes.data || [];
    technicals = tRes.data || [];
  }
  const priceMap = new Map();
  for (const t of technicals) if (t.price != null) priceMap.set(String(t.symbol).toUpperCase(), Number(t.price));
  for (const q of liveQuotes) if (q.price != null) priceMap.set(String(q.symbol).toUpperCase(), Number(q.price));
  const techMap = new Map(technicals.map((t) => [String(t.symbol).toUpperCase(), t]));

  const soldSymbols = new Set();
  const positionsToUpdate = [];
  const trades = [];
  let realizedPnl = 0;

  for (const pos of positions || []) {
    const sym = String(pos.symbol || '').toUpperCase();
    const currentPrice = priceMap.get(sym) ?? Number(pos.last_price) ?? Number(pos.entry_price);
    const entryPrice = Number(pos.entry_price);
    const qty = Number(pos.qty);
    const pctChange = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
    const tech = techMap.get(sym);
    const priorPeak = Number(pos.peak_price) > 0 ? Number(pos.peak_price) : entryPrice;
    const peakPrice = Math.max(priorPeak, currentPrice, entryPrice);
    const peakPct = entryPrice > 0 ? ((peakPrice - entryPrice) / entryPrice) * 100 : 0;
    const trailingArmed = peakPct >= TRAILING_ACTIVATION_PCT;
    const trailingStopPrice = peakPrice * (1 - TRAILING_STOP_PCT / 100);

    let exitReason = '';
    if (pctChange <= STOP_LOSS_PCT) {
      exitReason = `وقف خسارة تلقائي عند ${pctChange.toFixed(1)}%`;
    } else if (trailingArmed && currentPrice <= trailingStopPrice) {
      exitReason = `وقف خسارة متحرك (Trailing Stop) — تحقق ربح ${peakPct.toFixed(1)}% ثم تراجع ${TRAILING_STOP_PCT}% من القمة عند $${peakPrice.toFixed(2)}`;
    } else if (!trailingArmed && tech?.rsi14 != null && Number(tech.rsi14) >= 75) {
      exitReason = 'تشبع شرائي حاد (RSI ≥ 75) — إشارة خروج فنية';
    } else if (!trailingArmed && tech?.sma50 != null && currentPrice < Number(tech.sma50) * 0.97) {
      exitReason = 'كسر المتوسط المتحرك 50 يوم — إشارة خروج فنية';
    }

    if (exitReason) {
      const pnl = (currentPrice - entryPrice) * qty;
      realizedPnl += pnl;
      cash += currentPrice * qty;
      soldSymbols.add(sym);
      trades.push({
        simulation_id: SIMULATION_ID,
        symbol: sym,
        action: 'sell',
        qty,
        price: currentPrice,
        entry_price: entryPrice,
        tier: pos.entry_tier || 'Entry',
        pnl,
        reason: exitReason,
      });
    } else {
      positionsToUpdate.push({ symbol: sym, last_price: currentPrice, peak_price: peakPrice });
    }
  }

  if (soldSymbols.size) {
    await db
      .from('shared_virtual_positions')
      .delete()
      .eq('simulation_id', SIMULATION_ID)
      .in('symbol', Array.from(soldSymbols));
  }
  for (const upd of positionsToUpdate) {
    await db
      .from('shared_virtual_positions')
      .update({ last_price: upd.last_price, peak_price: upd.peak_price, updated_at: new Date().toISOString() })
      .eq('simulation_id', SIMULATION_ID)
      .eq('symbol', upd.symbol);
  }

  let openSlots = Math.max(0, MAX_OPEN_POSITIONS - ((positions || []).length - soldSymbols.size));
  let boughtCount = 0;
  let blockedByPlan = 0;
  let blockedByPrice = 0;
  const newPositions = [];

  for (const candidate of candidates) {
    const sym = candidate.symbol;
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
      reason: `دخول تلقائي (${candidate.preset}) — ${candidate.entry_tier || 'إشارة'} بقوة ${candidate.entry_score}/4`,
      entered_at: new Date().toISOString(),
    });
    trades.push({
      simulation_id: SIMULATION_ID,
      symbol: sym,
      action: 'buy',
      qty,
      price,
      tier: candidate.entry_tier,
      reason: `دخول تلقائي (${candidate.preset}) — قوة الإشارة ${candidate.entry_score}/4`,
    });
  }

  if (newPositions.length) {
    await db.from('shared_virtual_positions').upsert(newPositions, { onConflict: 'simulation_id,symbol' });
  }
  if (trades.length) {
    await db.from('shared_virtual_trades').insert(trades);
  }
  await db
    .from('shared_virtual_portfolios')
    .update({ cash, updated_at: new Date().toISOString() })
    .eq('simulation_id', SIMULATION_ID);

  const runNoteParts = [];
  if (boughtCount) runNoteParts.push(`تم تنفيذ ${boughtCount} صفقة شراء تلقائية`);
  if (soldSymbols.size) {
    runNoteParts.push(
      `تم إغلاق ${soldSymbols.size} صفقة (ربح/خسارة محقق: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}$)`,
    );
  }
  if (!runNoteParts.length) {
    runNoteParts.push(
      candidates.length
        ? 'لا صفقات جديدة هذه الجولة — المراكز الحالية أو حدود الخطة منعت دخولاً إضافياً'
        : 'لا توجد إشارات دخول قوية (درجة 3/4 فأعلى) كافية حالياً',
    );
  }
  const runNote = runNoteParts.join(' · ');

  await db.from('virtual_trader_runs').insert({
    status: 'ok',
    market_open: true,
    candidate_count: candidates.length,
    entry_candidates: boughtCount,
    near_entries: (entryRows || []).filter((r) => String(r.entry_tier || '').trim() === 'دخول').length,
    blocked_by_plan: blockedByPlan,
    blocked_by_price: blockedByPrice,
    run_note: runNote,
  });

  return {
    ok: true,
    bought: boughtCount,
    sold: soldSymbols.size,
    candidates: candidates.length,
    cash_remaining: Number(cash.toFixed(2)),
    run_note: runNote,
  };
}

module.exports = { runVirtualTraderEngine };
