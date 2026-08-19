"""
fetch_screener_signals.py — محرك الماسح، يكتب داخل Supabase مباشرة بدل ملفات JSON محلية،
ليقرأه AZ Alpha Vision كجزء من نفس التطبيق (لا موقع منفصل).

يعتمد بالضبط نفس المنطق المُختبَر من fetch_data.py (فلاتر Finviz الأربعة الحقيقية،
مؤشرات فنية حقيقية عبر yfinance، محرّك توافق 4 إشارات، تصعيد تنبيهات، حاسبة أداء)
— فقط طبقة الحفظ تغيّرت: من ملفات JSON محلية إلى جداول screener_signals/screener_alerts/
screener_performance/screener_charts على Supabase.

⚠️ لم يُختبر مقابل Finviz/yfinance/Supabase الحيّين (بيئة الكتابة لا تصل لتلك الشبكات).
شغّله يدويًا أولًا وراقب السجلات.
"""
import os
import json
import sys
import time
import logging
from pathlib import Path

import pandas as pd
import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).parent))
from indicators import compute_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).parent.parent / "config" / "filters.json"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    log.error("SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير موجودين في متغيرات البيئة")
    sys.exit(1)

EXCLUDED_SYMBOLS = {
    'DDV', 'CCDE', 'CCODA', 'AASYS', 'CCRSR', 'AAI', 'AAIRG', 'AAMRZ', 'AAOUT', 'AAPEI', 'BBKKT',
    'USAU', 'AATEN', 'NNHP', 'SSWV', 'NNRDS', 'HHYMC', 'RRTB', 'CCLMB', 'XMAX', 'OCC',
}

SB_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}


def sb_select(table, params=""):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=SB_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_upsert(table, rows, on_conflict):
    if not rows:
        return 0
    headers = {**SB_HEADERS, "Prefer": "resolution=merge-duplicates"}
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={on_conflict}",
                       headers=headers, data=json.dumps(rows, default=str), timeout=30)
    if r.status_code not in (200, 201):
        log.error(f"{table}: فشل upsert: {r.status_code} {r.text[:300]}")
        return 0
    return len(rows)


def sb_insert(table, rows):
    if not rows:
        return 0
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=SB_HEADERS,
                       data=json.dumps(rows, default=str), timeout=30)
    if r.status_code not in (200, 201):
        log.error(f"{table}: فشل insert: {r.status_code} {r.text[:300]}")
        return 0
    return len(rows)



def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def is_excluded(sector, industry, cfg):
    if sector in cfg["excluded_sectors"]:
        allowed = cfg.get("allowed_industries_under_excluded_sector", {}).get(sector, [])
        return industry not in allowed
    return industry in cfg.get("excluded_industries", [])


def fetch_preset_tickers(preset_key, preset_cfg, cfg):
    """يجلب من Finviz الأسهم المطابقة لفلتر واحد فعليًا، ثم يطبّق الاستبعاد القطاعي والسعر الدقيق محليًا."""
    from finvizfinance.screener.overview import Overview

    filters_dict = {
        "Country": cfg["country"],
        "Price": "$5 to $50",  # لا يوجد خيار "$5 إلى $30" مباشر في Finviz — نطاق آمن أوسع ثم فلترة دقيقة بالكود
    }
    filters_dict.update(preset_cfg["finviz_filters"])

    log.info(f"[{preset_key}] فلاتر Finviz: {filters_dict}")
    ov = Overview()
    try:
        ov.set_filter(filters_dict=filters_dict)
    except ValueError as e:
        log.error(f"[{preset_key}] قيمة فلتر غير صالحة — راجع القيم في config/filters.json: {e}")
        return pd.DataFrame()

    df = ov.screener_view()
    if df is None or df.empty:
        log.warning(f"[{preset_key}] لا نتائج من Finviz")
        return pd.DataFrame()

    if "Ticker" not in df.columns:
        log.warning(f"[{preset_key}] لا يوجد عمود Ticker — تجاهل الفلتر")
        return pd.DataFrame()
    df["Ticker"] = df["Ticker"].astype(str).str.strip().str.upper()
    df = df[~df["Ticker"].isin(EXCLUDED_SYMBOLS)].copy()
    df["Price"] = pd.to_numeric(df["Price"], errors="coerce")
    price_min, price_max = cfg["price"]["min"], cfg["price"]["max"]
    override = preset_cfg.get("price_override")
    if override:  # تقاطع النطاقين: الأكثر تقييدًا من الجانبين، لا استبدال كامل
        price_min = max(price_min, override.get("min", price_min))
        price_max = min(price_max, override.get("max", price_max))
    df = df[(df["Price"] >= price_min) & (df["Price"] <= price_max)].copy()

    df = df[~df.apply(lambda r: is_excluded(str(r.get("Sector", "")), str(r.get("Industry", "")), cfg), axis=1)]

    log.info(f"[{preset_key}] بعد فلترة السعر والقطاع: {len(df)} سهم")
    return df


