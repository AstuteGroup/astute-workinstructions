#!/usr/bin/env python3
"""
Currency Conversion Poller

Polls bizops@orangetsunami.com for Exchange Rate Matrix emails,
processes the attachment, and replies with the generated CSV.

Usage:
    python currency-poller.py                 # Poll once
    python currency-poller.py --dry-run       # Parse but don't process
    python currency-poller.py --watch         # Poll continuously

Subject patterns matched:
    - "Exchange Rate Matrix" or "Currency Rate Matrix"
    - Month extracted from subject (e.g., "August 2026" → 2026-08-04 to 2026-09-03)
"""

import argparse
import imaplib
import email
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from calendar import monthrange
from email.header import decode_header
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path
import smtplib

# State file for tracking processed emails
STATE_FILE = Path.home() / '.currency-poller-processed.json'

# Load environment variables
def load_env():
    env_path = Path.home() / 'workspace' / '.env'
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ.setdefault(key.strip(), value.strip().strip('"\''))

load_env()

# Email configuration
SMTP_HOST = os.environ.get('SMTP_HOST', 'smtp.mail.us-east-1.awsapps.com')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '465'))
SMTP_PASS = os.environ.get('WORKMAIL_PASS') or os.environ.get('SMTP_PASS')
IMAP_HOST = os.environ.get('IMAP_HOST', 'imap.mail.us-east-1.awsapps.com')
IMAP_PORT = int(os.environ.get('IMAP_PORT', '993'))

INBOX_EMAIL = 'bizops@orangetsunami.com'

# Subject patterns
CURRENCY_PATTERNS = [
    r'exchange\s*rate\s*matrix',
    r'currency\s*rate\s*matrix',
    r'currency\s*conversion',
]
CURRENCY_RE = re.compile('|'.join(CURRENCY_PATTERNS), re.IGNORECASE)

# Month parsing
MONTH_NAMES = {
    'january': 1, 'jan': 1,
    'february': 2, 'feb': 2,
    'march': 3, 'mar': 3,
    'april': 4, 'apr': 4,
    'may': 5,
    'june': 6, 'jun': 6,
    'july': 7, 'jul': 7,
    'august': 8, 'aug': 8,
    'september': 9, 'sep': 9, 'sept': 9,
    'october': 10, 'oct': 10,
    'november': 11, 'nov': 11,
    'december': 12, 'dec': 12,
}

# Currency processor path
SCRIPT_DIR = Path(__file__).parent
CURRENCY_PROCESSOR = SCRIPT_DIR / 'currency-processor.js'


def load_processed_state() -> set:
    """Load set of processed message IDs."""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                data = json.load(f)
                return set(data.get('processed_ids', []))
        except (json.JSONDecodeError, IOError):
            return set()
    return set()


def save_processed_state(processed_ids: set):
    """Save processed message IDs."""
    # Keep only last 200 to prevent unbounded growth
    ids_list = list(processed_ids)[-200:]
    with open(STATE_FILE, 'w') as f:
        json.dump({'processed_ids': ids_list}, f, indent=2)


def mark_processed(message_id: str):
    """Mark a message as processed."""
    processed = load_processed_state()
    processed.add(message_id)
    save_processed_state(processed)


def is_processed(message_id: str) -> bool:
    """Check if message was already processed."""
    return message_id in load_processed_state()


def get_imap_client():
    """Create IMAP client for bizops@."""
    client = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    client.login(INBOX_EMAIL, SMTP_PASS)
    return client


def parse_month_year(subject: str) -> tuple:
    """
    Extract month and year from subject.
    Returns (month, year) or (None, None) if not found.

    Examples:
        "Exchange Rate Matrix -01 August 2026" → (8, 2026)
        "Currency Rate Matrix - July 2026" → (7, 2026)
        "Exchange Rate Matrix -1 May 2026" → (5, 2026)
    """
    # Pattern: optional day + month name + year
    pattern = r'(?:-?\s*\d{1,2}\s*)?(' + '|'.join(MONTH_NAMES.keys()) + r')\s+(\d{4})'
    match = re.search(pattern, subject, re.IGNORECASE)

    if match:
        month_name = match.group(1).lower()
        year = int(match.group(2))
        month = MONTH_NAMES.get(month_name)
        return (month, year)

    return (None, None)


