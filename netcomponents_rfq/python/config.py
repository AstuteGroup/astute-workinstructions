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
TOTAL_SUPPLIERS_TARGET = 6  # Flexible across regions via cross-region balancing

# Coverage-based selection thresholds
GOOD_COVERAGE_THRESHOLD = 0.80  # 80% cumulative = good coverage achieved
MIN_INDIVIDUAL_QTY_PERCENT = 0.10  # 10% minimum for suppliers after good coverage reached

# Franchised/authorized distributors are identified by 'ncauth' class in DOM
# Independent distributors have 'ncnoauth' class
# No need for hardcoded name list - the page marks them

# Date code preferences - 2 year window is preferred
DC_PREFERRED_WINDOW_YEARS = 2

# Min order value filtering (uses franchise pricing from FindChips)
# Multiplier depends on franchise availability:
#   - ABUNDANT: franchise_qty >= customer_qty → broker must offer big savings to compete
#   - SCARCE: franchise_qty < customer_qty → secondary market has leverage
MIN_ORDER_VALUE_MULTIPLIER_ABUNDANT = 0.2  # When franchise can fully meet demand
MIN_ORDER_VALUE_MULTIPLIER_SCARCE = 0.7    # When franchise cannot meet demand

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

    - fresh: Within 2-year window (24+), including "24+" format (guaranteed fresh)
    - old: Confirmed older than window
    - unknown: No DC or unparseable
    """
    if dc_year is None:
        return 'unknown'

    from datetime import datetime
    current_year = datetime.now().year % 100  # 2-digit year (26 for 2026)
    cutoff_year = current_year - window_years  # 24 for 2-year window

    if cutoff_year < 0:
        cutoff_year += 100

    if dc_year >= cutoff_year:
        # Fresh - even if ambiguous (e.g., "24+"), since the minimum is within window
        return 'fresh'
    elif is_ambiguous:
        # Ambiguous and below cutoff (e.g., "20+") - could be fresher, treat as unknown
        return 'unknown'
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

    For suppliers meeting qty: all equal within tier (qty doesn't matter)
    For suppliers below qty: sort by quantity descending (maximize piecing)
    Score formula: tier * 1_000_000_000 + (quantity if below qty else 0)
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

    # Quantity only matters for tiebreaking when below requested qty
    # If meets qty, all are equal within tier
    tiebreaker = qty if not meets_qty else 0
    return tier * 1_000_000_000 + tiebreaker


def should_add_extra_supplier(selected_suppliers):
    """
    Returns True if we should add +1 supplier due to unknown/ambiguous date codes.
    """
    for s in selected_suppliers:
        if s.get('dc_status') == 'unknown':
            return True
    return False


def filter_by_coverage(suppliers, requested_qty):
    """
    Filter suppliers using coverage-based selection logic.

    Logic:
    1. Sort suppliers by qty (descending)
    2. Calculate cumulative coverage as we add suppliers
    3. Once we reach GOOD_COVERAGE_THRESHOLD (80%):
       - Only add more suppliers if they have >= MIN_INDIVIDUAL_QTY_PERCENT (10%) of request
       - We have good coverage, no need for tiny quantities
    4. If coverage is sparse (< 80%), include all suppliers to maximize piecing potential

    Args:
        suppliers: List of supplier dicts with 'total_qty' key
        requested_qty: Customer's requested quantity

    Returns:
        Filtered list of suppliers
    """
    if not suppliers or requested_qty <= 0:
        return suppliers

    # Sort by quantity descending
    sorted_suppliers = sorted(suppliers, key=lambda x: x.get('total_qty', 0), reverse=True)

    selected = []
    cumulative_qty = 0
    good_coverage_reached = False

    for supplier in sorted_suppliers:
        supplier_qty = supplier.get('total_qty', 0)

        # Check if we've reached good coverage
        if cumulative_qty >= requested_qty * GOOD_COVERAGE_THRESHOLD:
            good_coverage_reached = True

        # If good coverage reached, only add meaningful contributors
        if good_coverage_reached:
            individual_percent = supplier_qty / requested_qty if requested_qty > 0 else 0
            if individual_percent < MIN_INDIVIDUAL_QTY_PERCENT:
                # Skip - too small to matter when we already have good coverage
                continue

        selected.append(supplier)
        cumulative_qty += supplier_qty

    return selected


def calculate_region_slots(americas_available, europe_available):
    """
    Calculate how many suppliers to select from each region using cross-region balancing.

    Logic:
    - Target TOTAL_SUPPLIERS_TARGET (6) suppliers total
    - Default MAX_SUPPLIERS_PER_REGION (3) per region
    - If one region has fewer suppliers, give extra slots to the other region

    Args:
        americas_available: Number of qualifying Americas suppliers
        europe_available: Number of qualifying Europe suppliers

    Returns:
        (americas_slots, europe_slots): Tuple of how many to select from each region
    """
    target = TOTAL_SUPPLIERS_TARGET
    default_per_region = MAX_SUPPLIERS_PER_REGION

    # Start with default allocation
    americas_slots = min(americas_available, default_per_region)
    europe_slots = min(europe_available, default_per_region)

    # If Americas is short, give extra slots to Europe
    americas_shortfall = default_per_region - americas_slots
    if americas_shortfall > 0:
        extra_europe = min(americas_shortfall, europe_available - europe_slots)
        europe_slots += extra_europe

    # If Europe is short, give extra slots to Americas
    europe_shortfall = default_per_region - europe_slots
    if europe_shortfall > 0:
        extra_americas = min(europe_shortfall, americas_available - americas_slots)
        americas_slots += extra_americas

    # Ensure we don't exceed target total
    total = americas_slots + europe_slots
    if total > target:
        # Trim from the region with more slots
        excess = total - target
        if europe_slots > americas_slots:
            europe_slots -= excess
        else:
            americas_slots -= excess

    return americas_slots, europe_slots


def should_skip_for_min_order_value(supplier, franchise_data):
    """
    Determine if supplier should be skipped based on min order value.

    Logic:
      est_value = franchise_bulk_price × supplier_qty × multiplier
      Skip if: min_order_value > est_value

    Args:
        supplier: dict with 'total_qty', 'min_order_value'
        franchise_data: dict with 'franchise_qty', 'franchise_bulk_price', 'customer_qty'

    Returns:
        (should_skip: bool, reason: str, details: dict)
    """
    # If no franchise data provided, don't filter
    if not franchise_data:
        return False, None, {}

    franchise_bulk_price = franchise_data.get('franchise_bulk_price')
    franchise_qty = franchise_data.get('franchise_qty', 0)
    customer_qty = franchise_data.get('customer_qty', 0)

    # If no bulk price, can't calculate - don't filter
    if not franchise_bulk_price or franchise_bulk_price <= 0:
        return False, None, {}

    supplier_qty = supplier.get('total_qty', 0)
    min_order_value = supplier.get('min_order_value')

    # If no min order value on supplier, don't filter
    if min_order_value is None or min_order_value <= 0:
        return False, None, {}

    # Determine multiplier based on franchise availability
    if franchise_qty >= customer_qty:
        multiplier = MIN_ORDER_VALUE_MULTIPLIER_ABUNDANT  # 0.2
        availability = 'abundant'
    else:
        multiplier = MIN_ORDER_VALUE_MULTIPLIER_SCARCE    # 0.7
        availability = 'scarce'

    # Calculate estimated opportunity value
    est_value = franchise_bulk_price * supplier_qty * multiplier

    details = {
        'min_order_value': min_order_value,
        'franchise_bulk_price': franchise_bulk_price,
        'supplier_qty': supplier_qty,
        'multiplier': multiplier,
        'est_value': round(est_value, 2),
        'availability': availability
    }

    # Skip if min order value exceeds estimated opportunity value
    if min_order_value > est_value:
        reason = f"Min order ${min_order_value:.2f} > est value ${est_value:.2f} ({availability}, mult={multiplier})"
        return True, reason, details

    return False, None, details


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


async def extract_min_order_value(page):
    """
    Extract minimum order value from supplier detail popup.

    Looks for "Minimum Order:" text followed by a dollar amount.
    Returns: float or None
    """
    try:
        # Look for the supplier-offices popup which contains min order info
        supplier_info = await page.query_selector('.supplier-offices, .supplier-office')
        if not supplier_info:
            return None

        text = await supplier_info.inner_text()

        # Look for "Minimum Order:" followed by dollar amount
        # Pattern: "Minimum Order:\n$25.00USD" or "Minimum Order: $100.00"
        import re
        match = re.search(r'Minimum Order[:\s]*\$?([\d,]+\.?\d*)', text, re.IGNORECASE)
        if match:
            value_str = match.group(1).replace(',', '')
            return float(value_str)

        return None
    except Exception:
        return None


# Need re for date code parsing
import re

# Paths
SCREENSHOTS_DIR = Path(__file__).parent / 'screenshots'
SCREENSHOTS_DIR.mkdir(exist_ok=True)
