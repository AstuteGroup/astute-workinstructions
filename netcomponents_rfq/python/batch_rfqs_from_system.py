#!/usr/bin/env python3
"""
Batch RFQ submission from system RFQ number

Pulls part numbers and quantities from an RFQ in iDempiere,
then submits NetComponents RFQs to qualifying suppliers.

Usage:
    python batch_rfqs_from_system.py <rfq_number>

Example:
    python batch_rfqs_from_system.py 1008627

Output file: RFQ_<rfq_number>_Results_YYYY-MM-DD_HHMMSS.xlsx
"""

import sys
import subprocess
import asyncio
import time
import re
from datetime import datetime
from pathlib import Path
from playwright.async_api import async_playwright
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
import config


def get_rfq_lines_from_db(rfq_number):
    """Query database for RFQ line items"""
    query = f"""
    SELECT
        l.chuboe_mpn as part_number,
        l.qty as quantity,
        l.chuboe_mfr_text as manufacturer,
        l.line as line_number
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line l ON r.chuboe_rfq_id = l.chuboe_rfq_id
    WHERE r.value = '{rfq_number}'
      AND l.isactive = 'Y'
      AND length(coalesce(l.chuboe_mpn,'')) > 0
      AND coalesce(l.qty, 0) > 0
    ORDER BY l.line;
    """

    result = subprocess.run(
        ['psql', '-t', '-A', '-F', '|', '-c', query],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        print(f"Database error: {result.stderr}")
        return []

    parts = []
    for line in result.stdout.strip().split('\n'):
        if line:
            fields = line.split('|')
            if len(fields) >= 2:
                parts.append({
                    'part_number': fields[0].strip(),
                    'quantity': int(float(fields[1])),
                    'manufacturer': fields[2].strip() if len(fields) > 2 else '',
                    'line_number': int(fields[3]) if len(fields) > 3 and fields[3] else 0
                })

    return parts


def create_output_excel(results, rfq_number, output_path):
    """Create output Excel file with RFQ results"""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f'RFQ {rfq_number} Results'

    headers = ['RFQ Line', 'Part Number', 'Qty Requested', 'Supplier', 'Region',
               'Supplier Qty', 'Status', 'Timestamp', 'Error']

    header_font = Font(bold=True, color='FFFFFF')
    header_fill = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')
    thin_border = Border(
        left=Side(style='thin'),
        right=Side(style='thin'),
        top=Side(style='thin'),
        bottom=Side(style='thin')
    )

    for col, header in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal='center')
        cell.border = thin_border

    success_fill = PatternFill(start_color='C6EFCE', end_color='C6EFCE', fill_type='solid')
    fail_fill = PatternFill(start_color='FFC7CE', end_color='FFC7CE', fill_type='solid')

    row_num = 2
    for r in results:
        ws.cell(row=row_num, column=1, value=r.get('line_number', ''))
        ws.cell(row=row_num, column=2, value=r.get('part_number', ''))
        ws.cell(row=row_num, column=3, value=r.get('qty_requested', ''))
        ws.cell(row=row_num, column=4, value=r.get('supplier', ''))
        ws.cell(row=row_num, column=5, value=r.get('region', ''))
        ws.cell(row=row_num, column=6, value=r.get('supplier_qty', ''))
        ws.cell(row=row_num, column=7, value=r.get('status', ''))
        ws.cell(row=row_num, column=8, value=r.get('timestamp', ''))
        ws.cell(row=row_num, column=9, value=r.get('error', ''))

        status_cell = ws.cell(row=row_num, column=7)
        if r.get('status') == 'SENT':
            status_cell.fill = success_fill
        elif r.get('status') == 'FAILED':
            status_cell.fill = fail_fill

        for col in range(1, 10):
            ws.cell(row=row_num, column=col).border = thin_border

        row_num += 1

    for col in range(1, 10):
        max_length = max(len(str(cell.value or '')) for cell in ws[get_column_letter(col)])
        ws.column_dimensions[get_column_letter(col)].width = min(max_length + 2, 40)

    wb.save(output_path)
    wb.close()