def fetch_technicals(tickers):
    """يجلب المؤشرات، ويتجاهل الرموز المنتهية أو التي لا تعيد بيانات."""
    import yfinance as yf
    results, charts = {}, {}
    skipped = []
    chunk_size = 25
    chart_days = 180

    for i in range(0, len(tickers), chunk_size):
        chunk = [t for t in tickers[i:i + chunk_size] if t not in EXCLUDED_SYMBOLS]
        if not chunk:
            continue
        log.info(f"yfinance دفعة {i // chunk_size + 1}: {len(chunk)} سهم")
        data = None
        for attempt in range(1, 4):
            try:
                # التشغيل المتسلسل يمنع قفل cache المحلي في GitHub Actions.
                data = yf.download(chunk, period="1y", group_by="ticker", threads=False,
                                   auto_adjust=False, progress=False, timeout=60)
                if data is not None and not data.empty:
                    break
            except Exception as exc:
                log.warning(f"فشلت دفعة yfinance ({attempt}/3): {exc}")
            time.sleep(5 * attempt)
        if data is None or data.empty:
            skipped.extend(chunk)
            log.warning(f"تخطي دفعة كاملة بعد 3 محاولات: {chunk[:5]}")
            continue

        for ticker in chunk:
            try:
                if len(chunk) > 1:
                    if not hasattr(data, "columns") or ticker not in data.columns.get_level_values(0):
                        skipped.append(ticker)
                        continue
                    df_t = data[ticker].dropna(how="all")
                else:
                    df_t = data.dropna(how="all")
                if df_t.empty or len(df_t) < 30 or "Close" not in df_t.columns:
                    skipped.append(ticker)
                    continue
                ind = compute_all(df_t)
                last, prev = df_t.iloc[-1], df_t.iloc[-2] if len(df_t) > 1 else df_t.iloc[-1]
                price = float(last["Close"])
                if not np.isfinite(price) or price <= 0:
                    skipped.append(ticker)
                    continue
                prev_close = float(prev["Close"]) if pd.notna(prev["Close"]) else price
                vol = int(last["Volume"]) if pd.notna(last["Volume"]) else 0
                avg_vol = int(df_t["Volume"].tail(20).mean()) if len(df_t) >= 5 else vol
                results[ticker] = {
                    "price": round(price, 2),
                    "change": round(((price - prev_close) / prev_close) * 100, 2) if prev_close else 0.0,
                    "volume": vol, "avgVolume": avg_vol,
                    "relVolume": round(vol / avg_vol, 2) if avg_vol else 1.0,
                    **ind,
                }
                chart_df = df_t.tail(chart_days)
                charts[ticker] = [[idx.strftime("%Y-%m-%d"), round(float(r["Open"]), 2),
                                   round(float(r["High"]), 2), round(float(r["Low"]), 2),
                                   round(float(r["Close"]), 2)] for idx, r in chart_df.iterrows()]
            except Exception as exc:
                skipped.append(ticker)
                log.warning(f"تخطي {ticker} — لا بيانات قابلة للمعالجة: {exc}")
        time.sleep(1)
    log.info(f"تم تخطي {len(set(skipped))} رمزًا بلا بيانات أو منتهيًا؛ نجح {len(results)} رمزًا")
    return results, charts


