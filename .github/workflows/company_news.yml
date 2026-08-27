"""AZ Alpha Vision — جامع أخبار تعليمي للمحاكي.
يجمع الأخبار لأسهم المراكز المفتوحة وأفضل إشارات القوالب، ثم يكتبها إلى company_news.
المصادر: SEC submissions والإفصاحات العامة عبر Google News RSS.
"""
from __future__ import annotations
import html
import json
import logging
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote_plus
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("az-company-news")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_URL or not SUPABASE_KEY:
    log.error("SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير موجودين")
    sys.exit(1)
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json", "User-Agent": "AZ-Alpha-Vision-Educational/1.0"}
NEWS_HEADERS = {"User-Agent": "AZ-Alpha-Vision-Educational/1.0 contact: admin@example.com"}

def rest_get(table: str, select: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=HEADERS, params={"select": select, **params}, timeout=45)
    r.raise_for_status()
    return r.json()

def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", value or ""))).strip()

def parse_date(value: str) -> str:
    try:
        dt = parsedate_to_datetime(value)
    except Exception:
        try: dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception: dt = datetime.now(timezone.utc)
    if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()

def classify(title: str, summary: str, source: str) -> tuple[str, str, str, bool]:
    text = f"{title} {summary}".lower()
    if re.search(r"dividend|distribution|ex-dividend|توزيع|أرباح نقدية", text):
        return "dividend", "positive", "خبر توزيع أو استحقاق أرباح؛ الأثر الفعلي يعتمد على قيمة التوزيع وتوقعات السوق.", True
    if re.search(r"earnings|quarter results|financial results|revenue|eps|نتائج مالية|أرباح الربع|إيرادات", text):
        impact = "negative" if re.search(r"miss|loss|decline|خفض|خسارة|تراجع|دون التوقعات", text) else "positive"
        return "earnings", impact, "إعلان نتائج مالية؛ اتجاه الأثر تقديري ويتوقف على مقارنة النتائج بتوقعات السوق.", True
    if source.lower() == "sec" or re.search(r"sec filing|8-k|10-k|10-q|material agreement|acquisition|merger|lawsuit|bankruptcy|استحواذ|اندماج|دعوى|إفلاس", text):
        impact = "negative" if re.search(r"lawsuit|bankruptcy|investigation|restatement|خفض التوجيه|دعوى|إفلاس|تحقيق", text) else "neutral"
        return "filing", impact, "إفصاح أو حدث جوهري؛ يلزم فتح المصدر وقراءة التفاصيل قبل تفسيره.", True
    if re.search(r"upgrade|raises outlook|partnership|contract|approval|launch|strong demand|ترقية|رفع التوقعات|شراكة|عقد|موافقة|طلب قوي", text):
        return "positive", "positive", "إشارة إيجابية محتملة، وليست ضمانًا لاتجاه السعر.", False
    if re.search(r"downgrade|cuts outlook|recall|fraud|layoff|weak demand|تخفيض|خفض التوقعات|استدعاء|احتيال|تسريح|طلب ضعيف", text):
        return "negative", "negative", "إشارة سلبية محتملة، وليست توقعًا مؤكدًا للسعر.", True
    return "general", "neutral", "خبر عام؛ لا توجد دلالة اتجاهية كافية دون تحليل إضافي.", False

