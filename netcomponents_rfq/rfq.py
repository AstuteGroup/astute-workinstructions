"""
RFQ (Request for Quote) submission functionality.
Handles selecting suppliers and submitting quote requests.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from playwright.async_api import Page

import config
from search import SearchResult


@dataclass
class RFQRequest:
    """Represents an RFQ to be submitted."""
    part_number: str
    quantity: int
    target_price: Optional[float] = None
    suppliers: list[SearchResult] = field(default_factory=list)


@dataclass
class RFQResult:
    """Result of an RFQ submission attempt."""
    part_number: str
    supplier: str
    success: bool
    message: str = ""
    timestamp: datetime = field(default_factory=datetime.now)
    screenshot_path: Optional[str] = None


async def submit_rfq(
    page: Page,
    result: SearchResult,
    quantity: int,
    target_price: Optional[float] = None,
    dry_run: bool = False
) -> RFQResult:
    """
    Submit an RFQ to a single supplier.

    Args:
        page: Playwright page to use
        result: SearchResult containing supplier info
        quantity: Quantity to request
        target_price: Optional target price
        dry_run: If True, don't actually submit

    Returns:
        RFQResult with success/failure info
    """
    supplier = result.supplier
    print(f"  Submitting RFQ to {supplier} ({result.country})...")

    if dry_run:
        print(f"    [DRY RUN] Would submit RFQ for qty {quantity}")
        return RFQResult(
            part_number="",
            supplier=supplier,
            success=True,
            message="Dry run - not submitted"
        )

    try:
        # Select this supplier's row (click checkbox)
        # Note: This assumes we're on the search results page
        rows = await page.query_selector_all(config.SELECTORS["result_rows"])

        if result.row_index >= len(rows):
            return RFQResult(
                part_number="",
                supplier=supplier,
                success=False,
                message=f"Row index {result.row_index} out of range"
            )

        row = rows[result.row_index]
        checkbox = await row.query_selector(config.SELECTORS["result_checkbox"])

        if checkbox:
            await checkbox.click()
            await asyncio.sleep(0.5)

        # Fill quantity
        qty_input = await page.wait_for_selector(
            config.SELECTORS["rfq_quantity"],
            timeout=config.PAGE_LOAD_TIMEOUT
        )
        await qty_input.fill(str(quantity))

        # Fill target price if provided
        if target_price is not None:
            price_input = await page.query_selector(config.SELECTORS["rfq_target_price"])
            if price_input:
                await price_input.fill(str(target_price))

        # Submit RFQ
        submit_button = await page.wait_for_selector(
            config.SELECTORS["rfq_submit"],
            timeout=config.PAGE_LOAD_TIMEOUT
        )
        await submit_button.click()

        # Wait for confirmation
        await page.wait_for_selector(
            config.SELECTORS["rfq_success"],
            timeout=config.PAGE_LOAD_TIMEOUT
        )

        await asyncio.sleep(config.RFQ_DELAY)

        return RFQResult(
            part_number="",
            supplier=supplier,
            success=True,
            message="RFQ submitted successfully"
        )

    except Exception as e:
        error_msg = f"RFQ submission failed: {e}"
        print(f"    Error: {error_msg}")
        return RFQResult(
            part_number="",
            supplier=supplier,
            success=False,
            message=error_msg
        )


async def submit_rfqs_for_part(
    page: Page,
    part_number: str,
    suppliers: list[SearchResult],
    quantity: int,
    target_price: Optional[float] = None,
    dry_run: bool = False
) -> list[RFQResult]:
    """
    Submit RFQs to multiple suppliers for a single part.

    Args:
        page: Playwright page to use
        part_number: The part number being quoted
        suppliers: List of suppliers to send RFQs to
        quantity: Quantity to request
        target_price: Optional target price
        dry_run: If True, don't actually submit

    Returns:
        List of RFQResult objects
    """
    results = []

    print(f"Submitting RFQs for {part_number} to {len(suppliers)} suppliers...")

    for supplier_result in suppliers:
        rfq_result = await submit_rfq(
            page=page,
            result=supplier_result,
            quantity=quantity,
            target_price=target_price,
            dry_run=dry_run
        )
        rfq_result.part_number = part_number
        results.append(rfq_result)

    successful = sum(1 for r in results if r.success)
    print(f"  Completed: {successful}/{len(results)} RFQs submitted")

    return results


def summarize_rfq_results(results: list[RFQResult]) -> dict:
    """
    Generate a summary of RFQ submission results.

    Args:
        results: List of RFQResult objects

    Returns:
        Summary dict with counts and details
    """
    total = len(results)
    successful = [r for r in results if r.success]
    failed = [r for r in results if not r.success]

    summary = {
        "total": total,
        "successful": len(successful),
        "failed": len(failed),
        "success_rate": len(successful) / total if total > 0 else 0,
        "successful_suppliers": [r.supplier for r in successful],
        "failed_suppliers": [(r.supplier, r.message) for r in failed],
    }

    return summary
