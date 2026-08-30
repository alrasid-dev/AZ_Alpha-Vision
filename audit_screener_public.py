import json
import requests

SUPABASE_URL = "https://riktmjqbixqlqwqwqoyc.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_TMew47Ce-t8NuuJ-4Mpw5w_sa6ckPjf"
HEADERS = {"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {SUPABASE_ANON_KEY}"}
TABLES = [
    ("market_fundamentals", "symbol,price,exchange"),
    ("market_technicals", "symbol,price,rsi14,sma20,sma50,sma200"),
    ("screener_signals", "symbol,preset,entry_score,entry_tier,updated_at"),
    ("screener_alerts", "symbol,type,ts"),
]

for table, select in TABLES:
    rows = []
    status = None
    error = None
    for offset in range(0, 20000, 1000):
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS,
            params={"select": select, "limit": "1000", "offset": str(offset)},
            timeout=30,
        )
        status = response.status_code
        if not response.ok:
            error = response.text[:500]
            break
        batch = response.json() or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
    result = {"table": table, "status": status}
    if error:
        result["error"] = error
    else:
        result["rows"] = len(rows)
        result["symbols"] = len({str(r.get("symbol") or "").upper() for r in rows if r.get("symbol")})
        if table == "screener_signals":
            result["presets"] = sorted({str(r.get("preset") or "") for r in rows if r.get("preset")})
            result["positive_entry_rows"] = sum(float(r.get("entry_score") or 0) > 0 for r in rows)
    print(json.dumps(result, ensure_ascii=False))

print(json.dumps({"note": "هذا فحص قراءة فقط ولا يغيّر قاعدة البيانات."}, ensure_ascii=False))
تعليقات = None
