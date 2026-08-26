"""AZ Alpha Vision — تحديث تقويم الأرباح التعليمي.

النطاق: مراكز المحاكي المشترك + أفضل ترشيحات الماسح + مرشحي فلترة الأسهم النشطين.
تظهر توقعات EPS فقط عند إرجاع المصدر قيمة فعلية ومتوسط عدد المحللين؛ لا تُنشأ توقعات منطقية أو اصطناعية.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

import requests
import yfinance as yf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("az-earnings-calendar")
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not URL or not KEY:
    log.error("متغيرات Supabase غير موجودة")
    sys.exit(1)

HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def rest_get(table: str, select: str, params: dict[str, str]) -> list[dict[str, Any]]:
    response = requests.get(
        f"{URL}/rest/v1/{table}", headers=HEADERS, params={"select": select, **params}, timeout=45
    )
    response.raise_for_status()
    return response.json()


def get_symbols() -> dict[str, dict[str, Any]]:
    """يرجع الرموز ذات الصلة ومصدر ظهور كل رمز في المنصة."""
    symbols: dict[str, dict[str, Any]] = {}

    def add(rows: list[dict[str, Any]], source: str) -> None:
        for row in rows:
            symbol = str(row.get("symbol") or "").strip().upper()
            if not symbol:
                continue
            item = symbols.setdefault(symbol, {"company_name": symbol, "tracking_sources": set()})
            company = str(row.get("company") or row.get("company_name") or "").strip()
            if company:
                item["company_name"] = company
            item["tracking_sources"].add(source)

    add(rest_get("shared_virtual_positions", "symbol", {"simulation_id": "eq.global"}), "محفظة المحاكي")
    add(
        rest_get("screener_signals", "symbol,company,entry_score", {"entry_score": "gt.0", "order": "entry_score.desc", "limit": "14"}),
        "ترشيحات المحاكي",
    )
    # هذا الجدول اختياري في بعض النسخ القديمة؛ لا نوقف التقويم إذا لم يكن قد أُنشئ بعد.
    try:
        add(
            rest_get(
                "manual_filter_candidates",
                "symbol",
                {"status": "eq.active", "expires_at": f"gt.{datetime.now(timezone.utc).isoformat()}", "order": "updated_at.desc", "limit": "14"},
            ),
            "فلترة الأسهم",
        )
    except requests.RequestException as exc:
        log.warning("تعذر قراءة مرشحي فلترة الأسهم: %s", exc)

    return dict(list(symbols.items())[:28])


def as_iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        if isinstance(value, datetime):
            dt = value
        else:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        return None


def future_earnings_date(calendar: Any) -> str | None:
    """يتوافق مع شكل calendar في إصدارات yfinance المختلفة."""
    values: list[Any] = []
    if isinstance(calendar, dict):
        values = calendar.get("Earnings Date") or []
    elif hasattr(calendar, "columns"):
        if "Earnings Date" in calendar.columns:
            values = calendar["Earnings Date"].tolist()
        elif hasattr(calendar, "index"):
            values = list(calendar.index)
    elif hasattr(calendar, "get"):
        values = calendar.get("Earnings Date") or []
    if not isinstance(values, (list, tuple)):
        values = [values]

    now = datetime.now(timezone.utc)
    dates: list[datetime] = []
    for value in values:
        iso = as_iso(value)
        if not iso:
            continue
        parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if parsed >= now:
            dates.append(parsed)
    return min(dates).isoformat() if dates else None


def as_number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if number == number else None
    except (TypeError, ValueError):
        return None


def analyst_estimate(ticker: Any) -> dict[str, Any]:
    """يحصل على تقدير EPS للأرباح القادمة إن أعاده Yahoo Finance، وإلا يعيد حقولاً فارغة."""
    empty = {
        "analyst_eps_avg": None,
        "analyst_eps_low": None,
        "analyst_eps_high": None,
        "analyst_count": None,
        "estimate_period": None,
        "estimates_fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        table = ticker.get_earnings_estimate() if hasattr(ticker, "get_earnings_estimate") else ticker.earnings_estimate
        if table is None or not hasattr(table, "columns") or not len(table.index):
            return empty
        preferred = next((key for key in ("0q", "+1q", "0y", "+1y") if key in table.index), table.index[0])
        row = table.loc[preferred]
        average = as_number(row.get("avg"))
        low = as_number(row.get("low"))
        high = as_number(row.get("high"))
        count = as_number(row.get("numberOfAnalysts"))
        return {
            **empty,
            "analyst_eps_avg": average,
            "analyst_eps_low": low,
            "analyst_eps_high": high,
            "analyst_count": int(count) if count is not None else None,
            "estimate_period": str(preferred),
        }
    except Exception as exc:
        log.info("لا تتوفر تقديرات محللين قابلة للقراءة: %s", exc)
        return empty


def main() -> None:
    symbols = get_symbols()
    if not symbols:
        log.info("لا توجد مراكز أو ترشيحات أو مرشحو فلترة نشطون لتحديث التقويم")
        return

    rows: list[dict[str, Any]] = []
    for symbol, context in symbols.items():
        try:
            ticker = yf.Ticker(symbol)
            event_date = future_earnings_date(ticker.calendar)
            if not event_date:
                continue
            estimate = analyst_estimate(ticker)
            rows.append(
                {
                    "symbol": symbol,
                    "company_name": context["company_name"],
                    "event_date": event_date,
                    "event_type": "earnings",
                    "source_name": "Yahoo Finance calendar and analyst estimates",
                    "source_url": f"https://finance.yahoo.com/quote/{symbol}/analysis/",
                    "tracking_sources": sorted(context["tracking_sources"]),
                    **estimate,
                }
            )
        except Exception as exc:
            log.warning("تعذر جلب تقويم %s: %s", symbol, exc)

    if rows:
        headers = {**HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"}
        response = requests.post(
            f"{URL}/rest/v1/earnings_events",
            headers=headers,
            params={"on_conflict": "symbol,event_type,event_date"},
            data=json.dumps(rows),
            timeout=60,
        )
        response.raise_for_status()
    log.info("تم تحديث %s موعد أرباح مرتبط بالمنصة", len(rows))


if __name__ == "__main__":
    main()