def calculate_date_range(month: int, year: int) -> tuple:
    """
    Calculate validity date range for a given month.
    Convention: 4th of month to 3rd of next month.

    Returns (start_date, end_date) as YYYY-MM-DD strings.
    """
    start_date = f"{year:04d}-{month:02d}-04"

    # Calculate end date (3rd of next month)
    if month == 12:
        end_year = year + 1
        end_month = 1
    else:
        end_year = year
        end_month = month + 1

    end_date = f"{end_year:04d}-{end_month:02d}-03"

    return (start_date, end_date)


def extract_email_address(from_field: str) -> str:
    """Extract email address from 'Name <email>' format."""
    match = re.search(r'<([^>]+)>', from_field)
    return match.group(1) if match else from_field


def fetch_currency_emails(folder: str = 'INBOX'):
    """Fetch emails matching currency rate patterns."""
    client = get_imap_client()

    try:
        client.select(folder)

        # Search for potential currency emails
        # We'll filter more precisely after fetching
        status, messages = client.search(None, '(OR (SUBJECT "Exchange Rate") (SUBJECT "Currency"))')

        if status != 'OK':
            print(f"Search failed: {status}", file=sys.stderr)
            return []

        email_ids = messages[0].split()
        results = []

        for eid in email_ids[-20:]:  # Check last 20
            status, msg_data = client.fetch(eid, '(RFC822)')
            if status != 'OK':
                continue

            raw_email = msg_data[0][1]
            msg = email.message_from_bytes(raw_email)

            # Decode subject
            subject = msg['Subject'] or ''
            if subject.startswith('=?'):
                decoded = decode_header(subject)
                subject = ''.join(
                    part.decode(enc or 'utf-8') if isinstance(part, bytes) else part
                    for part, enc in decoded
                )

            # Skip replies
            if subject.lower().startswith('re:'):
                continue

            # Must match our currency pattern
            if not CURRENCY_RE.search(subject):
                continue

            message_id = msg['Message-ID'] or f"no-id-{eid}"
            from_addr = msg['From'] or ''

            # Extract attachments
            attachments = []
            if msg.is_multipart():
                for part in msg.walk():
                    filename = part.get_filename()
                    if filename:
                        # Decode filename if needed
                        if filename.startswith('=?'):
                            decoded = decode_header(filename)
                            filename = ''.join(
                                p.decode(enc or 'utf-8') if isinstance(p, bytes) else p
                                for p, enc in decoded
                            )

                        # Check if it's an Excel file
                        if filename.lower().endswith(('.xlsx', '.xls')):
                            payload = part.get_payload(decode=True)
                            attachments.append({
                                'filename': filename,
                                'data': payload,
                            })

            results.append({
                'id': eid.decode() if isinstance(eid, bytes) else eid,
                'message_id': message_id,
                'subject': subject,
                'from': from_addr,
                'date': msg['Date'],
                'attachments': attachments,
            })

        return results

    finally:
        client.logout()


def move_to_processed(email_id: str, folder: str = 'INBOX'):
    """Move email to Processed folder."""
    client = get_imap_client()

    try:
        client.select(folder)
        # Create folder if needed (ignore error if exists)
        try:
            client.create('Processed')
        except:
            pass
        client.copy(email_id, 'Processed')
        client.store(email_id, '+FLAGS', '\\Deleted')
        client.expunge()
        return True
    except Exception as e:
        print(f"Failed to move email: {e}", file=sys.stderr)
        return False
    finally:
        client.logout()