def rss_items(symbol: str, company: str) -> list[dict[str, Any]]:
    query = quote_plus(f'"{symbol}" {company[:70]} stock')
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    r = requests.get(url, headers=NEWS_HEADERS, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []
    for item in root.findall("./channel/item")[:12]:
        title = clean_text(item.findtext("title", ""))
        link = item.findtext("link", "")
        desc = clean_text(item.findtext("description", ""))[:800]
        source_el = item.find("source")
        source = clean_text(source_el.text if source_el is not None else "Google News")
        if title and link:
            out.append({"symbol": symbol, "company_name": company, "title": title, "summary": desc, "source_name": source, "source_url": link, "published_at": parse_date(item.findtext("pubDate", ""))})
    return out

def sec_items(symbol: str, company: str, cik_map: dict[str, str]) -> list[dict[str, Any]]:
    cik = cik_map.get(symbol)
    if not cik: return []
    url = f"https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json"
    r = requests.get(url, headers=NEWS_HEADERS, timeout=30); r.raise_for_status(); data = r.json()
    recent = data.get("filings", {}).get("recent", {})
    out = []
    for i, form in enumerate(recent.get("form", [])):
        if form not in {"8-K", "10-Q", "10-K", "20-F", "6-K"} or i > 20: continue
        acc = recent["accessionNumber"][i].replace("-", "")
        doc = recent["primaryDocument"][i]
        cik_num = cik.lstrip("0")
        link = f"https://www.sec.gov/Archives/edgar/data/{cik_num}/{acc}/{doc}"
        title = f"{symbol} — SEC filing {form}: {recent['items'][i] if recent.get('items') else doc}"
        out.append({"symbol": symbol, "company_name": company, "title": title, "summary": f"إفصاح رسمي من هيئة SEC ({form}). افتح المصدر لمراجعة التفاصيل.", "source_name": "SEC", "source_url": link, "published_at": parse_date(recent["filingDate"][i])})
    return out[:5]

def upsert(rows: list[dict[str, Any]]) -> None:
    if not rows: return
    payload = []
    for row in rows:
        category, impact, reason, material = classify(row["title"], row.get("summary", ""), row["source_name"])
        payload.append({**row, "category": category, "impact": impact, "impact_reason": reason, "is_material": material})
    h = {**HEADERS, "Prefer": "resolution=ignore-duplicates,return=minimal"}
    # source_url هو المفتاح الفريد؛ نحدد هدف التعارض صراحة كي تُتجاهل الأخبار التي حُفظت في تشغيل سابق.
    r = requests.post(f"{SUPABASE_URL}/rest/v1/company_news?on_conflict=source_url", headers=h, data=json.dumps(payload, ensure_ascii=False), timeout=60)
    r.raise_for_status(); log.info("تمت معالجة %s خبرًا", len(payload))

def main() -> None:
    # المصدر الموحد للرموز: المراكز المفتوحة ثم جميع إشارات القوالب، ثم المتابعة الشخصية ومرشحو الفلاتر النشطون.
    symbols: dict[str, str] = {}
    def add(rows: list[dict[str, Any]]) -> None:
        for row in rows:
            symbol = str(row.get("symbol") or "").strip().upper()
            if symbol:
                symbols.setdefault(symbol, str(row.get("company") or row.get("company_name") or symbol))

    add(rest_get("shared_virtual_positions", "symbol", {"simulation_id": "eq.global"}))
    # لا نحدّها إلى قالب واحد أو أربعة أزرار واجهة؛ هذه نتيجة جميع القوالب المخزنة.
    add(rest_get("screener_signals", "symbol,company,entry_score", {"entry_score": "gt.0", "order": "entry_score.desc", "limit": "50"}))
    try:
        add(rest_get("watchlist", "symbol", {"order": "added_at.desc", "limit": "50"}))
    except requests.RequestException as exc:
        log.warning("تعذر قراءة قائمة المراقبة: %s", exc)
    try:
        add(rest_get("research_requests", "symbol", {"status": "eq.active", "order": "requested_at.desc", "limit": "50"}))
    except requests.RequestException as exc:
        log.warning("تعذر قراءة طلبات البحث: %s", exc)
    try:
        add(rest_get("manual_filter_candidates", "symbol", {"status": "eq.active", "expires_at": "gt." + datetime.now(timezone.utc).isoformat(), "order": "updated_at.desc", "limit": "14"}))
    except requests.RequestException as exc:
        log.warning("تعذر قراءة مرشحي فلترة الأسهم: %s", exc)

    if not symbols:
        log.info("لا توجد مراكز أو ترشيحات أو أسهم متابعة أو مرشحو فلترة لجلب أخبارها")
        return
    cik_map = {}
    try:
        t = requests.get("https://www.sec.gov/files/company_tickers.json", headers=NEWS_HEADERS, timeout=30); t.raise_for_status()
        for x in t.json().values(): cik_map[str(x["ticker"]).upper()] = str(x["cik_str"])
    except Exception as exc: log.warning("تعذر تحميل خريطة SEC: %s", exc)
    rows = []
    for symbol, company in list(symbols.items())[:60]:
        try:
            rows.extend(rss_items(symbol, company)); rows.extend(sec_items(symbol, company, cik_map))
        except Exception as exc: log.warning("تعذر جلب أخبار %s: %s", symbol, exc)
        time.sleep(0.25)
    upsert(rows)

if __name__ == "__main__": main()
