"""
AZ Alpha Vision — Free Market Scan
مصدر الرموز الرسمي: Nasdaq Trader (NASDAQ وNYSE فقط).
مصدر السعر والتاريخ والحجم والمؤشرات: yfinance للاستخدام التعليمي.
لا يعتمد المسح على Finviz ولا على قائمة ثابتة قصيرة.

--mode full  : يمسح حتى MAX_UNIVERSE رمزًا مؤهلًا ويكتب fundamentals/technicals.
--mode quick : يجلب الأسعار فقط لقائمة LIVE_TRACKED ويكتب live_quotes.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import time
from typing import Any

import numpy as np
import pandas as pd
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("az-alpha-free-scan")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    log.error("SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير موجودين")
    sys.exit(1)

MIN_PRICE = float(os.environ.get("MIN_PRICE", "5"))
MAX_PRICE = float(os.environ.get("MAX_PRICE", "70"))
MAX_UNIVERSE = max(100, int(os.environ.get("MAX_UNIVERSE", "5000")))
BATCH_SIZE = max(10, int(os.environ.get("YF_BATCH_SIZE", "50")))

LIVE_TRACKED = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "AMD", "NFLX", "CRM", "SHOP", "SQ", "UBER",
    "ABNB", "COIN", "ROKU", "SNAP", "PINS", "ETSY", "TWLO", "DDOG", "NET", "OKTA", "ZS", "CRWD", "PLTR",
    "SNOW", "FSLR", "ENPH", "RUN", "RBLX", "SOFI", "AFRM", "HOOD", "UPST", "AI", "SOUN", "BBAI",
]

# مؤشرات سوق عامة مستقلة عن كون الأسهم المؤهلة للمحاكي.
MARKET_PULSE_SYMBOLS = {
    "^DJI": ("داو جونز", "index"),
    "^IXIC": ("ناسداك المركب", "index"),
    "CL=F": ("النفط الخام WTI", "commodity"),
    "GC=F": ("الذهب", "commodity"),
    "^VIX": ("مؤشر الخوف VIX", "volatility"),
}

# رموز ظهرت سابقًا كأدوات غير عادية أو غير مرغوبة في المنصة.
EXCLUDED_SYMBOLS = {
    "DDV", "CCDE", "CCODA", "AASYS", "CCRSR", "AAI", "AAIRG", "AAMRZ", "AAOUT", "AAPEI", "BBKKT", "BRBI", "WD",
    "LUCK", "TAL", "EDU", "GSX", "STG", "FANH", "QTT", "UXIN", "SOGO", "QFIN", "FINV", "YRD", "JT", "PPDF", "XYF",
    "NIO", "XPEV", "LI", "BYD", "F", "GM", "HOG", "PII", "NKLA", "WKHS", "RIDE", "GOEV", "MULN", "FSR", "LCID", "RIVN",
    "AMC", "GME", "BBBY", "M", "JCP", "BIG", "RAD", "EXPR", "KOSS", "NAKD", "SNDL", "TLRY", "ACB", "CRON", "OGI", "HEXO", "CGC",
    "CGC", "TLRY", "ACB", "CRON", "SNDL", "GTBIF", "TCNNF", "CURLF", "CRLBF", "PLNHF", "VRNOF", "GDNSF", "AYRWF", "JUSHF", "MSOS", "MJ", "YOLO", "POTX", "THCX", "TOKE", "ACT",
    "SPCE", "RKLB", "ASTS", "MNTS", "VORB", "REDWIRE", "SATL", "BKSY", "MYNA", "SPIR", "ASTR", "LLAP", "SIDU",
}

INSTRUMENT_RE = re.compile(
    r"etf|exchange traded|reit|closed[- ]?end|warrant|unit|preferred|fund|trust|spac|right|rights|note|debenture|depositary|acquisition|when[- ]issued|convertible",
    re.I,
)
FINANCE_RE = re.compile(
    r"bank|banc|financial|finance|insurance|insur|capital|credit|mortgage|broker|asset management|investment management|reinsurance|life insurance|savings|morgan|chase|blackrock|citigroup|schwab|state street|american express|discover financial|real estate|property|properties|healthcare|health care|biotech|biotechnology|pharma|therapeutic|medical|energy|oil|gas|petroleum|coal|solar|utilities",
    re.I,
)


def safe_num(value: Any, default=None):
    try:
        if value is None or value == "" or value == "-":
            return default
        return float(str(value).replace(",", "").replace("%", ""))
    except Exception:
        return default


def is_common_security(symbol: str, name: str, etf: str = "N", test_issue: str = "N") -> bool:
    symbol = str(symbol or "").strip().upper()
    name = str(name or "").strip()
    if not symbol or symbol in EXCLUDED_SYMBOLS:
        return False
    if str(etf).upper() == "Y" or str(test_issue).upper() == "Y":
        return False
    if INSTRUMENT_RE.search(name):
        return False
    # يمنع رموز الفئات ذات اللاحقة الطويلة وأسماء الأدوات المركبة دون منع BRK.B مثلًا.
    if len(symbol) > 6 and "-" in symbol:
        return False
    return True


def load_primary_exchange_symbols() -> dict[str, dict[str, str]]:
    """يحمل ملفات Nasdaq Trader الرسمية ويقبل NASDAQ وNYSE فقط، لا AMEX/NYSE MKT/ARCA."""
    result: dict[str, dict[str, str]] = {}
    sources = [
        ("NASDAQ", "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt"),
        ("NYSE", "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt"),
    ]
    session = requests.Session()
    session.headers.update({"User-Agent": "AZ-Alpha-Vision-Educational/1.0"})
    for exchange, url in sources:
        try:
            response = session.get(url, timeout=45)
            response.raise_for_status()
            lines = [line for line in response.text.splitlines() if line and not line.startswith("File Creation")]
            for line in lines[1:]:
                parts = line.split("|")
                if exchange == "NASDAQ":
                    symbol = parts[0].strip().upper() if len(parts) > 0 else ""
                    name = parts[1].strip() if len(parts) > 1 else ""
                    test_issue = parts[3].strip().upper() if len(parts) > 3 else "Y"
                    etf = parts[6].strip().upper() if len(parts) > 6 else "Y"
                else:
                    symbol = parts[0].strip().upper() if len(parts) > 0 else ""
                    name = parts[1].strip() if len(parts) > 1 else ""
                    exchange_code = parts[2].strip().upper() if len(parts) > 2 else ""
                    etf = parts[4].strip().upper() if len(parts) > 4 else "Y"
                    test_issue = parts[6].strip().upper() if len(parts) > 6 else "Y"
                    if exchange_code != "N":
                        continue
                if is_common_security(symbol, name, etf, test_issue):
                    result[symbol] = {"symbol": symbol, "company": name, "exchange": exchange}
        except Exception as exc:
            log.error("تعذر تحميل قائمة %s الرسمية: %s", exchange, exc)
    log.info("تم تحميل %s رمز سهم عادي من NASDAQ/NYSE بعد الاستبعاد", len(result))
    return result


def sector_from_name(company: str) -> tuple[str, str]:
    name = str(company or "")
    if FINANCE_RE.search(name):
        return "finance", "Financial"
    if re.search(r"real estate|property|properties|reit", name, re.I):
        return "reits", "Real Estate"
    if re.search(r"healthcare|health care|biotech|biotechnology|pharma|therapeutic|medical", name, re.I):
        return "healthcare", "Healthcare"
    if re.search(r"energy|oil|gas|petroleum|coal|solar|utilities", name, re.I):
        return "energy", "Energy"
    return "other", "Other"


def compute_technical(df: pd.DataFrame) -> dict[str, Any]:
    close = pd.to_numeric(df["Close"], errors="coerce").dropna()
    high = pd.to_numeric(df["High"], errors="coerce").reindex(close.index)
    low = pd.to_numeric(df["Low"], errors="coerce").reindex(close.index)
    volume = pd.to_numeric(df["Volume"], errors="coerce").fillna(0).reindex(close.index)
    if close.empty:
        return {}

    def sma(period: int):
        series = close.rolling(period).mean().dropna()
        return round(float(series.iloc[-1]), 4) if len(series) else None

    def previous_sma(period: int):
        series = close.rolling(period).mean().dropna()
        return float(series.iloc[-2]) if len(series) >= 2 else None

    def performance(period: int):
        if len(close) > period and float(close.iloc[-period - 1]) != 0:
            return round((price / float(close.iloc[-period - 1]) - 1) * 100, 2)
        return None

    # RSI14 وفق تنعيم Wilder (RMA/SMMA)، مع معالجة حالات الصعود أو الثبات الكامل.
    delta = close.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    avg_gain = gains.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    avg_loss = losses.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi_series = 100 - (100 / (1 + rs))
    rsi_series = rsi_series.mask((avg_loss == 0) & (avg_gain > 0), 100.0)
    rsi_series = rsi_series.mask((avg_loss == 0) & (avg_gain == 0), 50.0)
    rsi = rsi_series.iloc[-1] if len(rsi_series) >= 15 else None
    prev_close = close.shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    atr_series = tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    atr = atr_series.iloc[-1] if len(atr_series) >= 14 else None
    current_volume = float(volume.iloc[-1]) if len(volume) else 0
    avg9 = float(volume.iloc[:-1].tail(9).mean()) if len(volume) > 1 else current_volume
    avg20 = float(volume.tail(20).mean()) if len(volume) else current_volume
    price = float(close.iloc[-1])
    previous = float(close.iloc[-2]) if len(close) > 1 else price
    perf_week = None
    if len(close) >= 6 and float(close.iloc[-6]) != 0:
        perf_week = round((price / float(close.iloc[-6]) - 1) * 100, 2)
    return {
        "price": round(price, 2),
        "change_pct": round((price / previous - 1) * 100, 2) if previous else 0,
        "volume": int(current_volume),
        "avg_volume": int(avg20),
        "avg_volume_9": round(avg9, 2),
        "rel_volume": round(current_volume / avg20, 2) if avg20 else 1.0,
        "rel_volume_9": round(current_volume / avg9, 2) if avg9 else 1.0,
        "sma20": sma(20),
        "sma50": sma(50),
        "sma200": sma(200),
        "sma20_change": round((sma(20) / previous_sma(20) - 1) * 100, 4) if sma(20) is not None and previous_sma(20) not in (None, 0) else None,
        "sma50_change": round((sma(50) / previous_sma(50) - 1) * 100, 4) if sma(50) is not None and previous_sma(50) not in (None, 0) else None,
        "sma200_change": round((sma(200) / previous_sma(200) - 1) * 100, 4) if sma(200) is not None and previous_sma(200) not in (None, 0) else None,
        "distance_from_sma20": round((price / sma(20) - 1) * 100, 4) if sma(20) not in (None, 0) else None,
        "distance_from_sma50": round((price / sma(50) - 1) * 100, 4) if sma(50) not in (None, 0) else None,
        "distance_from_sma200": round((price / sma(200) - 1) * 100, 4) if sma(200) not in (None, 0) else None,
        "rsi14": round(float(rsi), 2) if rsi is not None and pd.notna(rsi) else None,
        "atr14": round(float(atr), 4) if atr is not None and pd.notna(atr) else None,
        "perf_week": perf_week,
        "perf_month": performance(21),
        "perf_quarter": performance(63),
        "perf_half": performance(126),
        "perf_year": performance(252),
    }


def download_chunk_with_retry(yf, chunk: list[str], period: str) -> pd.DataFrame | None:
    for attempt in range(1, 4):
        try:
            # threads=False مهم لتجنب قفل SQLite/crumb cache في GitHub Actions.
            data = yf.download(chunk, period=period, group_by="ticker", threads=False, auto_adjust=False, progress=False, timeout=60)
            if data is not None and not data.empty:
                return data
            log.warning("دفعة فارغة (%s/%s)", attempt, 3)
        except Exception as exc:
            log.warning("فشل تنزيل الدفعة (%s/3): %s", attempt, exc)
        time.sleep(5 * attempt)
    return None


def fetch_prices_and_technicals(tickers: list[str], full_history=True) -> dict[str, dict[str, Any]]:
    import yfinance as yf
    results: dict[str, dict[str, Any]] = {}
    period = "2y" if full_history else "5d"
    chunks = [tickers[i:i + BATCH_SIZE] for i in range(0, len(tickers), BATCH_SIZE)]
    for index, chunk in enumerate(chunks, 1):
        log.info("yfinance دفعة %s/%s: %s سهم", index, len(chunks), len(chunk))
        data = download_chunk_with_retry(yf, chunk, period)
        if data is None:
            log.error("تخطي الدفعة بعد 3 محاولات: %s", ",".join(chunk[:5]))
            continue
        for ticker in chunk:
            try:
                if len(chunk) > 1:
                    if ticker not in data.columns.get_level_values(0):
                        continue
                    frame = data[ticker].dropna(how="all")
                else:
                    frame = data.dropna(how="all")
                if frame.empty or "Close" not in frame.columns:
                    continue
                rec = compute_technical(frame)
                price = rec.get("price")
                if price is None or price < MIN_PRICE or price > MAX_PRICE:
                    continue
                results[ticker] = rec
            except Exception as exc:
                log.warning("تعذر معالجة %s: %s", ticker, exc)
        time.sleep(1)
    log.info("نجح جلب بيانات %s من أصل %s سهم", len(results), len(tickers))
    return results


def build_fundamentals(symbols: dict[str, dict[str, str]], technicals: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    records = {}
    for symbol, meta in symbols.items():
        if symbol not in technicals:
            continue
        sector, finviz_sector = sector_from_name(meta.get("company", ""))
        if sector in {"finance", "reits", "healthcare", "energy"}:
            continue
        records[symbol] = {
            "symbol": symbol,
            "company": meta.get("company"),
            "price": technicals[symbol].get("price"),
            "exchange": meta.get("exchange"),
            "sector": sector,
            "finviz_sector": finviz_sector,
            "industry": meta.get("company", ""),
            "pe": None,
            "pb": None,
            "eps_growth_this_year": None,
            "eps_growth_next_year": None,
            "eps_growth_5y": None,
            "eps_growth_next_5y": None,
            "lt_debt_equity": None,
            "eps_growth_qtr": None,
        }
    return records


def upsert_rows(table: str, rows: list[dict[str, Any]]) -> int:
    if not rows:
        log.warning("%s: لا صفوف لكتابتها", table)
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{table}?on_conflict=symbol"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates, return=minimal",
    }
    written = 0
    for start in range(0, len(rows), 200):
        batch = rows[start:start + 200]
        for attempt in range(1, 4):
            try:
                response = requests.post(url, headers=headers, json=batch, timeout=45)
                if response.status_code in (200, 201, 204):
                    written += len(batch)
                    break
                log.warning("%s دفعة %s فشلت HTTP %s (%s/3): %s", table, start, response.status_code, attempt, response.text[:300])
            except requests.RequestException as exc:
                log.warning("%s دفعة %s فشلت (%s/3): %s", table, start, attempt, exc)
            if attempt == 3:
                raise RuntimeError(f"فشل حفظ {table} بعد 3 محاولات")
            time.sleep(3 * attempt)
    log.info("%s: تم حفظ %s صف", table, written)
    return written


def run_full():
    symbols = load_primary_exchange_symbols()
    if not symbols:
        raise RuntimeError("لم تُحمّل قائمة NASDAQ/NYSE")
    # ترتيب ثابت يجعل إعادة التشغيل قابلة للتتبع، ثم نأخذ نطاقًا أكبر من القائمة السابقة.
    universe = sorted(symbols)[:MAX_UNIVERSE]
    log.info("الكون المرشح قبل السعر والفنيات: %s رمزًا من %s رمزًا رسميًا", len(universe), len(symbols))
    technicals = fetch_prices_and_technicals(universe, full_history=True)
    fundamentals = build_fundamentals({s: symbols[s] for s in technicals}, technicals)
    log.info("بعد كل الشروط: %s سهمًا عاديًا بسعر %s–%s في NYSE/NASDAQ", len(fundamentals), MIN_PRICE, MAX_PRICE)
    if not fundamentals:
        raise RuntimeError("لم ينجح أي سهم في شروط السعر/البورصة/الأهلية")
    now = pd.Timestamp.now(tz="UTC").isoformat()
    fund_rows = [{**row, "updated_at": now} for row in fundamentals.values()]
    tech_rows = [{"symbol": symbol, **technicals[symbol], "updated_at": now} for symbol in fundamentals]
    n1 = upsert_rows("market_fundamentals", fund_rows)
    n2 = upsert_rows("market_technicals", tech_rows)
    if n1 == 0:
        raise RuntimeError("لم تُحفظ أي بيانات أساسية")
    log.info("اكتمل المسح المجاني: fundamentals=%s, technicals=%s", n1, n2)


def load_quick_symbols() -> list[str]:
    symbols = set(LIVE_TRACKED)
    headers = {"apikey": SUPABASE_SERVICE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"}
    sources = [
        ("screener_signals", "symbol&entry_score=gt.0"),
        ("watchlist", "symbol"),
        ("research_requests", "symbol&status=eq.active"),
    ]
    for table, query in sources:
        try:
            response = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?select={query}&limit=5000", headers=headers, timeout=30)
            response.raise_for_status()
            for row in response.json() or []:
                symbol = str(row.get("symbol") or "").strip().upper()
                if symbol and symbol not in EXCLUDED_SYMBOLS:
                    symbols.add(symbol)
        except Exception as exc:
            log.warning("تعذر تحميل رموز %s: %s", table, exc)
    selected = sorted(symbols - EXCLUDED_SYMBOLS)
    log.info("تحديث الأسعار السريع لعدد %s رمزًا، منها رموز الماسح والمراقبة والبحث", len(selected))
    return selected


def fetch_market_pulse() -> list[dict[str, Any]]:
    """يجلب المؤشرات العامة من yfinance ويحفظ آخر سعر وتغير فقط."""
    import yfinance as yf
    symbols = list(MARKET_PULSE_SYMBOLS)
    try:
        data = yf.download(symbols, period="5d", group_by="ticker", threads=False, auto_adjust=False, progress=False, timeout=45)
    except Exception as exc:
        log.warning("تعذر تحميل نبض السوق: %s", exc)
        return []
    now = pd.Timestamp.now(tz="UTC").isoformat()
    rows: list[dict[str, Any]] = []
    for symbol, (label_ar, asset_type) in MARKET_PULSE_SYMBOLS.items():
        try:
            frame = data[symbol].dropna(how="all") if len(symbols) > 1 else data.dropna(how="all")
            closes = pd.to_numeric(frame["Close"], errors="coerce").dropna()
            if closes.empty:
                continue
            price = float(closes.iloc[-1])
            previous = float(closes.iloc[-2]) if len(closes) > 1 else price
            rows.append({"symbol": symbol, "label_ar": label_ar, "asset_type": asset_type, "price": round(price, 2), "change_pct": round((price / previous - 1) * 100, 2) if previous else 0, "updated_at": now, "source_name": "Yahoo Finance عبر yfinance"})
        except Exception as exc:
            log.warning("تعذر حساب نبض %s: %s", symbol, exc)
    return rows


def run_quick():
    # نستخدم تاريخ سنة حتى لا تبقى RSI وSMA20/SMA50/SMA200 فارغة.
    # هذا المسار يحدّث الأسعار الحية والفنيات لرموز الماسح والمراقبة والبحث.
    technicals = fetch_prices_and_technicals(load_quick_symbols(), full_history=True)
    now = pd.Timestamp.now(tz="UTC").isoformat()
    quote_rows = [{"symbol": symbol, "price": values["price"], "change_pct": values["change_pct"], "volume": values["volume"], "updated_at": now} for symbol, values in technicals.items()]
    technical_rows = [{"symbol": symbol, **values, "updated_at": now} for symbol, values in technicals.items()]
    if upsert_rows("live_quotes", quote_rows) == 0:
        raise RuntimeError("لم تُحفظ أي أسعار حية")
    if upsert_rows("market_technicals", technical_rows) == 0:
        raise RuntimeError("لم تُحفظ أي مؤشرات فنية")
    pulse = fetch_market_pulse()
    if pulse:
        upsert_rows("market_pulse", pulse)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["full", "quick"], default="full")
    args = parser.parse_args()
    run_full() if args.mode == "full" else run_quick()