def evaluate_signals(stock, df_t):
    """4 إشارات لكل اتجاه (دخول/خروج): فيبوناتشي، SMC+CCI/ATR، شمعة يابانية، حجم.
    يرجع درجة (0-4) ودرجة تنبيه (أولي/أقوى/صريح) لكل من الدخول والخروج."""
    cci = stock.get("cci")
    atr_lower = stock.get("atrBandLower")
    atr_upper = stock.get("atrBandUpper")
    smc = stock.get("smcStructure")
    price = stock.get("price")
    fib_high = stock.get("fibHigh")
    fib_low = stock.get("fibLow")
    change = stock.get("change")
    rel_vol = stock.get("relVolume")

    fib_ratio = None
    if fib_high is not None and fib_low is not None and fib_high != fib_low and price is not None:
        fib_ratio = (price - fib_low) / (fib_high - fib_low)

    bullish = {
        "fibonacci": fib_ratio is not None and 0.382 <= fib_ratio <= 0.786,
        "smc_atr": bool(cci is not None and cci > 0 and atr_lower is not None and price is not None
                         and price > atr_lower and smc in ("Bullish_BOS", "Bullish_CHoCH")),
        "candlestick": bool(stock.get("bullishCandle")),
        "volume": bool(rel_vol is not None and rel_vol > 1.5 and change is not None and change > 0),
    }
    bearish = {
        "fibonacci": fib_ratio is not None and fib_ratio < 0.236,
        "smc_atr": bool(cci is not None and cci < 0 and atr_upper is not None and price is not None
                         and price < atr_upper and smc in ("Bearish_BOS", "Bearish_CHoCH")),
        "candlestick": bool(stock.get("bearishCandle")),
        "volume": bool(rel_vol is not None and rel_vol > 1.5 and change is not None and change < 0),
    }

    def tier(score):
        if score >= 4:
            return "صريح"
        if score >= 3:
            return "أقوى"
        if score >= 2:
            return "أولي"
        return None

    entry_score = sum(bullish.values())
    exit_score = sum(bearish.values())

    return {
        "entryScore": entry_score, "entryTier": tier(entry_score), "entrySignals": bullish,
        "exitScore": exit_score, "exitTier": tier(exit_score), "exitSignals": bearish,
        "fibRatio": round(fib_ratio, 3) if fib_ratio is not None else None,
    }


TIER_RANK = {None: 0, "أولي": 1, "أقوى": 2, "صريح": 3}


def load_previous_tiers():
    """يقرأ آخر حالة معروفة لكل (فلتر، رمز) من جدول screener_signals — هو نفسه مخزن الحالة، لا حاجة لجدول منفصل."""
    try:
        rows = sb_select("screener_signals", "select=preset,symbol,entry_tier,exit_tier")
        return {f"{r['preset']}:{r['symbol']}": {"entryTier": r["entry_tier"], "exitTier": r["exit_tier"]}
                for r in rows}
    except Exception as e:
        log.warning(f"تعذرت قراءة الحالة السابقة ({e}) — ستُعامَل كل الأسهم كأول ظهور")
        return {}


