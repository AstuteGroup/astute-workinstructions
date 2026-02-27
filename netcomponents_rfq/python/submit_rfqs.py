#!/usr/bin/env python3
"""
Submit RFQs to qualifying in-stock suppliers

Criteria:
- In-stock inventory only (skip brokered)
- Skip franchised/authorized distributors
- Skip Asia/Other region (separate purchasing group)
- Supplier qty must be >= requested qty (or take largest if none qualify)
- Max 3 suppliers per region
- Europe suppliers: add "Please confirm country of origin" message

Usage:
    python submit_rfqs.py <part_number> <quantity>

Example:
    python submit_rfqs.py "DS3231SN#" 1000
"""

import sys
import asyncio
import time
import re
from datetime import datetime
from playwright.async_api import async_playwright
import config


async def screenshot(page, name):
    """Save a screenshot"""
    filename = config.SCREENSHOTS_DIR / f'rfq_{name}.png'
    await page.screenshot(path=str(filename), full_page=False)
    print(f'    Screenshot: rfq_{name}.png')


async def main():
    if len(sys.argv) < 3:
        print('Usage: python submit_rfqs.py <part_number> <quantity>')
        print('Example: python submit_rfqs.py "DS3231SN#" 1000')
        sys.exit(1)

    part_number = sys.argv[1]
    quantity = int(sys.argv[2])

    print('=' * 40)
    print('NetComponents RFQ Submission')
    print(f'Part: {part_number}')
    print(f'Quantity: {quantity:,}')
    print(f'Max suppliers per region: {config.MAX_SUPPLIERS_PER_REGION}')
    print('=' * 40)
    print()

    start_time = time.time()
    timing = {
        'login': 0,
        'search': 0,
        'suppliers': [],
        'total': 0
    }

    results = []
    omitted_suppliers = []  # Track suppliers filtered out by min order value

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1400, 'height': 1000})
        page = await context.new_page()

        try:
            # 1. Login
            print('1. Logging in...')
            login_start = time.time()
            await page.goto(config.BASE_URL)
            await asyncio.sleep(2)
            await page.click('a:has-text("Login")')
            await asyncio.sleep(2)
            await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT)
            await page.fill('#UserName', config.NETCOMPONENTS_USERNAME)
            await page.fill('#Password', config.NETCOMPONENTS_PASSWORD)
            await page.press('#Password', 'Enter')
            await asyncio.sleep(5)
            timing['login'] = time.time() - login_start
            print(f"   Done ({timing['login']:.1f}s)\n")

            # 2. Search for part
            print(f'2. Searching for {part_number}...')
            search_start = time.time()
            await page.fill('#PartsSearched_0__PartNumber', part_number)
            await page.click('#btnSearch')
            await asyncio.sleep(8)
            timing['search'] = time.time() - search_start
            print(f"   Done ({timing['search']:.1f}s)\n")

            # 3. Parse all suppliers and aggregate by supplier name
            print('3. Finding qualifying suppliers...')
            rows = await page.query_selector_all('table#trv_0 tbody tr')

            supplier_data = {}  # key: "name|region" -> {name, region, total_qty, link}
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

                # Get date code from column 4
                dc_text = ''
                dc_year = None
                dc_ambiguous = False
                try:
                    dc_text = (await cells[4].inner_text()).strip()
                    dc_year, dc_ambiguous = config.parse_date_code(dc_text)
                except Exception:
                    pass

                # Get quantity from column 8
                qty = 0
                try:
                    qty_text = (await cells[8].inner_text()).strip()
                    qty_clean = qty_text.replace(',', '')
                    match = re.match(r'^(\d+)', qty_clean)
                    if match:
                        qty = int(match.group(1))
                except Exception:
                    pass

                # Aggregate by supplier
                key = f"{supplier_name}|{current_region}"
                if key not in supplier_data:
                    supplier_data[key] = {
                        'name': supplier_name,
                        'region': current_region,
                        'total_qty': 0,
                        'link': link,
                        'best_dc_year': None,
                        'best_dc_text': '',
                        'dc_ambiguous': False
                    }
                supplier_data[key]['total_qty'] += qty

                # Keep the best (freshest) date code
                if dc_year is not None:
                    if supplier_data[key]['best_dc_year'] is None or dc_year > supplier_data[key]['best_dc_year']:
                        supplier_data[key]['best_dc_year'] = dc_year
                        supplier_data[key]['best_dc_text'] = dc_text
                        supplier_data[key]['dc_ambiguous'] = dc_ambiguous

                # Keep the link with highest qty
                if qty > 0:
                    supplier_data[key]['link'] = link

            # Determine date code status for each supplier
            for s in supplier_data.values():
                s['dc_status'] = config.get_dc_status(s.get('best_dc_year'), s.get('dc_ambiguous', False))

            # Split by region
            americas = [s for s in supplier_data.values() if s['region'] == 'Americas']
            europe = [s for s in supplier_data.values() if s['region'] == 'Europe']

            # Sort by priority score (fresh DC + qty prioritized, unknown DC given benefit of doubt)
            americas.sort(key=lambda x: config.supplier_priority_score(x, quantity), reverse=True)
            europe.sort(key=lambda x: config.supplier_priority_score(x, quantity), reverse=True)

            # Apply coverage-based filtering to remove tiny-qty suppliers when good coverage exists
            all_suppliers = americas + europe
            filtered_all = config.filter_by_coverage(all_suppliers, quantity)
            filtered_names = {s['name'] for s in filtered_all}

            americas = [s for s in americas if s['name'] in filtered_names]
            europe = [s for s in europe if s['name'] in filtered_names]

            # Use cross-region balancing: if one region is short, give extra slots to the other
            americas_slots, europe_slots = config.calculate_region_slots(len(americas), len(europe))

            selected_americas = americas[:americas_slots]
            selected_europe = europe[:europe_slots]

            # Add +1 extra if unknown DCs present (buffer for uncertainty)
            if config.should_add_extra_supplier(selected_americas) and len(americas) > americas_slots:
                selected_americas = americas[:americas_slots + 1]
            if config.should_add_extra_supplier(selected_europe) and len(europe) > europe_slots:
                selected_europe = europe[:europe_slots + 1]

            print(f'   Americas: {len(selected_americas)} suppliers selected')
            for s in selected_americas:
                dc_info = f", DC:{s['best_dc_text']}" if s.get('best_dc_text') else " (no DC)"
                status = f" [{s['dc_status'].upper()}]" if s.get('dc_status') else ""
                print(f"     - {s['name']} ({s['total_qty']:,}{dc_info}){status}")
            print(f'   Europe: {len(selected_europe)} suppliers selected')
            for s in selected_europe:
                dc_info = f", DC:{s['best_dc_text']}" if s.get('best_dc_text') else " (no DC)"
                status = f" [{s['dc_status'].upper()}]" if s.get('dc_status') else ""
                print(f"     - {s['name']} ({s['total_qty']:,}{dc_info}){status}")
            print()

            all_selected = selected_americas + selected_europe

            if not all_selected:
                print('   No qualifying suppliers found!')
                return

            # 4. Submit RFQs to each supplier
            print(f'4. Submitting RFQs to {len(all_selected)} suppliers...\n')

            for i, supplier in enumerate(all_selected):
                supplier_start = time.time()

                # Adjust quantity if supplier has less than requested
                rfq_qty, qty_adjusted = config.adjust_rfq_quantity(quantity, supplier['total_qty'])
                qty_note = f" (adjusted from {quantity})" if qty_adjusted else ""

                print(f"   [{i + 1}/{len(all_selected)}] {supplier['name']} ({supplier['region']})...")

                try:
                    # Re-do search to get fresh page state
                    await page.goto(config.BASE_URL)
                    await asyncio.sleep(2)
                    await page.fill('#PartsSearched_0__PartNumber', part_number)
                    await page.click('#btnSearch')
                    await asyncio.sleep(6)

                    # Find and click the supplier
                    supplier_link = await page.query_selector(f'a:has-text("{supplier["name"]}")')
                    if not supplier_link:
                        print('    ERROR: Could not find supplier link')
                        results.append({
                            'supplier': supplier['name'],
                            'region': supplier['region'],
                            'status': 'FAILED',
                            'error': 'Supplier not found'
                        })
                        continue

                    await supplier_link.click()
                    await asyncio.sleep(3)  # Wait for supplier detail popup

                    # Extract min order value from supplier detail popup
                    min_order_value = await config.extract_min_order_value(page)
                    supplier['min_order_value'] = min_order_value
                    if min_order_value:
                        print(f'    Min order value: ${min_order_value:.2f}')

                    # TODO: Apply min order value filter when franchise_data is available
                    # This will be integrated when called from batch_rfqs_from_system.py
                    # with franchise screening data

                    # Click E-Mail RFQ link
                    rfq_link = await page.query_selector('a:has-text("E-Mail RFQ")')
                    if not rfq_link:
                        print('    ERROR: E-Mail RFQ option not available')
                        results.append({
                            'supplier': supplier['name'],
                            'region': supplier['region'],
                            'status': 'FAILED',
                            'error': 'No RFQ option'
                        })
                        await page.keyboard.press('Escape')
                        await asyncio.sleep(1)
                        continue

                    await rfq_link.click()
                    await asyncio.sleep(2)

                    # Fill the RFQ form
                    await asyncio.sleep(1)

                    # Check part checkbox
                    part_checkbox = await page.query_selector('#Parts_0__Selected')
                    if part_checkbox:
                        is_checked = await part_checkbox.is_checked()
                        if not is_checked:
                            await part_checkbox.check()
                            print('    Checked part selection')
                    else:
                        print('    WARNING: Part checkbox not found')

                    # Fill quantity
                    qty_input = await page.query_selector('#Parts_0__Quantity')
                    if not qty_input:
                        qty_input = await page.query_selector('input[name="Parts[0].Quantity"]')
                    if not qty_input:
                        qty_input = await page.query_selector('input[type="text"][placeholder*="Qty"]')
                    if not qty_input:
                        inputs = await page.query_selector_all('input[type="text"]')
                        for inp in inputs:
                            name = await inp.get_attribute('name')
                            id_attr = await inp.get_attribute('id')
                            if ((name and 'quantity' in name.lower()) or
                                (id_attr and 'quantity' in id_attr.lower())):
                                qty_input = inp
                                break

                    if qty_input:
                        await qty_input.click()
                        await qty_input.fill(str(rfq_qty))
                        print(f'    Entered quantity: {rfq_qty}{qty_note}')
                    else:
                        print('    WARNING: Quantity input not found')

                    # Add Europe message
                    if supplier['region'] == 'Europe':
                        comments_field = await page.query_selector('#Comments')
                        if not comments_field:
                            comments_field = await page.query_selector('textarea[name="Comments"]')
                        if not comments_field:
                            comments_field = await page.query_selector('textarea')
                        if comments_field:
                            await comments_field.fill('Please confirm country of origin.')
                            print('    Added Europe COO message')

                    await asyncio.sleep(1)
                    await screenshot(page, f'{i + 1}_form_filled')

                    # Find Send RFQ button - it's an INPUT type="button"
                    send_btn = await page.query_selector('input[type="button"].action-btn')
                    if not send_btn:
                        send_btn = await page.query_selector('input[value="Send RFQ"]')
                    if not send_btn:
                        send_btn = await page.query_selector('input.btn-primary[type="button"]')

                    if send_btn:
                        is_disabled = await send_btn.get_attribute('disabled')
                        btn_text = ''
                        try:
                            btn_text = (await send_btn.inner_text()).strip()
                        except Exception:
                            pass
                        print(f'    Found button: "{btn_text}" disabled={is_disabled is not None}')

                        if is_disabled is None:
                            await send_btn.click()
                            await asyncio.sleep(3)
                            await screenshot(page, f'{i + 1}_after_send')
                            supplier_time = time.time() - supplier_start
                            print(f'    SUCCESS: RFQ sent ({supplier_time:.1f}s)')
                            timing['suppliers'].append({
                                'name': supplier['name'],
                                'time': supplier_time,
                                'status': 'SENT'
                            })
                            results.append({
                                'supplier': supplier['name'],
                                'region': supplier['region'],
                                'qty': quantity,
                                'status': 'SENT',
                                'timestamp': datetime.now().isoformat()
                            })
                        else:
                            print('    ERROR: Send button disabled')
                            await screenshot(page, f'{i + 1}_disabled')
                            results.append({
                                'supplier': supplier['name'],
                                'region': supplier['region'],
                                'status': 'FAILED',
                                'error': 'Send button disabled'
                            })
                    else:
                        print('    ERROR: Send RFQ button not found')
                        await screenshot(page, f'{i + 1}_no_button')
                        results.append({
                            'supplier': supplier['name'],
                            'region': supplier['region'],
                            'status': 'FAILED',
                            'error': 'No Send button'
                        })

                    # Close the form/modal
                    await page.keyboard.press('Escape')
                    await asyncio.sleep(1)

                except Exception as e:
                    supplier_time = time.time() - supplier_start
                    print(f'    ERROR: {e} ({supplier_time:.1f}s)')
                    timing['suppliers'].append({
                        'name': supplier['name'],
                        'time': supplier_time,
                        'status': 'FAILED'
                    })
                    results.append({
                        'supplier': supplier['name'],
                        'region': supplier['region'],
                        'status': 'FAILED',
                        'error': str(e)
                    })

            # 5. Summary
            timing['total'] = time.time() - start_time
            avg_per_supplier = (sum(s['time'] for s in timing['suppliers']) / len(timing['suppliers'])
                               if timing['suppliers'] else 0)

            print()
            print('=' * 40)
            print('RFQ SUBMISSION SUMMARY')
            print('=' * 40)
            print(f'Part: {part_number}')
            print(f'Quantity: {quantity:,}')
            sent_count = len([r for r in results if r['status'] == 'SENT'])
            print(f'Total submitted: {sent_count}/{len(results)}')
            print()

            for r in results:
                status = '✓' if r['status'] == 'SENT' else '✗'
                supplier_timing = next((s for s in timing['suppliers'] if s['name'] == r['supplier']), None)
                time_str = f" ({supplier_timing['time']:.1f}s)" if supplier_timing else ''
                error_str = f": {r.get('error', '')}" if r.get('error') else ''
                print(f"{status} {r['supplier']} ({r['region']}) - {r['status']}{time_str}{error_str}")

            print()
            print('=' * 40)
            print('TIMING')
            print('=' * 40)
            print(f"Login:              {timing['login']:.1f}s")
            print(f"Initial search:     {timing['search']:.1f}s")
            print(f"Avg per supplier:   {avg_per_supplier:.1f}s")
            print(f"Total runtime:      {timing['total']:.1f}s ({timing['total'] / 60:.1f} min)")
            if timing['total'] > 0:
                print(f"Suppliers/minute:   {len(timing['suppliers']) / (timing['total'] / 60):.1f}")

        except Exception as e:
            print(f'\nFATAL ERROR: {e}')
            await screenshot(page, 'error')
            import traceback
            traceback.print_exc()
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
