// محرك المحاكي التعليمي — يُشغَّل من Cron على Render.
// التنفيذ فقط خلال ساعات السوق الأمريكي الرسمية الممتدة (نيويورك):
// قبل التداول 04:00–09:30، الجلسة 09:30–16:00، بعد التداول 16:00–20:00.
// وقوف تام في عطل نهاية الأسبوع والإجازات الرسمية NYSE/NASDAQ.
// محاكاة فقط: لا أموال حقيقية ولا أوامر وسيط.

const SIMULATION_ID = 'global';
const STARTING_CASH = 50000;
const MAX_OPEN_POSITIONS = 8;
const MAX_POSITION_PCT = 0.1;
const MAX_NEW_BUYS_PER_RUN = 3;
const CASH_RESERVE_PCT = 0.3;
const MIN_CASH_RESERVE = STARTING_CASH * CASH_RESERVE_PCT;


const webpush = (() => {
  try {
    return require('web-push');
  } catch {
    return null;
  }
})();

function configureVapid() {
  if (!webpush) return false;
  const pub =
    process.env.VAPID_PUBLIC_KEY ||
    'BNk6hCs1rlvB-_8NSo0cxXNLR964XlRSwVE6THODXYwST84y8OMfzY_EsIkwnpTzQV8c4XY_whs4C1SBaphooIM';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || 'mailto:azalphavision2026@gmail.com';
  if (!priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  return true;
}

/** إشعار فوري لفئة simulator_alerts بعد كل شراء/بيع — يحترم silent_mode. */
async function sendSimulatorTradePushes(db, trades, sessionLabelAr) {
  if (!trades?.length) return { sent: 0, failed: 0, skipped: 0 };
  if (!configureVapid()) {
    console.warn('VT(marketer): VAPID_PRIVATE_KEY غير معرّف — تخطي دفع المحاكي');
    return { sent: 0, failed: 0, skipped: 0 };
  }
  const { data: devices, error: dErr } = await db
    .from('notification_push_devices')
    .select('id,user_id,endpoint,push_subscription')
    .eq('push_enabled', true);
  if (dErr) {
    console.warn('VT(marketer) devices:', dErr.message);
    return { sent: 0, failed: 0, skipped: 0 };
  }
  if (!devices?.length) return { sent: 0, failed: 0, skipped: 0 };

  const userIds = [...new Set(devices.map((d) => d.user_id).filter(Boolean))];
  const prefsByUser = new Map();
  if (userIds.length) {
    const { data: prefsRows } = await db
      .from('notification_subscriptions')
      .select('user_id,simulator_alerts_enabled,silent_mode')
      .in('user_id', userIds);
    for (const row of prefsRows || []) {
      prefsByUser.set(row.user_id, {
        simulator_alerts_enabled: row.simulator_alerts_enabled !== false,
        silent_mode: Boolean(row.silent_mode),
      });
    }
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of trades.slice(0, 8)) {
    const sym = String(t.symbol || '').toUpperCase();
    const isBuy = t.action === 'buy';
    const qty = Number(t.qty) || 0;
    const px = Number(t.price) || 0;
    const title = isBuy
      ? `🤖 المحاكي · شراء تعليمي ${sym}`
      : `🤖 المحاكي · بيع تعليمي ${sym}`;
    const pnlBit =
      !isBuy && t.pnl != null
        ? ` · نتيجة المحاكاة ${Number(t.pnl) >= 0 ? '+' : ''}${Number(t.pnl).toFixed(2)}$`
        : '';
    const body = isBuy
      ? `اشترى المحاكي ${qty} سهمًا من ${sym} عند $${px.toFixed(2)} في جلسة ${sessionLabelAr}. محفظة تعليمية مشتركة فقط — ليست توصية ولا تنفيذًا حقيقيًا.`
      : `باع المحاكي ${qty} سهمًا من ${sym} عند $${px.toFixed(2)}${pnlBit} في جلسة ${sessionLabelAr}. تعليمي فقط — راجع السجل في الرئيسية.`;
    const payload = {
      title,
      body,
      url: './#home',
      tag: `az-sim-${t.action}-${sym}-${Date.now()}`,
      direction: isBuy ? 'up' : Number(t.pnl || 0) >= 0 ? 'up' : 'down',
      alertType: 'simulator',
    };

    const byUser = new Map();
    for (const d of devices) {
      if (!d.user_id || !d.push_subscription?.endpoint) continue;
      if (!byUser.has(d.user_id)) byUser.set(d.user_id, []);
      byUser.get(d.user_id).push(d);
    }
    for (const [userId, userDevices] of byUser) {
      const prefs = prefsByUser.get(userId) || {
        simulator_alerts_enabled: true,
        silent_mode: false,
      };
      if (!prefs.simulator_alerts_enabled) {
        skipped += userDevices.length;
        continue;
      }
      const silent = prefs.silent_mode;
      await Promise.all(
        userDevices.map(async (device) => {
          try {
            await webpush.sendNotification(
              device.push_subscription,
              JSON.stringify({ ...payload, silent }),
            );
            sent += 1;
          } catch (err) {
            failed += 1;
            const status = err?.statusCode || err?.status;
            if (status === 404 || status === 410) {
              try {
                await db
                  .from('notification_push_devices')
                  .update({ push_enabled: false })
                  .eq('id', device.id);
              } catch (_) {
                /* ignore prune errors */
              }
            }
          }
        }),
      );
    }
  }
  return { sent, failed, skipped };
}


async function reconcileCashFromTrades(db, cash) {
  try {
    const { data: ledgerTrades } = await db
      .from('shared_virtual_trades')
      .select('action,qty,price')
      .eq('simulation_id', SIMULATION_ID)
      .order('created_at', { ascending: true })
      .limit(5000);
    if (!ledgerTrades?.length) return cash;
    let rebuilt = STARTING_CASH;
    for (const t of ledgerTrades) {
      const q = Number(t.qty) || 0;
      const px = Number(t.price) || 0;
      if (t.action === 'buy') rebuilt -= q * px;
      else if (t.action === 'sell') rebuilt += q * px;
    }
    rebuilt = Math.max(0, Number(rebuilt.toFixed(2)));
    if (Math.abs(rebuilt - cash) > 1) {
      console.warn(`VT(marketer) cash reconcile: db=${cash} rebuilt=${rebuilt}`);
      await db.from('shared_virtual_portfolios').update({ cash: rebuilt, updated_at: new Date().toISOString() }).eq('simulation_id', SIMULATION_ID);
      return rebuilt;
    }
  } catch (err) {
    console.warn('VT(marketer) reconcile skipped', err?.message || err);
  }
  return cash;
}

const STOP_LOSS_PCT = -8;
const TRAILING_ACTIVATION_PCT = 20;
const TRAILING_STOP_PCT = 7;
const STRONG_TIERS = new Set(['صريح', 'مؤكد']);

const { getUsMarketClock } = require('./usMarketHours');

async function runVirtualTraderEngine(db) {
  if (!db) throw new Error('قاعدة البيانات مطلوبة لتشغيل المحاكي');

  const { data: lastRun } = await db
    .from('virtual_trader_runs')
    .select('started_at,status,run_note')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    lastRun?.status !== 'closed' &&
    lastRun?.started_at &&
    Date.now() - new Date(lastRun.started_at).getTime() < 8 * 60 * 1000
  ) {
    return { skipped: true, message: 'المحاكي اشتغل خلال الدقائق الثماني الماضية' };
  }

  const { data: portfolios } = await db
    .from('shared_virtual_portfolios')
    .select('*')
    .eq('simulation_id', SIMULATION_ID)
    .limit(1);
  let cash = portfolios?.[0] ? Number(portfolios[0].cash) : STARTING_CASH;
  cash = await reconcileCashFromTrades(db, cash);
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

  const clock = getUsMarketClock();
  if (!clock.tradable) {
    // حتى خارج الجلسة: حدّث last_price من live_quotes حتى تظهر الواجهة ربحاً عائماً صحيحاً
    try {
      const held = (positions || [])
        .map((pos) => String(pos.symbol || '').toUpperCase())
        .filter(Boolean);
      if (held.length) {
        const [{ data: quotes }, { data: tech }] = await Promise.all([
          db.from('live_quotes').select('symbol,price').in('symbol', held),
          db.from('market_technicals').select('symbol,price').in('symbol', held),
        ]);
        const priceMap = new Map();
        for (const row of tech || []) {
          if (row?.price != null) priceMap.set(String(row.symbol).toUpperCase(), Number(row.price));
        }
        for (const row of quotes || []) {
          if (row?.price != null) priceMap.set(String(row.symbol).toUpperCase(), Number(row.price));
        }
        for (const pos of positions || []) {
          const sym = String(pos.symbol || '').toUpperCase();
          const px = priceMap.get(sym);
          if (!(Number.isFinite(px) && px > 0)) continue;
          const peak = Math.max(Number(pos.peak_price) || 0, px, Number(pos.entry_price) || 0);
          await db
            .from('shared_virtual_positions')
            .update({ last_price: px, peak_price: peak, updated_at: new Date().toISOString() })
            .eq('simulation_id', SIMULATION_ID)
            .eq('symbol', sym);
        }
      }
    } catch (mtmErr) {
      console.warn('VT(marketer) closed-session MTM skipped:', mtmErr?.message || mtmErr);
    }
    const note = `${clock.labelAr} — المحاكي متوقف تماماً (${positions.length} مركز مفتوح).`;
    const sameClosedRecently =
      lastRun?.status === 'closed' &&
      lastRun?.run_note === note &&
      lastRun?.started_at &&
      Date.now() - new Date(lastRun.started_at).getTime() < 4 * 60 * 60 * 1000;
    if (!sameClosedRecently) {
      await db.from('virtual_trader_runs').insert({
        status: 'closed',
        market_open: false,
        candidate_count: 0,
        entry_candidates: 0,
        near_entries: 0,
        blocked_by_plan: 0,
        blocked_by_price: 0,
        run_note: note,
      });
    }
    return { ok: true, market_open: false, session: clock.session, message: clock.labelAr };
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
    const openValue = positions
      .filter((p) => !soldSymbols.has(String(p.symbol).toUpperCase()))
      .reduce((sum, p) => sum + Number(p.qty) * (priceMap.get(String(p.symbol).toUpperCase()) ?? Number(p.last_price) ?? Number(p.entry_price)), 0);
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
  const runNote = `${clock.labelAr} · ${runNoteParts.join(' · ')}`;

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

  const sessionAr =
    clock.session === 'premarket'
      ? 'ما قبل التداول'
      : clock.session === 'afterhours'
        ? 'بعد الإغلاق'
        : 'الجلسة الرسمية';
  let pushStats = { sent: 0, failed: 0, skipped: 0 };
  try {
    pushStats = await sendSimulatorTradePushes(db, trades, sessionAr);
  } catch (err) {
    console.warn('VT(marketer) push error:', err?.message || err);
  }

  return {
    ok: true,
    market_open: true,
    session: clock.session,
    bought: boughtCount,
    sold: soldSymbols.size,
    candidates: candidates.length,
    cash_remaining: Number(cash.toFixed(2)),
    push_sent: pushStats.sent,
    push_failed: pushStats.failed,
    push_skipped: pushStats.skipped,
    run_note: runNote,
  };
}

module.exports = { runVirtualTraderEngine, getUsMarketClock };