def compute_new_alerts(prev_tiers, preset_key, stock):
    """يُطلق تنبيهًا جديدًا فقط عند تصعيد الدرجة (أولي→أقوى→صريح) أو أول ظهور، لتفادي تكرار
    نفس التنبيه في كل تشغيل مجدول طالما الوضع لم يتغيّر. يرجع قائمة صفوف جاهزة للإدراج."""
    key = f"{preset_key}:{stock['symbol']}"
    prev = prev_tiers.get(key, {})
    now = pd.Timestamp.utcnow().isoformat()
    new_alerts = []

    if TIER_RANK[stock["entryTier"]] > TIER_RANK.get(prev.get("entryTier")):
        new_alerts.append({
            "ts": now, "preset": preset_key, "symbol": stock["symbol"],
            "type": "entry", "tier": stock["entryTier"], "score": stock["entryScore"],
            "price": stock["price"], "signals": stock["entrySignals"],
        })
    if TIER_RANK[stock["exitTier"]] > TIER_RANK.get(prev.get("exitTier")):
        new_alerts.append({
            "ts": now, "preset": preset_key, "symbol": stock["symbol"],
            "type": "exit", "tier": stock["exitTier"], "score": stock["exitScore"],
            "price": stock["price"], "signals": stock["exitSignals"],
        })
    return new_alerts


def build_preset_output(preset_key, df_fund, technicals, prev_tiers):
    stocks, all_new_alerts = [], []
    for _, row in df_fund.iterrows():
        t = row["Ticker"]
        tech = technicals.get(t)
        if not tech:
            continue
        stock = {
            "symbol": t,
            "company": row.get("Company"),
            "sector": row.get("Sector"),
            "industry": row.get("Industry"),
            "pe": pd.to_numeric(row.get("P/E"), errors="coerce"),
            **tech,
        }
        stock.update(evaluate_signals(stock, None))
        all_new_alerts.extend(compute_new_alerts(prev_tiers, preset_key, stock))
        if stock["entryTier"] is not None:  # على الأقل "أولي" (إشارتان من أربع)
            stocks.append(stock)

    stocks.sort(key=lambda s: (s["entryScore"], s.get("cci") or 0), reverse=True)
    return stocks[:7], all_new_alerts


def compute_performance(alerts_data):
    """يحاكي الأداء: كل تنبيه دخول أقوى/صريح = شراء وهمي، يُقفل عند أول تنبيه خروج تالٍ لنفس
    (فلتر+رمز). الصفقات غير المُقفلة بعد لا تُحتسب ضمن الأداء المحقَّق (تُعرض منفصلة)."""
    from collections import defaultdict

    by_key = defaultdict(list)
    for a in alerts_data["alerts"]:
        by_key[(a["preset"], a["symbol"])].append(a)

    trades, open_positions = [], []
    for (preset, symbol), alerts in by_key.items():
        alerts_sorted = sorted(alerts, key=lambda a: a["timestamp"])
        open_trade = None
        for a in alerts_sorted:
            if a["type"] == "entry" and a["tier"] in ("أقوى", "صريح") and open_trade is None:
                open_trade = {"preset": preset, "symbol": symbol, "entryTime": a["timestamp"],
                              "entryPrice": a["price"], "entryTier": a["tier"]}
            elif a["type"] == "exit" and open_trade is not None:
                open_trade["exitTime"] = a["timestamp"]
                open_trade["exitPrice"] = a["price"]
                open_trade["exitTier"] = a["tier"]
                open_trade["returnPct"] = round(
                    ((a["price"] - open_trade["entryPrice"]) / open_trade["entryPrice"]) * 100, 2)
                trades.append(open_trade)
                open_trade = None
        if open_trade is not None:
            open_positions.append(open_trade)

    def period_bucket(iso_ts, granularity):
        dt = pd.Timestamp(iso_ts)
        if granularity == "month":
            return f"{dt.year}-{dt.month:02d}"
        if granularity == "quarter":
            return f"{dt.year}-Q{(dt.month - 1) // 3 + 1}"
        if granularity == "half":
            return f"{dt.year}-H{1 if dt.month <= 6 else 2}"
        return str(dt.year)

    summary = {}
    for granularity in ("month", "quarter", "half", "year"):
        buckets = defaultdict(list)
        for t in trades:
            buckets[period_bucket(t["exitTime"], granularity)].append(t["returnPct"])
        summary[granularity] = {
            period: {
                "trades": len(returns),
                "winRate": round(100 * sum(1 for r in returns if r > 0) / len(returns), 1),
                "avgReturnPct": round(sum(returns) / len(returns), 2),
                "totalReturnPct": round(sum(returns), 2),
            }
            for period, returns in sorted(buckets.items())
        }

    return {"trades": trades, "openPositions": open_positions, "summary": summary}


