"""
RFQ History Tracking

Tracks RFQ submissions for:
1. Cooldown enforcement (60-day same MPN/supplier window)
2. Supplier template prioritization (identify high-volume suppliers for VQ parser templates)

Data file: ../rfq_history.json
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# Config
HISTORY_FILE = Path(__file__).parent.parent / "rfq_history.json"
DEFAULT_COOLDOWN_DAYS = 60
MEMORY_COOLDOWN_DAYS = 14  # Memory products change price frequently
NOBID_COOLDOWN_DAYS = 90   # Longer cooldown after no-bid

# Memory product prefixes (DRAM, Flash, SRAM)
MEMORY_PREFIXES = ['MT', 'K4', 'K9', 'H5', 'W25', 'IS42', 'NT', 'AS4', 'CY7', 'IS6']


def load_history() -> dict:
    """Load RFQ history from JSON file."""
    if not HISTORY_FILE.exists():
        return {
            "version": "1.0",
            "lastUpdated": datetime.now().isoformat(),
            "rfqHistory": [],
            "supplierStats": {}
        }

    try:
        with open(HISTORY_FILE, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {
            "version": "1.0",
            "lastUpdated": datetime.now().isoformat(),
            "rfqHistory": [],
            "supplierStats": {}
        }


def save_history(data: dict):
    """Save RFQ history to JSON file."""
    data["lastUpdated"] = datetime.now().isoformat()
    with open(HISTORY_FILE, 'w') as f:
        json.dump(data, f, indent=2)


def is_memory_product(mpn: str) -> bool:
    """Check if MPN is a memory product (shorter cooldown)."""
    upper = mpn.upper()
    return any(upper.startswith(prefix) for prefix in MEMORY_PREFIXES)


def get_cooldown_days(mpn: str, was_nobid: bool = False) -> int:
    """Get cooldown period based on product type and response."""
    if was_nobid:
        return NOBID_COOLDOWN_DAYS
    if is_memory_product(mpn):
        return MEMORY_COOLDOWN_DAYS
    return DEFAULT_COOLDOWN_DAYS


def check_cooldown(supplier: str, mpn: str) -> tuple[bool, Optional[dict]]:
    """
    Check if supplier+MPN combination is in cooldown period.

    Returns:
        (is_blocked, matching_record)
        - is_blocked: True if should skip this supplier
        - matching_record: The history record that caused the block (for logging)
    """
    data = load_history()
    now = datetime.now()

    # Normalize for matching
    supplier_lower = supplier.lower().strip()
    mpn_upper = mpn.upper().strip()

    for record in data.get("rfqHistory", []):
        # Match supplier (fuzzy - first 15 chars)
        rec_supplier = record.get("supplier", "").lower().strip()
        if rec_supplier[:15] != supplier_lower[:15]:
            continue

        # Match MPN (exact after normalization)
        rec_mpn = record.get("mpn", "").upper().strip()
        if rec_mpn != mpn_upper:
            continue

        # Check date
        try:
            rfq_date = datetime.fromisoformat(record["rfqDate"].replace("Z", "+00:00").replace("+00:00", ""))
        except (ValueError, KeyError):
            continue

        # Determine cooldown
        was_nobid = record.get("response") == "no-bid"
        cooldown = get_cooldown_days(mpn, was_nobid)

        if now - rfq_date < timedelta(days=cooldown):
            return True, record

    return False, None


def record_rfq(supplier: str, mpn: str, qty: int, rfq_id: str = "", region: str = ""):
    """
    Record an RFQ submission.

    Args:
        supplier: Supplier name
        mpn: Part number
        qty: Quantity requested
        rfq_id: Optional RFQ ID from system
        region: Americas/Europe
    """
    data = load_history()

    record = {
        "supplier": supplier,
        "mpn": mpn.upper(),
        "qty": qty,
        "rfqDate": datetime.now().strftime("%Y-%m-%d"),
        "rfqId": rfq_id,
        "region": region,
        "response": "pending"
    }

    data["rfqHistory"].append(record)

    # Update supplier stats
    stats = data.get("supplierStats", {})
    if supplier not in stats:
        stats[supplier] = {
            "totalRfqs": 0,
            "lastRfqDate": "",
            "region": region,
            "mpns": []
        }

    stats[supplier]["totalRfqs"] += 1
    stats[supplier]["lastRfqDate"] = record["rfqDate"]
    if mpn.upper() not in stats[supplier]["mpns"]:
        stats[supplier]["mpns"].append(mpn.upper())

    data["supplierStats"] = stats
    save_history(data)


def update_response(supplier: str, mpn: str, response: str):
    """
    Update response status for a previous RFQ.
    Called by VQ Parser when quote or no-bid received.

    Args:
        supplier: Supplier name
        mpn: Part number
        response: "quoted" | "no-bid" | "pending"
    """
    data = load_history()

    supplier_lower = supplier.lower().strip()
    mpn_upper = mpn.upper().strip()

    # Find most recent matching record
    for record in reversed(data.get("rfqHistory", [])):
        rec_supplier = record.get("supplier", "").lower().strip()
        rec_mpn = record.get("mpn", "").upper().strip()

        if rec_supplier[:15] == supplier_lower[:15] and rec_mpn == mpn_upper:
            record["response"] = response
            record["responseDate"] = datetime.now().strftime("%Y-%m-%d")
            break

    save_history(data)


def get_supplier_rankings(min_rfqs: int = 5) -> list[dict]:
    """
    Get suppliers ranked by RFQ volume for template prioritization.

    Returns list of suppliers with stats, sorted by total RFQs descending.
    Use this to identify which suppliers need VQ parser templates.
    """
    data = load_history()
    stats = data.get("supplierStats", {})

    rankings = []
    for supplier, info in stats.items():
        if info["totalRfqs"] >= min_rfqs:
            rankings.append({
                "supplier": supplier,
                "totalRfqs": info["totalRfqs"],
                "lastRfqDate": info["lastRfqDate"],
                "region": info["region"],
                "uniqueMpns": len(info.get("mpns", []))
            })

    return sorted(rankings, key=lambda x: x["totalRfqs"], reverse=True)


def print_supplier_rankings(min_rfqs: int = 3):
    """Print supplier rankings for template prioritization."""
    rankings = get_supplier_rankings(min_rfqs)

    if not rankings:
        print(f"No suppliers with {min_rfqs}+ RFQs yet.")
        return

    print(f"\n{'='*60}")
    print("SUPPLIER TEMPLATE PRIORITIZATION")
    print(f"Suppliers with {min_rfqs}+ RFQs (candidates for VQ parser templates)")
    print(f"{'='*60}\n")

    print(f"{'Rank':<5} {'Supplier':<35} {'RFQs':<6} {'MPNs':<6} {'Region':<10}")
    print("-" * 65)

    for i, s in enumerate(rankings[:20], 1):
        print(f"{i:<5} {s['supplier'][:34]:<35} {s['totalRfqs']:<6} {s['uniqueMpns']:<6} {s['region']:<10}")

    print(f"\nTotal: {len(rankings)} suppliers with {min_rfqs}+ RFQs")


def get_history_summary() -> dict:
    """Get summary statistics."""
    data = load_history()
    history = data.get("rfqHistory", [])

    total = len(history)
    pending = sum(1 for r in history if r.get("response") == "pending")
    quoted = sum(1 for r in history if r.get("response") == "quoted")
    nobid = sum(1 for r in history if r.get("response") == "no-bid")

    return {
        "totalRfqs": total,
        "pending": pending,
        "quoted": quoted,
        "noBid": nobid,
        "uniqueSuppliers": len(data.get("supplierStats", {})),
        "lastUpdated": data.get("lastUpdated", "")
    }


# CLI for manual operations
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage:")
        print("  python rfq_history.py rankings [min_rfqs]  - Show supplier rankings")
        print("  python rfq_history.py summary              - Show history summary")
        print("  python rfq_history.py check <supplier> <mpn> - Check cooldown")
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "rankings":
        min_rfqs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
        print_supplier_rankings(min_rfqs)

    elif cmd == "summary":
        summary = get_history_summary()
        print(f"\nRFQ History Summary")
        print(f"==================")
        print(f"Total RFQs:        {summary['totalRfqs']}")
        print(f"  Pending:         {summary['pending']}")
        print(f"  Quoted:          {summary['quoted']}")
        print(f"  No-bid:          {summary['noBid']}")
        print(f"Unique Suppliers:  {summary['uniqueSuppliers']}")
        print(f"Last Updated:      {summary['lastUpdated']}")

    elif cmd == "check" and len(sys.argv) >= 4:
        supplier = sys.argv[2]
        mpn = sys.argv[3]
        blocked, record = check_cooldown(supplier, mpn)
        if blocked:
            print(f"BLOCKED: {supplier} + {mpn}")
            print(f"  Previous RFQ: {record['rfqDate']}")
            print(f"  Response: {record.get('response', 'pending')}")
        else:
            print(f"OK: {supplier} + {mpn} - no cooldown active")
