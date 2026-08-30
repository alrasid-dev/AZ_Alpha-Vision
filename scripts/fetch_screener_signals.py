#!/usr/bin/env python3
"""AZ Alpha Vision — محرك القوالب الجاهزة.
يقرأ نفس حقول السوق التي تستخدمها واجهة فلترة الأسهم، ويكتب نتيجة كل قالب إلى
screener_signals حتى تقرأها ترشيحات الأسبوع والمتداول الخلفي من مصدر واحد.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("screener-signals")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
MIN_PRICE = float(os.environ.get("MIN_PRICE", "5"))
MAX_PRICE = float(os.environ.get("MAX_PRICE", "70"))
PAGE_SIZE = 1000

if not SUPABASE_URL or not SUPABASE_KEY:
    raise SystemExit("SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY مطلوبان")

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

# القائمة الخفيفة ثابتة في المحرك الخلفي، مع الاستبعاد القطاعي النصي أدناه.
BLOCKED = {
    "DDV", "CCDE", "CCODA", "AASYS", "CCRSR", "AAI", "AAIRG", "AAMRZ", "AAOUT",
    "AAPEI", "BBKKT", "BRBI", "WD", "LUCK", "TAL", "EDU", "GSX", "STG", "FANH",
    "QTT", "UXIN", "SOGO", "QFIN", "FINV", "YRD", "JT", "PPDF", "XYF", "NIO",
    "XPEV", "LI", "NKLA", "WKHS", "RIDE", "GOEV", "MULN", "FSR", "LCID", "RIVN",
    "AMC", "GME", "BBBY", "JCP", "RAD", "EXPR", "KOSS", "SNDL", "TLRY", "ACB",
    "CRON", "OGI", "HEXO", "CGC", "SPCE", "RKLB", "ASTS", "MNTS", "VORB", "ASTR",
    "LLAP", "SIDU",
}
UNWANTED_TEXT = re.compile(
    r"financial|finance|bank|banc|insurance|insur|capital|credit|mortgage|broker|"
    r"asset management|investment|reinsurance|real estate|property|properties|reit|"
    r"healthcare|health care|biotech|biotechnology|pharma|therapeutic|medical|"
    r"energy|oil|gas|petroleum|coal|solar|utilities|etf|exchange[ -]?traded|etn|"
    r"closed[ -]?end|warrant|unit|preferred|fund|trust|spac|rights|note|depositary|"
    r"acquisition|bond|convertible|royalty|partnership|limited partnership|adr",
    re.I,
)

LABELS = {
    "growth": "نمو الأرباح",
    "value": "قيمة مغرية",
    "momentum": "زخم سعري",
    "breakout": "اختراق",
    "swing": "سوينج",
    "dividend": "توزيعات",
    "penny": "سيولة وحركة",
    "opp_buy_dip": "شراء التراجع",
    "opp_earnings": "مفاجأة أرباح",
    "opp_low_float": "حجم متسارع",
    "opp_analyst": "اتجاه قوي",
    "opp_debt_free": "دين منخفض",
    "opp_undervalued": "أقل من قيمته",
    "opp_tech_bounce": "ارتداد تقني",
}

# شروط القوالب نفسها التي تحمّلها أزرار الواجهة بعد توحيد النطاق الأعلى عند 70.
TEMPLATES = {
    "growth": {"lo": 5, "hi": 20, "change": 0, "rsi": "neutral", "above50": True, "above200": True, "relvol": 1, "growth": 15, "next": 15, "debt": 0.6},
    "value": {"lo": 5, "hi": 70, "rsi": "oversold", "pb_hi": 1, "debt": 0.6},
    "momentum": {"lo": 5, "hi": 20, "change": 5, "rsi": "neutral", "above50": True, "above200": True, "relvol": 2, "growth": 30, "next": 30, "perf": 5, "sma20": "above", "volume": 500000},
    "breakout": {"lo": 5, "hi": 20, "change": 3, "rsi": "neutral", "above50": True, "below200": True, "relvol": 2, "growth": 15, "perf": 10, "sma20": "above", "volume": 1000000},
    "swing": {"lo": 5, "hi": 20, "rsi": "oversold", "below50": True, "growth": 15, "next": 15, "debt": 0.6, "perf_below": 0, "sma20": "below"},
    "dividend": {"lo": 20, "hi": 70, "above50": True, "above200": True, "debt": 0.3, "growth_optional": True},
    "penny": {"lo": 5, "hi": 20, "change": 0, "relvol": 1, "perf": 0},
    "opp_buy_dip": {"lo": 20, "hi": 70, "change_below": 0, "rsi": "oversold", "below50": True, "above200": True, "pb_lo": 1, "pb_hi": 3, "growth": 15, "next": 15, "eps5y": 15, "debt": 0.6, "perf_below": 0, "sma20": "below"},
    "opp_earnings": {"lo": 5, "hi": 70, "change": 3, "rsi": "neutral", "above50": True, "relvol": 2, "growth": 30, "next": 30, "eps5y": 15, "debt": 0.6, "perf": 5, "sma20": "above", "volume": 500000},
    "opp_low_float": {"lo": 5, "hi": 20, "change": 0, "relvol": 2, "perf": 0, "volume": 500000},
    "opp_analyst": {"lo": 5, "hi": 70, "change": 0, "rsi": "neutral", "above50": True, "above200": True, "relvol": 1, "growth": 15, "next": 15, "eps5y": 15, "debt": 0.6, "perf": 0, "sma20": "above"},
    "opp_debt_free": {"lo": 5, "hi": 70, "growth": 15, "next": 15, "eps5y": 15, "debt": 0.3},
    "opp_undervalued": {"lo": 5, "hi": 70, "rsi": "oversold", "below50": True, "below200": True, "pb_hi": 1, "growth": 15, "next": 15, "eps5y": 15, "debt": 0.6, "perf_below": 0, "sma20": "below"},
    "opp_tech_bounce": {"lo": 5, "hi": 20, "change": 3, "rsi": "oversold", "below50": True, "above200": True, "relvol": 2, "growth": 30, "next": 30, "eps5y": 15, "debt": 0.6, "perf": 5, "sma20": "below", "volume": 500000},
}


def get_all(table: str, select: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        res = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS,
            params={"select": select, "offset": offset, "limit": PAGE_SIZE},
            timeout=45,
        )
        res.raise_for_status()
        batch = res.json() or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def num(row: dict[str, Any], *names: str) -> float | None:
    for name in names:
        value = row.get(name)
        if value is None or value == "":
            continue
        try:
            result = float(value)
            if result == result:
                return result
        except (TypeError, ValueError):
            pass
    return None


def valid(row: dict[str, Any]) -> bool:
    symbol = str(row.get("symbol") or "").strip().upper()
    exchange = str(row.get("exchange") or "").strip().upper()
    text = " ".join(str(row.get(k) or "") for k in (
        "industry", "company", "sector", "finviz_sector", "security_type", "quote_type", "asset_type"
    ))
    price = num(row, "price")
    # لا نعتمد على الرمز وحده: اسم الأداة وحقول نوعها قد تكشف ETF/Trust حتى لو كان الرمز عاديًا.
    instrument_ok = not UNWANTED_TEXT.search(text)
    return bool(
        symbol
        and symbol not in BLOCKED
        and not re.search(r"[.\-\^]", symbol)
        and exchange in {"NYSE", "NASDAQ"}
        and price is not None
        and MIN_PRICE <= price <= MAX_PRICE
        and instrument_ok
    )


def matches(row: dict[str, Any], spec: dict[str, Any]) -> bool:
    price = num(row, "price")
    if price is None or not (spec.get("lo", MIN_PRICE) <= price <= spec.get("hi", MAX_PRICE)):
        return False
    change = num(row, "change_pct") or 0
    perf = num(row, "perf_week")
    rsi = num(row, "rsi14")
    sma20, sma50, sma200 = num(row, "sma20"), num(row, "sma50"), num(row, "sma200")
    relvol = num(row, "rel_volume", "rel_volume_9") or 0
    volume = num(row, "volume") or 0
    pb = num(row, "pb")
    growth = num(row, "eps_growth_this_year")
    next_growth = num(row, "eps_growth_next_year")
    eps5y = num(row, "eps_growth_5y")
    debt = num(row, "lt_debt_equity")

    if "change" in spec and change < spec["change"]: return False
    if "change_below" in spec and change >= spec["change_below"]: return False
    if "perf" in spec and (perf is None or perf < spec["perf"]): return False
    if "perf_below" in spec and (perf is None or perf >= spec["perf_below"]): return False
    if spec.get("rsi") == "neutral" and (rsi is None or not 30 <= rsi <= 70): return False
    if spec.get("rsi") == "oversold" and (rsi is None or rsi >= 30): return False
    if spec.get("above50") and (sma50 is None or price <= sma50): return False
    if spec.get("below50") and (sma50 is None or price >= sma50): return False
    if spec.get("above200") and (sma200 is None or price <= sma200): return False
    if spec.get("below200") and (sma200 is None or price >= sma200): return False
    if spec.get("sma20") == "above" and (sma20 is None or price <= sma20): return False
    if spec.get("sma20") == "below" and (sma20 is None or price >= sma20): return False
    if "relvol" in spec and relvol < spec["relvol"]: return False
    if "volume" in spec and volume < spec["volume"]: return False
    if "pb_hi" in spec and (pb is None or pb >= spec["pb_hi"]): return False
    if "pb_lo" in spec and (pb is None or pb < spec["pb_lo"]): return False
    if "growth" in spec and (growth is None or growth <= spec["growth"]): return False
    if "next" in spec and (next_growth is None or next_growth <= spec["next"]): return False
    if "eps5y" in spec and (eps5y is None or eps5y <= spec["eps5y"]): return False
    if "debt" in spec and (debt is None or debt >= spec["debt"]): return False
    return True


def smart_money_entry(row: dict[str, Any]) -> tuple[bool, str]:
    """SMC-style open proxy: bullish structure/order-block proxy + no chase.

    هذا ليس نسخًا لمؤشر LuxAlgo التجاري؛ لا توجد بيانات OHLC/order blocks في الجدول.
    لذلك نستخدم بنية المتوسطات، المسافة عن SMA20، RSI، الحجم والتغير كحارس محافظ.
    """
    price = num(row, "price")
    sma20, sma50, sma200 = num(row, "sma20"), num(row, "sma50"), num(row, "sma200")
    rsi = num(row, "rsi14")
    change = num(row, "change_pct") or 0
    relvol = num(row, "rel_volume", "rel_volume_9")
    distance20 = num(row, "distance_from_sma20")
    if price is None:
        return False, "لا يوجد سعر صالح"
    # الوضع المتوازن: يزيد الفرص دون السماح بمطاردة الارتفاعات الحادة.
    chase = (rsi is not None and rsi >= 72) or change >= 7 or (distance20 is not None and distance20 > 10)
    if chase:
        return False, "السعر في منطقة مطاردة/قمة؛ انتظار تراجع"
    bullish_structure = bool(
        sma20 is not None and sma50 is not None and (
            (price >= sma20 and sma20 >= sma50) or
            (price >= sma50 * 0.98 and price <= sma20 * 1.10)
        )
    ) or bool(
        sma50 is not None and sma200 is not None and price >= sma200 * 0.98 and price <= sma50 * 1.10 and (rsi is None or rsi < 65)
    )
    volume_ok = relvol is None or relvol >= 1.0
    if not bullish_structure:
        return False, "لا يوجد كسر هيكل أو ارتداد من منطقة طلب مؤكدة"
    if not volume_ok:
        return False, "الحجم لا يؤكد الحركة"
    return True, "SMC مفتوح: هيكل صاعد/ارتداد من الطلب دون مطاردة"


def entry_score(row: dict[str, Any], spec: dict[str, Any]) -> tuple[int, dict[str, bool]]:
    price = num(row, "price") or 0
    rsi = num(row, "rsi14")
    change = num(row, "change_pct") or 0
    relvol = num(row, "rel_volume", "rel_volume_9") or 0
    sma20, sma50, sma200 = num(row, "sma20"), num(row, "sma50"), num(row, "sma200")
    growth = num(row, "eps_growth_this_year")
    smc_ok, _ = smart_money_entry(row)
    signals = {
        "fibonacci": bool(sma20 is not None and sma50 is not None and price > sma20 > sma50),
        "smc_atr": smc_ok,
        "candlestick": bool(change > 0 and (rsi is None or rsi < 72)),
        "volume": bool(relvol > 1.5),
    }
    # اجعل أساسيات القالب تأكيدًا إضافيًا، مع الاحتفاظ بأربع مفاتيح الإشارة المتوافقة مع الواجهة.
    if growth is not None and growth > 0:
        signals["candlestick"] = True
    return sum(signals.values()), signals


def tier(score: int) -> str | None:
    return "صريح" if score >= 3 else "مؤكد" if score == 2 else "دخول" if score == 1 else None


def upsert(rows: list[dict[str, Any]]) -> None:
    if not rows:
        log.warning("لم تنتج القوالب إشارات جديدة؛ لن نحذف الإشارات السابقة")
        return

    # قد يحتوي المصدر على أكثر من صف للسهم نفسه. نضمن سجلًا واحدًا لكل زوج.
    deduped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (str(row.get("preset") or ""), str(row.get("symbol") or "").upper())
        existing = deduped.get(key)
        if existing is None:
            deduped[key] = row
            continue
        existing["entry_score"] = max(int(existing.get("entry_score") or 0), int(row.get("entry_score") or 0))
        existing["entry_tier"] = tier(int(existing.get("entry_score") or 0))
        existing["entry_signals"] = {
            name: bool(existing.get("entry_signals", {}).get(name) or row.get("entry_signals", {}).get(name))
            for name in set(existing.get("entry_signals", {})) | set(row.get("entry_signals", {}))
        }
    rows = list(deduped.values())

    # لا نعتمد على اسم قيد فريد قد يختلف بين مشاريع Supabase.
    # نحذف نتائج القوالب التي ستُحدّث فقط، ثم نضيف الدفعة الجديدة بدون on_conflict.
    presets = sorted({str(row["preset"]) for row in rows if row.get("preset")})
    preset_filter = "in.(" + ",".join(presets) + ")"
    delete_headers = {**HEADERS, "Prefer": "return=minimal"}
    deleted = requests.delete(
        f"{SUPABASE_URL}/rest/v1/screener_signals",
        headers=delete_headers,
        params={"preset": preset_filter},
        timeout=60,
    )
    if not deleted.ok:
        log.error("Supabase delete failed: status=%s body=%s", deleted.status_code, deleted.text[:2000])
        deleted.raise_for_status()

    insert_headers = {**HEADERS, "Prefer": "return=minimal"}
    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/screener_signals",
        headers=insert_headers,
        data=json.dumps(rows, ensure_ascii=False),
        timeout=60,
    )
    if not res.ok:
        log.error("Supabase insert failed: status=%s body=%s", res.status_code, res.text[:4000])
        log.error("First row keys: %s", sorted(rows[0].keys()) if rows else [])
        res.raise_for_status()
    log.info("تم استبدال %s إشارة قالب في screener_signals", len(rows))


def main() -> None:
    fundamentals = get_all("market_fundamentals", "symbol,company,exchange,industry,sector,finviz_sector,price,pe,pb,eps_growth_this_year,eps_growth_next_year,eps_growth_5y,lt_debt_equity")
    technicals = get_all("market_technicals", "symbol,price,change_pct,volume,avg_volume,avg_volume_9,rel_volume,rel_volume_9,rsi14,atr14,sma20,sma50,sma200,sma20_change,sma50_change,sma200_change,distance_from_sma20,distance_from_sma50,distance_from_sma200,perf_week,perf_month,perf_quarter,perf_half,perf_year")
    tech_map = {str(r.get("symbol") or "").upper(): r for r in technicals}
    universe = []
    for fund in fundamentals:
        symbol = str(fund.get("symbol") or "").upper()
        row = {**fund, **tech_map.get(symbol, {}), "symbol": symbol}
        if valid(row):
            universe.append(row)
    log.info("قاعدة القوالب المؤهلة: %s سهمًا من %s أساسيات و%s فنية", len(universe), len(fundamentals), len(technicals))

    output: list[dict[str, Any]] = []
    for preset, spec in TEMPLATES.items():
        count = 0
        for row in universe:
            if not matches(row, spec):
                continue
            smc_ok, smc_reason = smart_money_entry(row)
            # لا نحذف نتيجة القالب بالكامل إذا فشل الحارس؛ نعرضها كمتابعة/انتظار.
            # الحارس سيمنع الشراء الآلي ويمنع تنبيه الدخول حتى يتحسن السعر.
            score, signals = entry_score(row, spec)
            if score <= 0:
                continue
            output.append({
                # هذه هي أعمدة screener_signals الموجودة فعليًا فقط.
                # RSI وSMA ومسافاتها محفوظة في market_technicals وتُطابقها الواجهة بالرمز.
                "preset": preset,
                "symbol": row["symbol"],
                "company": row.get("company"),
                "sector": row.get("sector"),
                "industry": row.get("industry"),
                "pe": num(row, "pe"),
                "price": num(row, "price"),
                "change_pct": num(row, "change_pct"),
                "entry_score": score,
                "entry_tier": tier(score),
                "entry_signals": {**signals, "smc_atr": smc_ok},
                "exit_score": 0,
                "exit_tier": None,
                "exit_signals": {},
                "fib_ratio": None,
            })
            count += 1
        log.info("[%s — %s] %s إشارة", preset, LABELS[preset], count)
    upsert(output)


if __name__ == "__main__":
    main()