async def process_part(page, part_number, quantity, line_number, timing_data):
    """Process a single part number and return results"""
    results = []

    print(f'\n  Searching for {part_number}...')
    search_start = time.time()
    await page.fill('#PartsSearched_0__PartNumber', part_number)
    await page.click('#btnSearch')
    await asyncio.sleep(8)
    print(f'    Search complete ({time.time() - search_start:.1f}s)')

    rows = await page.query_selector_all('table#trv_0 tbody tr')

    supplier_data = {}
    in_stock_section = False
    current_region = 'Unknown'

    for row in rows:
        row_text = (await row.inner_text() or '').lower()

        if 'americas' in row_text and 'inventory' not in row_text and len(row_text) < 50:
            current_region = 'Americas'
            continue
        if 'europe' in row_text and 'inventory' not in row_text and len(row_text) < 50:
            current_region = 'Europe'
            continue
        if ('asia' in row_text or 'other' in row_text) and 'inventory' not in row_text and len(row_text) < 50:
            current_region = 'Asia/Other'
            continue

        if (row_text.startswith('in stock') or row_text.startswith('in-stock')) and len(row_text) < 100:
            in_stock_section = True
            continue
        if (row_text.startswith('brokered inventory') or row_text.startswith('brokered')) and len(row_text) < 100:
            in_stock_section = False
            continue

        if not in_stock_section or current_region == 'Asia/Other':
            continue

        cells = await row.query_selector_all('td')
        if len(cells) < 16:
            continue

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

        qty = 0
        try:
            qty_text = (await cells[8].inner_text()).strip()
            match = re.match(r'^(\d+)', qty_text.replace(',', ''))
            if match:
                qty = int(match.group(1))
        except Exception:
            pass

        key = f"{supplier_name}|{current_region}"
        if key not in supplier_data:
            supplier_data[key] = {
                'name': supplier_name,
                'region': current_region,
                'total_qty': 0,
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

    # Determine date code status for each supplier
    for s in supplier_data.values():
        s['dc_status'] = config.get_dc_status(s.get('best_dc_year'), s.get('dc_ambiguous', False))

    # Split by region and sort by priority score
    americas = [s for s in supplier_data.values() if s['region'] == 'Americas']
    europe = [s for s in supplier_data.values() if s['region'] == 'Europe']

    americas.sort(key=lambda x: config.supplier_priority_score(x, quantity), reverse=True)
    europe.sort(key=lambda x: config.supplier_priority_score(x, quantity), reverse=True)

    # Select suppliers (add +1 if unknown DCs present)
    americas_count = config.MAX_SUPPLIERS_PER_REGION
    europe_count = config.MAX_SUPPLIERS_PER_REGION

    selected_americas = americas[:americas_count]
    selected_europe = europe[:europe_count]

    if config.should_add_extra_supplier(selected_americas) and len(americas) > americas_count:
        selected_americas = americas[:americas_count + 1]
    if config.should_add_extra_supplier(selected_europe) and len(europe) > europe_count:
        selected_europe = europe[:europe_count + 1]

    all_selected = selected_americas + selected_europe

    if not all_selected:
        print(f'    No qualifying suppliers found')
        results.append({
            'line_number': line_number,
            'part_number': part_number,
            'qty_requested': quantity,
            'supplier': '',
            'region': '',
            'supplier_qty': '',
            'status': 'NO_SUPPLIERS',
            'timestamp': datetime.now().isoformat(),
            'error': 'No qualifying suppliers found'
        })
        return results

    print(f'    Found {len(all_selected)} suppliers')

    for supplier in all_selected:
        supplier_start = time.time()
        print(f'    Submitting to {supplier["name"]}...')

        try:
            await page.goto(config.BASE_URL)
            await asyncio.sleep(2)
            await page.fill('#PartsSearched_0__PartNumber', part_number)
            await page.click('#btnSearch')
            await asyncio.sleep(6)

            supplier_link = await page.query_selector(f'a:has-text("{supplier["name"]}")')
            if not supplier_link:
                results.append({
                    'line_number': line_number,
                    'part_number': part_number,
                    'qty_requested': quantity,
                    'supplier': supplier['name'],
                    'region': supplier['region'],
                    'supplier_qty': supplier['total_qty'],
                    'status': 'FAILED',
                    'timestamp': datetime.now().isoformat(),
                    'error': 'Supplier not found on re-search'
                })
                continue

            await supplier_link.click()
            await asyncio.sleep(2)

            rfq_link = await page.query_selector('a:has-text("E-Mail RFQ")')
            if not rfq_link:
                results.append({
                    'line_number': line_number,
                    'part_number': part_number,
                    'qty_requested': quantity,
                    'supplier': supplier['name'],
                    'region': supplier['region'],
                    'supplier_qty': supplier['total_qty'],
                    'status': 'FAILED',
                    'timestamp': datetime.now().isoformat(),
                    'error': 'No RFQ option'
                })
                await page.keyboard.press('Escape')
                await asyncio.sleep(1)
                continue

            await rfq_link.click()
            await asyncio.sleep(2)

            part_checkbox = await page.query_selector('#Parts_0__Selected')
            if part_checkbox:
                if not await part_checkbox.is_checked():
                    await part_checkbox.check()

            qty_input = await page.query_selector('#Parts_0__Quantity')
            if qty_input:
                await qty_input.click()
                await qty_input.fill(str(quantity))

            if supplier['region'] == 'Europe':
                comments_field = await page.query_selector('#Comments')
                if comments_field:
                    await comments_field.fill('Please confirm country of origin.')

            await asyncio.sleep(1)

            send_btn = await page.query_selector('input[type="button"].action-btn')
            if not send_btn:
                send_btn = await page.query_selector('input[value="Send RFQ"]')

            if send_btn and await send_btn.get_attribute('disabled') is None:
                await send_btn.click()
                await asyncio.sleep(3)

                supplier_time = time.time() - supplier_start
                timing_data['suppliers'].append({'name': supplier['name'], 'time': supplier_time})

                print(f'      SENT ({supplier_time:.1f}s)')
                results.append({
                    'line_number': line_number,
                    'part_number': part_number,
                    'qty_requested': quantity,
                    'supplier': supplier['name'],
                    'region': supplier['region'],
                    'supplier_qty': supplier['total_qty'],
                    'status': 'SENT',
                    'timestamp': datetime.now().isoformat(),
                    'error': ''
                })
            else:
                results.append({
                    'line_number': line_number,
                    'part_number': part_number,
                    'qty_requested': quantity,
                    'supplier': supplier['name'],
                    'region': supplier['region'],
                    'supplier_qty': supplier['total_qty'],
                    'status': 'FAILED',
                    'timestamp': datetime.now().isoformat(),
                    'error': 'Send button not found or disabled'
                })

            await page.keyboard.press('Escape')
            await asyncio.sleep(1)

        except Exception as e:
            results.append({
                'line_number': line_number,
                'part_number': part_number,
                'qty_requested': quantity,
                'supplier': supplier['name'],
                'region': supplier['region'],
                'supplier_qty': supplier['total_qty'],
                'status': 'FAILED',
                'timestamp': datetime.now().isoformat(),
                'error': str(e)
            })

    return results


async def main():
    if len(sys.argv) < 2:
        print('Usage: python batch_rfqs_from_system.py <rfq_number>')
        print('Example: python batch_rfqs_from_system.py 1008627')
        sys.exit(1)

    rfq_number = sys.argv[1]

    print(f'Fetching RFQ {rfq_number} from database...')
    parts = get_rfq_lines_from_db(rfq_number)

    if not parts:
        print(f'No line items found for RFQ {rfq_number}')
        sys.exit(1)

    print(f'Found {len(parts)} line items:\n')
    for p in parts:
        print(f"  Line {p['line_number']}: {p['part_number']} x {p['quantity']:,}")

    timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    output_file = Path(f'RFQ_{rfq_number}_Results_{timestamp}.xlsx')

    print('\n' + '=' * 50)
    print(f'NetComponents Batch RFQ Submission')
    print(f'RFQ: {rfq_number}')
    print(f'Parts to process: {len(parts)}')
    print(f'Output file: {output_file}')
    print('=' * 50)

    all_results = []
    timing_data = {'suppliers': []}
    start_time = time.time()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1400, 'height': 1000})
        page = await context.new_page()

        try:
            print('\nLogging in...')
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
            print(f'  Done ({time.time() - login_start:.1f}s)')

            for i, part in enumerate(parts):
                print(f"\n[{i + 1}/{len(parts)}] Line {part['line_number']}: {part['part_number']} x {part['quantity']:,}")
                results = await process_part(
                    page,
                    part['part_number'],
                    part['quantity'],
                    part['line_number'],
                    timing_data
                )
                all_results.extend(results)

        except Exception as e:
            print(f'\nFATAL ERROR: {e}')
            import traceback
            traceback.print_exc()
        finally:
            await browser.close()

    print(f'\n\nWriting results to {output_file}...')
    create_output_excel(all_results, rfq_number, output_file)

    total_time = time.time() - start_time
    sent_count = len([r for r in all_results if r['status'] == 'SENT'])

    print('\n' + '=' * 50)
    print('BATCH SUMMARY')
    print('=' * 50)
    print(f'RFQ: {rfq_number}')
    print(f'Parts processed: {len(parts)}')
    print(f'RFQs sent: {sent_count}')
    print(f'RFQs failed: {len(all_results) - sent_count}')
    print(f'Total runtime: {total_time:.1f}s ({total_time / 60:.1f} min)')
    if timing_data['suppliers']:
        avg_time = sum(s['time'] for s in timing_data['suppliers']) / len(timing_data['suppliers'])
        print(f'Avg per supplier: {avg_time:.1f}s')
    print(f'\nResults saved to: {output_file}')


if __name__ == '__main__':
    asyncio.run(main())
