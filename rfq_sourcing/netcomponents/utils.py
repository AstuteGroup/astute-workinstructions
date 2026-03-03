"""
Utility functions for NetComponents RFQ automation.
"""

import re
from datetime import datetime
from pathlib import Path


def sanitize_filename(name: str) -> str:
    """
    Sanitize a string for use as a filename.
    Removes/replaces invalid characters.
    """
    # Replace invalid characters with underscore
    sanitized = re.sub(r'[<>:"/\\|?*]', '_', name)
    # Remove leading/trailing whitespace and dots
    sanitized = sanitized.strip('. ')
    # Collapse multiple underscores
    sanitized = re.sub(r'_+', '_', sanitized)
    return sanitized


def timestamp_str(fmt: str = "%Y%m%d_%H%M%S") -> str:
    """Return current timestamp as formatted string."""
    return datetime.now().strftime(fmt)


def ensure_dir(path: Path) -> Path:
    """Ensure directory exists, create if needed."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def format_currency(amount: float, currency: str = "USD") -> str:
    """Format amount with currency symbol."""
    symbols = {
        "USD": "$",
        "EUR": "€",
        "GBP": "£",
        "JPY": "¥",
    }
    symbol = symbols.get(currency, currency + " ")
    return f"{symbol}{amount:,.2f}"


def format_quantity(qty: int) -> str:
    """
    Format quantity with K/M suffixes for readability.

    Examples:
        500 -> "500"
        1500 -> "1.5K"
        2500000 -> "2.5M"
    """
    if qty >= 1_000_000:
        return f"{qty / 1_000_000:.1f}M".rstrip('0').rstrip('.')
    elif qty >= 1_000:
        return f"{qty / 1_000:.1f}K".rstrip('0').rstrip('.')
    else:
        return str(qty)


def parse_part_number(raw: str) -> str:
    """
    Clean and normalize a part number string.
    Removes extra whitespace, converts to uppercase.
    """
    if not raw:
        return ""
    # Remove extra whitespace
    cleaned = " ".join(raw.split())
    # Uppercase
    cleaned = cleaned.upper()
    return cleaned


def chunk_list(items: list, chunk_size: int) -> list[list]:
    """Split a list into chunks of specified size."""
    return [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]


def print_table(headers: list[str], rows: list[list], col_widths: list[int] = None):
    """Print a simple ASCII table."""
    if not col_widths:
        col_widths = [max(len(str(h)), max(len(str(row[i])) for row in rows))
                      for i, h in enumerate(headers)]

    # Header
    header_row = " | ".join(str(h).ljust(w) for h, w in zip(headers, col_widths))
    separator = "-+-".join("-" * w for w in col_widths)

    print(header_row)
    print(separator)

    # Data rows
    for row in rows:
        data_row = " | ".join(str(cell).ljust(w) for cell, w in zip(row, col_widths))
        print(data_row)


class RateLimiter:
    """Simple rate limiter for API calls."""

    def __init__(self, min_interval: float = 1.0):
        self.min_interval = min_interval
        self._last_call = 0

    async def wait(self):
        """Wait if needed to respect rate limit."""
        import asyncio
        import time

        now = time.time()
        elapsed = now - self._last_call

        if elapsed < self.min_interval:
            await asyncio.sleep(self.min_interval - elapsed)

        self._last_call = time.time()
