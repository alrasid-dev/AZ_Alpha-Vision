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
    r"energy|oil|gas|petroleum|coal|solar|utilities|etf|closed[ -]?end|warrant|"
    r"unit|preferred|fund|trust|spac|rights|note|depositary|acquisition",
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
    text = " ".join(str(row.get(k) or "") for k in ("industry", "company", "sector", "finviz_sector"))
    price = num(row, "price")
    return bool(
        symbol
        and symbol not in BLOCKED
        and not re.search(r"[.\-]", symbol)
        and exchange in {"NYSE", "NASDAQ"}
        and price is not None
        and MIN_PRICE <= price <= MAX_PRICE
        and not UNWANTED_TEXT.search(text)
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


def entry_score(row: dict[str, Any], spec: dict[str, Any]) -> tuple[int, dict[str, bool]]:
    price = num(row, "price") or 0
    rsi = num(row, "rsi14")
    change = num(row, "change_pct") or 0
    relvol = num(row, "rel_volume", "rel_volume_9") or 0
    sma20, sma50, sma200 = num(row, "sma20"), num(row, "sma50"), num(row, "sma200")
    growth = num(row, "eps_growth_this_year")
    signals = {
        "fibonacci": bool(sma20 is not None and sma50 is not None and price > sma20 > sma50),
        "smc_atr": bool(sma50 is not None and sma200 is not None and price > sma50 and price > sma200),
        "candlestick": bool(change > 0 and (rsi is None or rsi < 70)),
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

    # قد يحتوي market_fundamentals على أكثر من صف تاريخي للرمز نفسه.
    # نضمن سجلًا واحدًا لكل زوج (preset, symbol) قبل upsert حتى لا يعيد
    # PostgreSQL تحديث الصف نفسه مرتين داخل الطلب الواحد.
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
    headers = {**HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"}
    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/screener_signals?on_conflict=preset,symbol",
        headers=headers,
        data=json.dumps(rows, ensure_ascii=False),
        timeout=60,
    )
    res.raise_for_status()
    log.info("تم حفظ %s إشارة قالب في screener_signals", len(rows))


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
            score, signals = entry_score(row, spec)
            if score <= 0:
                continue
            output.append({
                "preset": preset,
                "symbol": row["symbol"],
                "company": row.get("company"),
                "sector": row.get("sector"),
                "industry": row.get("industry"),
                "pe": None,
                "price": num(row, "price"),
                "change_pct": num(row, "change_pct"),
                "volume": num(row, "volume"),
                "rel_volume": num(row, "rel_volume", "rel_volume_9"),
                "rsi14": num(row, "rsi14"),
                "sma20": num(row, "sma20"),
                "sma50": num(row, "sma50"),
                "sma200": num(row, "sma200"),
                "sma20_change": num(row, "sma20_change"),
                "sma50_change": num(row, "sma50_change"),
                "sma200_change": num(row, "sma200_change"),
                "distance_from_sma20": num(row, "distance_from_sma20"),
                "distance_from_sma50": num(row, "distance_from_sma50"),
                "distance_from_sma200": num(row, "distance_from_sma200"),
                "atr14": num(row, "atr14"),
                "perf_week": num(row, "perf_week"),
                "perf_month": num(row, "perf_month"),
                "perf_quarter": num(row, "perf_quarter"),
                "perf_half": num(row, "perf_half"),
                "perf_year": num(row, "perf_year"),
                "entry_score": score,
                "entry_tier": tier(score),
                "entry_signals": signals,
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