def run_currency_processor(xlsx_path: str, start_date: str, end_date: str, output_path: str) -> dict:
    """Run the currency processor Node.js script."""
    cmd = [
        'node',
        str(CURRENCY_PROCESSOR),
        xlsx_path,
        '--start-date', start_date,
        '--end-date', end_date,
        '--output', output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

    if result.returncode != 0:
        return {
            'success': False,
            'error': result.stderr or result.stdout or f'Exit code {result.returncode}',
        }

    return {
        'success': True,
        'output': result.stdout,
    }


def send_reply_with_attachment(to: str, subject: str, body: str, attachment_path: str, attachment_name: str):
    """Send reply email with CSV attachment."""
    if not SMTP_PASS:
        print("Warning: No SMTP password, skipping email", file=sys.stderr)
        return False

    msg = MIMEMultipart()
    msg['Subject'] = f"RE: {subject}"
    msg['From'] = f'"Currency Conversion" <{INBOX_EMAIL}>'
    msg['To'] = to

    # Body
    msg.attach(MIMEText(body, 'plain'))

    # Attachment
    with open(attachment_path, 'rb') as f:
        part = MIMEBase('application', 'octet-stream')
        part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header('Content-Disposition', f'attachment; filename="{attachment_name}"')
        msg.attach(part)

    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(INBOX_EMAIL, SMTP_PASS)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"Failed to send email: {e}", file=sys.stderr)
        return False


def send_error_reply(to: str, subject: str, error_msg: str):
    """Send error notification reply."""
    if not SMTP_PASS:
        return False

    body = f"""Unable to process the Exchange Rate Matrix file.

Error: {error_msg}

Please check the file format and try again, or contact support.
"""

    msg = MIMEText(body)
    msg['Subject'] = f"RE: {subject} - Processing Error"
    msg['From'] = f'"Currency Conversion" <{INBOX_EMAIL}>'
    msg['To'] = to

    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(INBOX_EMAIL, SMTP_PASS)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"Failed to send error email: {e}", file=sys.stderr)
        return False


