// fetch-ohlc — returns daily OHLC for a ticker (Yahoo chart proxy + optional cache).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchYahoo(symbol: string, range = "6mo") {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 AZAlphaVisionEducationBot/1.0" },
  });
  if (!res.ok) throw new Error(`yahoo_${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("yahoo_empty");
  const ts: number[] = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((v) => v == null || !Number.isFinite(Number(v)))) continue;
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    bars.push({
      time: d,
      open: +Number(o).toFixed(4),
      high: +Number(h).toFixed(4),
      low: +Number(l).toFixed(4),
      close: +Number(c).toFixed(4),
      volume: q.volume?.[i] ?? null,
    });
  }
  return bars;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  let symbol = "";
  let range = "6mo";
  if (req.method === "GET") {
    const u = new URL(req.url);
    symbol = (u.searchParams.get("symbol") || "").toUpperCase().trim();
    range = u.searchParams.get("range") || "6mo";
  } else {
    try {
      const body = await req.json();
      symbol = String(body?.symbol || "").toUpperCase().trim();
      range = body?.range || "6mo";
    } catch {
      return json(400, { error: "invalid_json" });
    }
  }
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return json(400, { error: "invalid_symbol" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    // Prefer cache if fresh enough (>= 40 bars and newest bar within 3 days)
    const { data: cached } = await admin
      .from("market_ohlc_daily")
      .select("bar_date,open,high,low,close,volume")
      .eq("symbol", symbol)
      .order("bar_date", { ascending: true })
      .limit(200);
    const fresh =
      Array.isArray(cached) &&
      cached.length >= 40 &&
      cached[cached.length - 1]?.bar_date &&
      Date.now() - new Date(cached[cached.length - 1].bar_date).getTime() < 4 * 86400000;
    if (fresh) {
      return json(200, {
        symbol,
        source: "cache",
        bars: cached.map((b) => ({
          time: b.bar_date,
          open: Number(b.open),
          high: Number(b.high),
          low: Number(b.low),
          close: Number(b.close),
          volume: b.volume,
        })),
      });
    }

    const bars = await fetchYahoo(symbol, range);
    if (bars.length) {
      const rows = bars.map((b) => ({
        symbol,
        bar_date: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        updated_at: new Date().toISOString(),
      }));
      await admin.from("market_ohlc_daily").upsert(rows, { onConflict: "symbol,bar_date" });
    }
    return json(200, { symbol, source: "yahoo", bars });
  } catch (err) {
    console.error("fetch-ohlc error:", err);
    return json(502, { error: "fetch_failed", message: String((err as Error)?.message || err) });
  }
});