def main():
    cfg = load_config()
    all_dfs = {}
    all_tickers = set()

    for preset_key, preset_cfg in cfg["presets"].items():
        df = fetch_preset_tickers(preset_key, preset_cfg, cfg)
        all_dfs[preset_key] = df
        all_tickers.update(df["Ticker"].tolist() if not df.empty else [])

    if not all_tickers:
        log.warning("لا أسهم مطابقة من أي فلتر — انتهاء ناجح بلا نتائج جديدة")
        return

    log.info(f"إجمالي الرموز الفريدة عبر كل الفلاتر: {len(all_tickers)}")
    technicals, charts = fetch_technicals(sorted(all_tickers))
    log.info(f"نجح حساب المؤشرات الفنية لـ {len(technicals)} من {len(all_tickers)}")

    prev_tiers = load_previous_tiers()

    signal_rows, alert_rows = [], []
    for preset_key, df in all_dfs.items():
        stocks, new_alerts = build_preset_output(preset_key, df, technicals, prev_tiers)
        alert_rows.extend(new_alerts)
        for s in stocks:
            signal_rows.append({
                "preset": preset_key, "symbol": s["symbol"], "company": s["company"],
                "sector": s["sector"], "industry": s["industry"],
                "pe": None if pd.isna(s["pe"]) else float(s["pe"]),
                "price": s["price"], "change_pct": s.get("change"),
                "entry_score": s["entryScore"], "entry_tier": s["entryTier"], "entry_signals": s["entrySignals"],
                "exit_score": s["exitScore"], "exit_tier": s["exitTier"], "exit_signals": s["exitSignals"],
                "fib_ratio": s.get("fibRatio"),
            })
        log.info(f"[{preset_key}] أسهم بدرجة تنبيه 2+/4: {len(stocks)} | تنبيهات جديدة: {len(new_alerts)}")

    n_sig = sb_upsert("screener_signals", signal_rows, on_conflict="preset,symbol")
    n_alert = sb_insert("screener_alerts", alert_rows)
    log.info(f"screener_signals: {n_sig} صف | screener_alerts: {n_alert} تنبيه جديد")

    chart_rows = [{"symbol": sym, "data": ohlc} for sym, ohlc in charts.items()]
    n_charts = sb_upsert("screener_charts", chart_rows, on_conflict="symbol")
    log.info(f"screener_charts: {n_charts} سهم")

    # الأداء يُحسب من كامل تاريخ screener_alerts المتراكم فعليًا على Supabase (لا حد أقصى محلي مطلوب)
    all_alerts = sb_select("screener_alerts", "select=preset,symbol,type,tier,score,price,signals,ts&order=ts.asc")
    for a in all_alerts:
        a["timestamp"] = a.pop("ts")
    performance = compute_performance({"alerts": all_alerts})
    perf_rows = []
    for granularity, buckets in performance["summary"].items():
        for period, d in buckets.items():
            perf_rows.append({"granularity": granularity, "period": period, "trades": d["trades"],
                               "win_rate": d["winRate"], "avg_return_pct": d["avgReturnPct"],
                               "total_return_pct": d["totalReturnPct"]})
    n_perf = sb_upsert("screener_performance", perf_rows, on_conflict="granularity,period")
    log.info(f"screener_performance: {n_perf} فترة | صفقات مُقفلة: {len(performance['trades'])} | مفتوحة: {len(performance['openPositions'])}")

    if n_sig == 0:
        log.warning("لم تُنشأ إشارات جديدة أو لا توجد أسهم بدرجة 2+/4؛ لا يُعد ذلك فشلًا للمهمة")
    log.info("اكتمل محرك الإشارات بنجاح")


if __name__ == "__main__":
    main()