def process_currency_emails(dry_run: bool = False):
    """Main processing loop."""
    print(f"Fetching currency emails from {INBOX_EMAIL}...", file=sys.stderr)

    results = {
        'found': 0,
        'processed': 0,
        'errors': 0,
    }

    try:
        emails = fetch_currency_emails()
    except Exception as e:
        print(f"Error fetching emails: {e}", file=sys.stderr)
        return results

    if not emails:
        print("No currency conversion emails found", file=sys.stderr)
        return results

    print(f"Found {len(emails)} currency email(s)", file=sys.stderr)
    results['found'] = len(emails)

    for email_data in emails:
        message_id = email_data['message_id']

        # Skip already processed
        if is_processed(message_id):
            print(f"  Already processed: {email_data['subject'][:50]}...", file=sys.stderr)
            continue

        print(f"\nProcessing: {email_data['subject']}", file=sys.stderr)
        print(f"  From: {email_data['from']}", file=sys.stderr)

        sender = extract_email_address(email_data['from'])

        # Check for Excel attachment
        if not email_data['attachments']:
            print(f"  No Excel attachment found", file=sys.stderr)
            if not dry_run:
                send_error_reply(sender, email_data['subject'], "No Excel file attachment found")
                mark_processed(message_id)
            results['errors'] += 1
            continue

        attachment = email_data['attachments'][0]  # Use first Excel file
        print(f"  Attachment: {attachment['filename']}", file=sys.stderr)

        # Parse month/year from subject
        month, year = parse_month_year(email_data['subject'])
        if not month or not year:
            print(f"  Could not parse month/year from subject", file=sys.stderr)
            if not dry_run:
                send_error_reply(sender, email_data['subject'],
                    "Could not determine month/year from subject. Please include month and year (e.g., 'August 2026')")
                mark_processed(message_id)
            results['errors'] += 1
            continue

        start_date, end_date = calculate_date_range(month, year)
        print(f"  Date range: {start_date} to {end_date}", file=sys.stderr)

        if dry_run:
            print(f"  [DRY RUN] Would process and reply with CSV", file=sys.stderr)
            results['processed'] += 1
            continue

        # Save attachment to temp file
        with tempfile.NamedTemporaryFile(suffix='.xlsx', delete=False) as f:
            f.write(attachment['data'])
            xlsx_path = f.name

        # Create output path
        start_fmt = f"{month}_{4}_{str(year)[-2:]}"
        next_month = month + 1 if month < 12 else 1
        next_year = year if month < 12 else year + 1
        end_fmt = f"{next_month}_{3}_{str(next_year)[-2:]}"
        output_filename = f"Currency Conversion Upload - {start_fmt} - {end_fmt}.csv"
        output_path = tempfile.mktemp(suffix='.csv')

        try:
            # Run processor
            print(f"  Running currency processor...", file=sys.stderr)
            proc_result = run_currency_processor(xlsx_path, start_date, end_date, output_path)

            if not proc_result['success']:
                print(f"  Processor error: {proc_result['error']}", file=sys.stderr)
                send_error_reply(sender, email_data['subject'], proc_result['error'])
                results['errors'] += 1
                continue

            # Send reply with attachment
            body = f"""Currency conversion rates processed successfully.

Date Range: {start_date} to {end_date}
Source: {attachment['filename']}

The attached CSV file is ready for iDempiere import.

---
Processed automatically by Currency Conversion Workflow
"""

            print(f"  Sending reply to {sender}...", file=sys.stderr)
            if send_reply_with_attachment(sender, email_data['subject'], body, output_path, output_filename):
                print(f"  Reply sent successfully", file=sys.stderr)
                mark_processed(message_id)
                move_to_processed(email_data['id'])
                results['processed'] += 1
            else:
                print(f"  Failed to send reply", file=sys.stderr)
                results['errors'] += 1

        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)
            send_error_reply(sender, email_data['subject'], str(e))
            results['errors'] += 1

        finally:
            # Cleanup temp files
            try:
                os.unlink(xlsx_path)
            except:
                pass
            try:
                os.unlink(output_path)
            except:
                pass

    return results


def main():
    parser = argparse.ArgumentParser(description='Poll for Exchange Rate Matrix emails and process them')
    parser.add_argument('--dry-run', action='store_true',
                        help='Parse emails but do not process')
    parser.add_argument('--watch', '-w', action='store_true',
                        help='Poll continuously (every 5 min)')
    parser.add_argument('--interval', '-i', type=int, default=300,
                        help='Poll interval in seconds (default: 300)')
    parser.add_argument('--clear', action='store_true',
                        help='Clear processed message IDs and exit')

    args = parser.parse_args()

    if args.clear:
        save_processed_state(set())
        print("Cleared processed message IDs")
        return

    if not SMTP_PASS:
        print("Warning: No SMTP/IMAP password configured", file=sys.stderr)

    if args.watch:
        print(f"Watching {INBOX_EMAIL} for currency emails (interval: {args.interval}s)", file=sys.stderr)
        print("Press Ctrl+C to stop", file=sys.stderr)

        while True:
            try:
                results = process_currency_emails(args.dry_run)
                ts = datetime.now().strftime('%H:%M:%S')
                print(f"\n[{ts}] Found: {results['found']}, Processed: {results['processed']}, Errors: {results['errors']}", file=sys.stderr)
                time.sleep(args.interval)
            except KeyboardInterrupt:
                print("\nStopped", file=sys.stderr)
                break
            except Exception as e:
                print(f"Error: {e}", file=sys.stderr)
                time.sleep(args.interval)
    else:
        results = process_currency_emails(args.dry_run)
        print(f"\nResults: {json.dumps(results)}")


if __name__ == '__main__':
    main()
