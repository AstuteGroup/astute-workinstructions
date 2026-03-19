"""
Search functionality for NetComponents.
Handles part number searches and result parsing.
"""

import asyncio
import re
from dataclasses import dataclass, field
from typing import Optional
from playwright.async_api import Page

import config


@dataclass
class SearchResult:
    """Represents a single search result row."""
    supplier: str
    country: str
    quantity: int
    price: float
    currency: str = "USD"
    lead_time: str = ""
    date_code: str = ""
    row_index: int = 0
    raw_data: dict = field(default_factory=dict)

    @property
    def region(self) -> str:
        """Get the region classification for this result."""
        return config.get_region(self.country)


def parse_quantity(qty_str: str) -> int:
    """
    Parse quantity string to integer.
    Handles commas, K (thousands), M (millions) suffixes.

    Examples:
        "1,000" -> 1000
        "5K" -> 5000
        "2.5M" -> 2500000
        "500" -> 500
    """
    if not qty_str:
        return 0

    qty_str = qty_str.strip().upper().replace(",", "")

    try:
        # Handle K suffix (thousands)
        if qty_str.endswith("K"):
            return int(float(qty_str[:-1]) * 1000)

        # Handle M suffix (millions)
        if qty_str.endswith("M"):
            return int(float(qty_str[:-1]) * 1000000)

        # Handle plain numbers (may have decimals)
        return int(float(qty_str))

    except (ValueError, TypeError):
        return 0


def parse_price(price_str: str) -> tuple[float, str]:
    """
    Parse price string to float and currency.
    Strips currency symbols and extracts currency code.

    Examples:
        "$1.23" -> (1.23, "USD")
        "€0.95" -> (0.95, "EUR")
        "1.50 USD" -> (1.50, "USD")

    Returns:
        Tuple of (price, currency)
    """
    if not price_str:
        return (0.0, "USD")

    price_str = price_str.strip()

    # Detect currency
    currency = "USD"
    if "€" in price_str or "EUR" in price_str.upper():
        currency = "EUR"
    elif "£" in price_str or "GBP" in price_str.upper():
        currency = "GBP"
    elif "¥" in price_str or "JPY" in price_str.upper():
        currency = "JPY"

    # Extract numeric value
    # Remove currency symbols and letters, keep digits and decimal point
    numeric_str = re.sub(r"[^\d.]", "", price_str)

    try:
        price = float(numeric_str) if numeric_str else 0.0
    except ValueError:
        price = 0.0

    return (price, currency)


async def search_part(page: Page, part_number: str) -> list[SearchResult]:
    """
    Search for a part number and return parsed results.

    Args:
        page: Playwright page to use for search
        part_number: Part number to search for

    Returns:
        List of SearchResult objects
    """
    print(f"Searching for: {part_number}")

    try:
        # Navigate to search page
        await page.goto(config.SEARCH_URL, timeout=config.PAGE_LOAD_TIMEOUT)

        # Enter part number
        search_input = await page.wait_for_selector(
            config.SELECTORS["search_input"],
            timeout=config.PAGE_LOAD_TIMEOUT
        )
        await search_input.fill(part_number)

        # Submit search
        search_button = await page.wait_for_selector(
            config.SELECTORS["search_submit"],
            timeout=config.PAGE_LOAD_TIMEOUT
        )
        await search_button.click()

        # Wait for results or no-results message
        await asyncio.sleep(config.SEARCH_DELAY)

        # Check for no results
        no_results = await page.query_selector(config.SELECTORS["search_no_results"])
        if no_results:
            print(f"No results found for: {part_number}")
            return []

        # Wait for results table
        await page.wait_for_selector(
            config.SELECTORS["search_results"],
            timeout=config.PAGE_LOAD_TIMEOUT
        )

        # Parse the results table
        results = await _parse_results_table(page)
        print(f"Found {len(results)} results for: {part_number}")

        return results

    except Exception as e:
        print(f"Search error for {part_number}: {e}")
        return []


async def _parse_results_table(page: Page) -> list[SearchResult]:
    """
    Parse the HTML results table into SearchResult objects.

    Args:
        page: Playwright page with search results loaded

    Returns:
        List of SearchResult objects
    """
    results = []

    try:
        rows = await page.query_selector_all(config.SELECTORS["result_rows"])

        for index, row in enumerate(rows):
            try:
                # Extract cell values
                supplier_el = await row.query_selector(config.SELECTORS["result_supplier"])
                country_el = await row.query_selector(config.SELECTORS["result_country"])
                quantity_el = await row.query_selector(config.SELECTORS["result_quantity"])
                price_el = await row.query_selector(config.SELECTORS["result_price"])
                lead_time_el = await row.query_selector(config.SELECTORS["result_lead_time"])
                date_code_el = await row.query_selector(config.SELECTORS["result_date_code"])

                # Get text content
                supplier = await supplier_el.inner_text() if supplier_el else ""
                country = await country_el.inner_text() if country_el else ""
                quantity_str = await quantity_el.inner_text() if quantity_el else "0"
                price_str = await price_el.inner_text() if price_el else "0"
                lead_time = await lead_time_el.inner_text() if lead_time_el else ""
                date_code = await date_code_el.inner_text() if date_code_el else ""

                # Parse values
                quantity = parse_quantity(quantity_str)
                price, currency = parse_price(price_str)

                result = SearchResult(
                    supplier=supplier.strip(),
                    country=country.strip(),
                    quantity=quantity,
                    price=price,
                    currency=currency,
                    lead_time=lead_time.strip(),
                    date_code=date_code.strip(),
                    row_index=index,
                    raw_data={
                        "quantity_str": quantity_str,
                        "price_str": price_str,
                    }
                )
                results.append(result)

            except Exception as e:
                print(f"Error parsing row {index}: {e}")
                continue

    except Exception as e:
        print(f"Error parsing results table: {e}")

    return results


def filter_by_region(
    results: list[SearchResult],
    max_per_region: int = None
) -> dict[str, list[SearchResult]]:
    """
    Group results by region and limit per region.

    Args:
        results: List of search results
        max_per_region: Max results per region (defaults to config value)

    Returns:
        Dict with keys 'americas', 'europe', 'other', each containing list of results
    """
    if max_per_region is None:
        max_per_region = config.MAX_SUPPLIERS_PER_REGION

    grouped = {
        "americas": [],
        "europe": [],
        "other": [],
    }

    for result in results:
        region = result.region
        if len(grouped[region]) < max_per_region:
            grouped[region].append(result)

    return grouped


def select_suppliers(
    results: list[SearchResult],
    max_per_region: int = None
) -> list[SearchResult]:
    """
    Select suppliers according to regional limits.

    Args:
        results: List of search results
        max_per_region: Max suppliers per region

    Returns:
        Filtered list of results respecting regional limits
    """
    grouped = filter_by_region(results, max_per_region)

    selected = []
    selected.extend(grouped["americas"])
    selected.extend(grouped["europe"])
    selected.extend(grouped["other"])

    return selected
