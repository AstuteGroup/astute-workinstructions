"""
Configuration for NetComponents RFQ automation.
Loads credentials from environment variables with optional .env fallback.
"""

import os
from pathlib import Path

# Try to load .env file if python-dotenv is installed
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# =============================================================================
# Credentials
# =============================================================================
NETCOMPONENTS_ACCOUNT = os.getenv("NETCOMPONENTS_ACCOUNT", "")
NETCOMPONENTS_USERNAME = os.getenv("NETCOMPONENTS_USERNAME", "")
NETCOMPONENTS_PASSWORD = os.getenv("NETCOMPONENTS_PASSWORD", "")

# =============================================================================
# URLs
# =============================================================================
BASE_URL = "https://www.netcomponents.com"
LOGIN_URL = f"{BASE_URL}/login"
SEARCH_URL = f"{BASE_URL}/search"
RFQ_URL = f"{BASE_URL}/rfq"

# =============================================================================
# Rate Limiting & Delays (seconds)
# =============================================================================
SEARCH_DELAY = 2.0          # Delay between searches
RFQ_DELAY = 1.5             # Delay between RFQ submissions
PAGE_LOAD_TIMEOUT = 30000   # Milliseconds
LOGIN_TIMEOUT = 60000       # Milliseconds - login may require 2FA

# =============================================================================
# Supplier Selection
# =============================================================================
MAX_SUPPLIERS_PER_REGION = 3

# Americas region countries
AMERICAS_COUNTRIES = {
    "united states", "usa", "us", "u.s.a.", "u.s.",
    "canada", "ca",
    "mexico", "mx",
    "brazil", "br",
    "argentina", "ar",
    "chile", "cl",
    "colombia", "co",
    "peru", "pe",
}

# Europe region countries
EUROPE_COUNTRIES = {
    "united kingdom", "uk", "u.k.", "great britain", "gb",
    "germany", "de", "deutschland",
    "france", "fr",
    "italy", "it",
    "spain", "es",
    "netherlands", "nl", "holland",
    "belgium", "be",
    "switzerland", "ch",
    "austria", "at",
    "sweden", "se",
    "denmark", "dk",
    "norway", "no",
    "finland", "fi",
    "poland", "pl",
    "ireland", "ie",
    "portugal", "pt",
    "czech republic", "cz",
    "hungary", "hu",
}

# =============================================================================
# CSS Selectors (PLACEHOLDERS - update after inspecting live site)
# =============================================================================
SELECTORS = {
    # Login page
    "login_account": "#account",              # Account number field
    "login_username": "#username",            # Username field
    "login_password": "#password",            # Password field
    "login_submit": "#login-button",          # Login button
    "login_success": ".user-menu",            # Element visible when logged in

    # Search page
    "search_input": "#part-search",           # Part number input
    "search_submit": "#search-button",        # Search button
    "search_results": ".results-table",       # Results table container
    "search_no_results": ".no-results",       # No results message

    # Results table
    "result_rows": ".results-table tbody tr", # Result rows
    "result_supplier": "td.supplier",         # Supplier name cell
    "result_country": "td.country",           # Country cell
    "result_quantity": "td.quantity",         # Quantity cell
    "result_price": "td.price",               # Price cell
    "result_lead_time": "td.lead-time",       # Lead time cell
    "result_date_code": "td.date-code",       # Date code cell
    "result_checkbox": "input[type=checkbox]",# Row selection checkbox

    # RFQ form
    "rfq_quantity": "#rfq-quantity",          # Quantity input
    "rfq_target_price": "#rfq-target-price",  # Target price input
    "rfq_submit": "#rfq-submit",              # Submit RFQ button
    "rfq_success": ".rfq-confirmation",       # RFQ success message
}

# =============================================================================
# Session Persistence
# =============================================================================
PROJECT_ROOT = Path(__file__).parent
SESSION_DIR = PROJECT_ROOT / ".session"
COOKIES_FILE = SESSION_DIR / "cookies.json"
SCREENSHOTS_DIR = PROJECT_ROOT / "screenshots"
OUTPUT_DIR = PROJECT_ROOT / "output"

# Ensure directories exist
SESSION_DIR.mkdir(exist_ok=True)
SCREENSHOTS_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# =============================================================================
# Helper Functions
# =============================================================================

def validate_credentials() -> bool:
    """Check if all required credentials are set."""
    if not NETCOMPONENTS_ACCOUNT:
        print("Error: NETCOMPONENTS_ACCOUNT not set")
        return False
    if not NETCOMPONENTS_USERNAME:
        print("Error: NETCOMPONENTS_USERNAME not set")
        return False
    if not NETCOMPONENTS_PASSWORD:
        print("Error: NETCOMPONENTS_PASSWORD not set")
        return False
    return True


def get_region(country: str) -> str:
    """
    Classify a country into a region using fuzzy matching.
    Returns: 'americas', 'europe', or 'other'
    """
    country_lower = country.lower().strip()

    # Direct match
    if country_lower in AMERICAS_COUNTRIES:
        return "americas"
    if country_lower in EUROPE_COUNTRIES:
        return "europe"

    # Fuzzy match - check if country contains or is contained by known values
    for americas_country in AMERICAS_COUNTRIES:
        if americas_country in country_lower or country_lower in americas_country:
            return "americas"

    for europe_country in EUROPE_COUNTRIES:
        if europe_country in country_lower or country_lower in europe_country:
            return "europe"

    return "other"


def get_masked_credentials() -> dict:
    """Return credentials with password masked for logging."""
    return {
        "account": NETCOMPONENTS_ACCOUNT,
        "username": NETCOMPONENTS_USERNAME,
        "password": "*" * len(NETCOMPONENTS_PASSWORD) if NETCOMPONENTS_PASSWORD else "(not set)",
    }
