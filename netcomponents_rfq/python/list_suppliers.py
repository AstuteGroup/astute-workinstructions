#!/usr/bin/env python3
"""
List qualifying in-stock suppliers for a part number (market check)

Usage:
    python list_suppliers.py <part_number> <min_quantity>

Example:
    python list_suppliers.py "DS3231SN#" 1000
"""

import sys
import asyncio
from playwright.async_api import async_playwright
import config


async def main():
    if len(sys.argv) < 3:
        print('Usage: python list_suppliers.py <part_number> <min_quantity>')
        print('Example: python list_suppliers.py "DS3231SN#" 1000')
        sys.exit(1)

    part_number = sys.argv[1]
    min_qty = int(sys.argv[2])

    print('=' * 50)
    print('NetComponents Supplier Search')
    print(f'Part: {part_number}')
    print(f'Min Quantity: {min_qty:,}')
    print('=' * 50)
    print()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1400, 'height': 1000})
        page = await context.new_page()

        try:
            # Login
            print('Logging in...')
            await page.goto(config.BASE_URL)
            await asyncio.sleep(2)
            await page.click('a:has-text("Login")')
            await asyncio.sleep(2)
            await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT)
            await page.fill('#UserName', config.NETCOMPONENTS_USERNAME)
            await page.fill('#Password', config.NETCOMPONENTS_PASSWORD)
            await page.press('#Password', 'Enter')
            await asyncio.sleep(5)
            print('  Done\n')

            # Search
            print(f'Searching for {part_number}...')
            await page.fill('#PartsSearched_0__PartNumber', part_number)
            await page.click('#btnSearch')
            await asyncio.sleep(8)
            print('  Done\n')

            # Parse suppliers
            print('Parsing results...\n')
            rows = await page.query_selector_all('table#trv_0 tbody tr')

            # Track by supplier name + region
            supplier_data = {}  # key: "name|region" -> {name, region, total_qty}
            in_stock_section = False
            current_region = 'Unknown'

            for row in rows:
                row_text = (await row.inner_text() or '').lower()

                # Track region headers
                if 'americas' in row_text and 'inventory' not in row_text and len(row_text) < 50:
                    current_region = 'Americas'
                    continue
                if 'europe' in row_text and 'inventory' not in row_text and len(row_text) < 50:
                    current_region = 'Europe'
                    continue
                if ('asia' in row_text or 'other' in row_text) and 'inventory' not in row_text and len(row_text) < 50:
                    current_region = 'Asia/Other'
                    continue

                # Check for section subheader rows
                if (row_text.startswith('in stock') or row_text.startswith('in-stock')) and len(row_text) < 100:
                    in_stock_section = True
                    continue
                if (row_text.startswith('brokered inventory') or row_text.startswith('brokered')) and len(row_text) < 100:
                    in_stock_section = False
                    continue

                # Skip if not in-stock or Asia/Other
                if not in_stock_section:
                    continue
                if current_region == 'Asia/Other':
                    continue

                cells = await row.query_selector_all('td')
                if len(cells) < 16:
                    continue

                # Get supplier name from column 15
                supplier_cell = cells[15]
                link = await supplier_cell.query_selector('a')
                if not link:
                    continue
                supplier_name = (await link.inner_text()).strip()
                if not supplier_name:
                    continue

                # Skip franchised/authorized distributors (marked with 'ncauth' class)
                auth_icon = await supplier_cell.query_selector('.ncauth')
                if auth_icon:
                    continue

                # Get quantity from column 8
                qty = 0
                try:
                    qty_text = (await cells[8].inner_text()).strip()
                    qty_clean = qty_text.replace(',', '')
                    import re
                    match = re.match(r'^(\d+)', qty_clean)
                    if match:
                        qty = int(match.group(1))
                except Exception:
                    pass

                # Aggregate by supplier
                key = f"{supplier_name}|{current_region}"
                if key not in supplier_data:
                    supplier_data[key] = {'name': supplier_name, 'region': current_region, 'total_qty': 0}
                supplier_data[key]['total_qty'] += qty

            # Convert to list and sort by qty
            all_suppliers = sorted(supplier_data.values(), key=lambda x: x['total_qty'], reverse=True)

            # Split by region
            americas = [s for s in all_suppliers if s['region'] == 'Americas']
            europe = [s for s in all_suppliers if s['region'] == 'Europe']

            # Filter by quantity
            americas_meet_qty = [s for s in americas if s['total_qty'] >= min_qty]
            europe_meet_qty = [s for s in europe if s['total_qty'] >= min_qty]

            # Display results
            print('=' * 50)
            print(f'AMERICAS - Meeting qty ({min_qty:,}+): {len(americas_meet_qty)}')
            print('=' * 50)
            for s in americas_meet_qty:
                print(f"  {s['name']}: {s['total_qty']:,}")
            if not americas_meet_qty:
                print('  (none)')
            print()

            print('=' * 50)
            print(f'EUROPE - Meeting qty ({min_qty:,}+): {len(europe_meet_qty)}')
            print('=' * 50)
            for s in europe_meet_qty:
                print(f"  {s['name']}: {s['total_qty']:,}")
            if not europe_meet_qty:
                print('  (none)')
            print()

            # If no suppliers meet qty, show top available
            if not americas_meet_qty and americas:
                print('=' * 50)
                print(f'AMERICAS - Largest available (none meet {min_qty:,}):')
                print('=' * 50)
                for s in americas[:config.MAX_SUPPLIERS_PER_REGION]:
                    print(f"  {s['name']}: {s['total_qty']:,}")
                print()

            if not europe_meet_qty and europe:
                print('=' * 50)
                print(f'EUROPE - Largest available (none meet {min_qty:,}):')
                print('=' * 50)
                for s in europe[:config.MAX_SUPPLIERS_PER_REGION]:
                    print(f"  {s['name']}: {s['total_qty']:,}")
                print()

            # Summary
            print('=' * 50)
            print('SUMMARY')
            print('=' * 50)
            print(f'Total Americas in-stock suppliers: {len(americas)}')
            print(f'Total Europe in-stock suppliers: {len(europe)}')
            print(f'Americas meeting qty: {len(americas_meet_qty)}')
            print(f'Europe meeting qty: {len(europe_meet_qty)}')

        except Exception as e:
            print(f'Error: {e}')
            import traceback
            traceback.print_exc()
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
