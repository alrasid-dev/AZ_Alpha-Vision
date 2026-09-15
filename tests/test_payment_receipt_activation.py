#!/usr/bin/env python3
"""Mirror of Node payment receipt activation tests."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone

ALLOWED = {299, 899}

def normalize_reference(raw: str) -> str:
    return "".join(str(raw or "").split()).upper()

def plan_from_amount(amount_sar):
    amount = float(amount_sar)
    if amount == 299:
        return {"amount_sar": 299, "days": 30, "plan_code": "monthly"}
    if amount == 899:
        return {"amount_sar": 899, "days": 90, "plan_code": "quarterly"}
    return None

def validate(amount_sar, reference, existing=None):
    ref = normalize_reference(reference)
    if not ref or len(ref) < 4:
        return {"ok": False, "code": "invalid_reference"}
    amount = float(amount_sar)
    if amount not in ALLOWED:
        return {"ok": False, "code": "wrong_amount"}
    existing_set = {normalize_reference(r) for r in (existing or [])}
    if ref in existing_set:
        return {"ok": False, "code": "duplicate_reference"}
    return {"ok": True, "plan": plan_from_amount(amount), "reference": ref}

def compute_expires(current, days, now):
    base = now
    if current:
        cur = datetime.fromisoformat(current.replace("Z", "+00:00"))
        if cur > now:
            base = cur
    return (base + timedelta(days=days)).isoformat().replace("+00:00", "Z")

def main():
    assert validate(299, "ABC12345", ["abc12345"])["code"] == "duplicate_reference"
    assert validate(499, "REF99999", [])["code"] == "wrong_amount"
    r299 = validate(299, "TXN299AAA", [])
    assert r299["ok"] and r299["plan"]["days"] == 30
    r899 = validate(899, "TXN899BBB", [])
    assert r899["ok"] and r899["plan"]["days"] == 90
    now = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
    exp = compute_expires(None, 30, now)
    assert exp.startswith("2026-10-15")
    print("PASS python payment_receipt_activation tests")

if __name__ == "__main__":
    main()
