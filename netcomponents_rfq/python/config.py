"""
Configuration for NetComponents RFQ automation
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from node directory (shared credentials)
env_path = Path(__file__).parent.parent / 'node' / '.env'
load_dotenv(env_path)

BASE_URL = "https://www.netcomponents.com"

NETCOMPONENTS_ACCOUNT = os.getenv('NETCOMPONENTS_ACCOUNT', '')
NETCOMPONENTS_USERNAME = os.getenv('NETCOMPONENTS_USERNAME', '')
NETCOMPONENTS_PASSWORD = os.getenv('NETCOMPONENTS_PASSWORD', '')

# Supplier filtering
MAX_SUPPLIERS_PER_REGION = 3

# Franchised/authorized distributors are identified by 'ncauth' class in DOM
# Independent distributors have 'ncnoauth' class
# No need for hardcoded name list - the page marks them

# Date code preferences - 2 year window is preferred
DC_PREFERRED_WINDOW_YEARS = 2

# Parallel processing settings
NUM_WORKERS = 3  # Number of parallel browser instances
JITTER_RANGE = 0.4  # ±40% timing variation (e.g., 2 sec becomes 1.2-2.8 sec)


def parse_date_code(dc_text):
    """
    Parse date code to extract 2-digit year and determine if it's ambiguous.

    Common formats:
    - YYWW (2217) = year 22, week 17
    - YY (25) = year 25
    - YY+ (22+) = year 22 or newer (ambiguous - could be fresh)
    - Ambiguous: 2022 could be year 2022 or YY=20, WW=22

    Returns: (year_2digit, is_ambiguous)
    - year_2digit: int or None
    - is_ambiguous: True if format is unclear (e.g., "2022", "20+")
    """
    if not dc_text:
        return None, False

    dc_raw = dc_text.strip().upper()

    # Check for "+" suffix (e.g., "20+" means "2020 or newer")
    # This is ambiguous because actual DC could be fresher
    has_plus = '+' in dc_raw
    dc = dc_raw.replace('+', '')

    # 2-digit year (e.g., "25", "22")
    if re.match(r'^\d{2}$', dc):
        return int(dc), has_plus  # Ambiguous if has "+"

    # 4-digit format
    if re.match(r'^\d{4}$', dc):
        num = int(dc)
        year = int(dc[:2])

        # Ambiguous case: 4-digit number could be a valid year (2020-2029)
        # e.g., "2022" - is it year 2022 or YYWW 20/22?
        # But "2318" cannot be year 2318, so it's clearly YYWW 23/18
        if 2020 <= num <= 2029:
            # Could be either full year or YYWW - ambiguous
            return year, True

        # Clear YYWW format (not a valid year number)
        return year, has_plus

    # Try to extract first 2 digits
    match = re.match(r'^(\d{2})', dc)
    if match:
        return int(match.group(1)), has_plus

    return None, False


def get_dc_status(dc_year, is_ambiguous, window_years=DC_PREFERRED_WINDOW_YEARS):
    """
    Determine date code status: 'fresh', 'old', or 'unknown'.

    - fresh: Confirmed within 2-year window (24+)
    - old: Confirmed older than window
    - unknown: No DC, ambiguous, or unparseable
    """
    if dc_year is None:
        return 'unknown'

    if is_ambiguous:
        return 'unknown'

    from datetime import datetime
    current_year = datetime.now().year % 100  # 2-digit year (26 for 2026)
    cutoff_year = current_year - window_years  # 24 for 2-year window

    if cutoff_year < 0:
        cutoff_year += 100

    if dc_year >= cutoff_year:
        return 'fresh'
    else:
        return 'old'


def supplier_priority_score(supplier, requested_qty):
    """
    Calculate priority score for supplier selection.
    Higher score = higher priority.

    Scoring tiers (date code should not rule out, just prioritize):
    1. Fresh DC + meets qty: 6 (best)
    2. Unknown/No DC + meets qty: 5 (benefit of the doubt)
    3. Fresh DC + below qty: 4
    4. Unknown/No DC + below qty: 3
    5. Old DC + meets qty: 2
    6. Old DC + below qty: 1 (still included, just lower priority)

    Within each tier, sort by quantity descending.
    Score formula: tier * 1_000_000_000 + quantity
    """
    dc_status = supplier.get('dc_status', 'unknown')
    meets_qty = supplier.get('total_qty', 0) >= requested_qty
    qty = supplier.get('total_qty', 0)

    if dc_status == 'fresh' and meets_qty:
        tier = 6
    elif dc_status == 'unknown' and meets_qty:
        tier = 5
    elif dc_status == 'fresh' and not meets_qty:
        tier = 4
    elif dc_status == 'unknown' and not meets_qty:
        tier = 3
    elif dc_status == 'old' and meets_qty:
        tier = 2
    else:  # old and not meets_qty
        tier = 1

    return tier * 1_000_000_000 + qty


def should_add_extra_supplier(selected_suppliers):
    """
    Returns True if we should add +1 supplier due to unknown/ambiguous date codes.
    """
    for s in selected_suppliers:
        if s.get('dc_status') == 'unknown':
            return True
    return False


def adjust_rfq_quantity(requested_qty, supplier_qty):
    """
    Adjust RFQ quantity when supplier has less than requested.

    If supplier can fulfill the full request, use requested qty.
    If supplier has less, use a "nice" whole number close to their stock.
    This encourages suppliers to quote (they feel they can win the order).

    Returns: (adjusted_qty, was_adjusted)
    """
    if supplier_qty >= requested_qty:
        return requested_qty, False

    # Supplier has less than we need - adjust to encourage quoting
    # Use a round number close to their stock
    target = supplier_qty

    # Round down to nearest "nice" number based on magnitude
    if target >= 1000:
        # Round to nearest 100
        adjusted = (target // 100) * 100
    elif target >= 100:
        # Round to nearest 25
        adjusted = (target // 25) * 25
    elif target >= 50:
        # Round to nearest 10
        adjusted = (target // 10) * 10
    elif target >= 10:
        # Round to nearest 5
        adjusted = (target // 5) * 5
    else:
        # Small qty - use as-is
        adjusted = target

    # Ensure we stay within 10% of their stock (don't round too aggressively)
    min_qty = int(supplier_qty * 0.9)
    if adjusted < min_qty:
        adjusted = target  # Just use their exact qty

    # Never request more than they have
    adjusted = min(adjusted, supplier_qty)

    # Ensure at least 1
    adjusted = max(adjusted, 1)

    return adjusted, True


# Need re for date code parsing
import re

# Paths
SCREENSHOTS_DIR = Path(__file__).parent / 'screenshots'
SCREENSHOTS_DIR.mkdir(exist_ok=True)
