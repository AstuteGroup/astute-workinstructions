#!/usr/bin/env python3
"""
Currency Conversion Poller

Polls bizops@orangetsunami.com for Exchange Rate Matrix emails,
processes the attachment, and replies with the generated CSV.

Two-step workflow:
  1. New email with xlsx → Process → Reply with CSV for review
  2. User replies "add" → Push rates to OT C_Conversion_Rate table

Usage:
    python currency-poller.py                 # Poll once (new emails + replies)
    python currency-poller.py --dry-run       # Parse but don't process
    python currency-poller.py --watch         # Poll continuously
    python currency-poller.py --pending       # Show pending rate batches

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

# Pending rates file (rates awaiting "add" approval)
PENDING_FILE = Path.home() / '.currency-pending-rates.json'

# Currency rate writer path
SCRIPT_DIR = Path(__file__).parent
CURRENCY_WRITER = SCRIPT_DIR.parent / 'shared' / 'currency-rate-writer.js'

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


# ─── PENDING RATES STATE ──────────────────────────────────────────────────────

def load_pending_rates() -> dict:
    """Load pending rate batches awaiting approval."""
    if PENDING_FILE.exists():
        try:
            with open(PENDING_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}


def save_pending_rates(pending: dict):
    """Save pending rate batches."""
    with open(PENDING_FILE, 'w') as f:
        json.dump(pending, f, indent=2)


def add_pending_batch(batch_id: str, rates: list, start_date: str, end_date: str, sender: str):
    """Add a batch of rates awaiting approval."""
    pending = load_pending_rates()
    pending[batch_id] = {
        'rates': rates,
        'startDate': start_date,
        'endDate': end_date,
        'sender': sender,
        'created': datetime.now().isoformat(),
    }
    save_pending_rates(pending)


def get_pending_batch(batch_id: str) -> dict:
    """Get a pending batch by ID."""
    pending = load_pending_rates()
    return pending.get(batch_id)


def remove_pending_batch(batch_id: str):
    """Remove a pending batch after processing."""
    pending = load_pending_rates()
    pending.pop(batch_id, None)
    save_pending_rates(pending)


def parse_csv_for_rates(csv_path: str) -> list:
    """Parse the generated CSV to extract rates for OT upload."""
    rates = []
    with open(csv_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('AD_Org_ID'):
                continue  # Skip header
            parts = line.split(',')
            if len(parts) >= 4:
                rates.append({
                    'from': parts[1],
                    'to': parts[2],
                    'rate': float(parts[3]),
                })
    return rates


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


def send_confirmation_reply(to: str, subject: str, result: dict):
    """Send confirmation after pushing rates to OT."""
    if not SMTP_PASS:
        return False

    body = f"""Currency rates have been pushed to Orange Tsunami.

Date Range: {result.get('validFrom')} to {result.get('validTo')}
Records Created: {result.get('created', 0)}
Records Skipped: {result.get('skipped', 0)} (already exist)

The rates are now active in the system.
"""

    if result.get('errors'):
        body += f"\nErrors ({len(result['errors'])}):\n"
        for err in result['errors'][:5]:  # Show first 5 errors
            body += f"  - {err['from']}→{err['to']}: {err['error']}\n"

    msg = MIMEText(body)
    msg['Subject'] = f"RE: {subject} - Rates Loaded to OT"
    msg['From'] = f'"Currency Conversion" <{INBOX_EMAIL}>'
    msg['To'] = to

    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(INBOX_EMAIL, SMTP_PASS)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"Failed to send confirmation email: {e}", file=sys.stderr)
        return False


# ─── REPLY HANDLING ───────────────────────────────────────────────────────────

ADD_PATTERNS = [
    r'\badd\b',
    r'\bapprove\b',
    r'\bconfirm\b',
    r'\bload\b',
    r'\bpush\b',
    r'\byes\b',
]
ADD_RE = re.compile('|'.join(ADD_PATTERNS), re.IGNORECASE)


def fetch_currency_replies(folder: str = 'INBOX'):
    """Fetch reply emails to currency rate emails."""
    client = get_imap_client()

    try:
        client.select(folder)

        # Search for replies to currency emails
        status, messages = client.search(None, '(OR (SUBJECT "RE: Currency") (SUBJECT "RE: Exchange Rate"))')

        if status != 'OK':
            return []

        email_ids = messages[0].split()
        results = []

        for eid in email_ids[-20:]:
            status, msg_data = client.fetch(eid, '(RFC822)')
            if status != 'OK':
                continue

            raw_email = msg_data[0][1]
            msg = email.message_from_bytes(raw_email)

            subject = msg['Subject'] or ''
            if subject.startswith('=?'):
                decoded = decode_header(subject)
                subject = ''.join(
                    part.decode(enc or 'utf-8') if isinstance(part, bytes) else part
                    for part, enc in decoded
                )

            # Must be a reply
            if not subject.lower().startswith('re:'):
                continue

            # Must match currency pattern in original subject
            if not CURRENCY_RE.search(subject):
                continue

            message_id = msg['Message-ID'] or f"no-id-{eid}"
            from_addr = msg['From'] or ''

            # Get body
            body = ''
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == 'text/plain':
                        payload = part.get_payload(decode=True)
                        if payload:
                            body = payload.decode('utf-8', errors='ignore')
                            break
            else:
                payload = msg.get_payload(decode=True)
                if payload:
                    body = payload.decode('utf-8', errors='ignore')

            results.append({
                'id': eid.decode() if isinstance(eid, bytes) else eid,
                'message_id': message_id,
                'subject': subject,
                'from': from_addr,
                'body': body,
            })

        return results

    finally:
        client.logout()


def get_reply_text(body: str) -> str:
    """Extract just the new reply content (before quoted text)."""
    lines = body.split('\n')
    reply_lines = []

    for line in lines:
        if line.strip().startswith('>'):
            break
        if re.match(r'^On .+ wrote:', line):
            break
        if line.strip().startswith('From:') and '@' in line:
            break
        if '-----Original Message-----' in line:
            break
        reply_lines.append(line)

    return '\n'.join(reply_lines).strip()


def extract_batch_id_from_subject(subject: str) -> str:
    """Extract batch ID from subject like 'RE: Currency Rate Matrix - August 2026'."""
    # Extract month and year to form batch ID
    month, year = parse_month_year(subject)
    if month and year:
        return f"{year}-{month:02d}"
    return None


def call_currency_writer(rates: list, start_date: str, end_date: str, dry_run: bool = False) -> dict:
    """Call the currency rate writer via writeback proxy (sudo to analytics_user)."""
    payload = {
        'opts': {
            'rates': rates,
            'validFrom': start_date,
            'validTo': end_date,
            'dryRun': dry_run,
        }
    }

    # Use the writeback proxy CLI (runs as analytics_user via sudo)
    try:
        result = subprocess.run(
            ['sudo', '-n', '-u', 'analytics_user', '/opt/writeback/cli', 'currency-rates'],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=120
        )

        if result.returncode != 0:
            error_out = result.stderr.strip() or result.stdout.strip()
            # Check for subcommand not found
            if 'Unknown subcommand' in error_out:
                return {
                    'success': False,
                    'error': 'currency-rates subcommand not yet added to /opt/writeback/cli. Please add it.',
                }
            try:
                err = json.loads(error_out)
                return {'success': False, 'error': err.get('error', error_out)}
            except:
                return {'success': False, 'error': error_out}

        response = json.loads(result.stdout)
        return response.get('result', response)

    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'Timeout after 120s'}
    except json.JSONDecodeError as e:
        return {'success': False, 'error': f'Invalid JSON response: {e}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def process_add_replies(dry_run: bool = False):
    """Process reply emails with 'add' command."""
    print(f"Fetching currency reply emails...", file=sys.stderr)

    results = {
        'found': 0,
        'processed': 0,
        'errors': 0,
    }

    try:
        replies = fetch_currency_replies()
    except Exception as e:
        print(f"Error fetching replies: {e}", file=sys.stderr)
        return results

    if not replies:
        print("No currency reply emails found", file=sys.stderr)
        return results

    print(f"Found {len(replies)} reply email(s)", file=sys.stderr)
    results['found'] = len(replies)

    for reply in replies:
        message_id = reply['message_id']

        # Skip already processed
        if is_processed(message_id):
            continue

        print(f"\nChecking reply: {reply['subject'][:60]}...", file=sys.stderr)

        # Extract reply text and check for add command
        reply_text = get_reply_text(reply['body'])
        if not ADD_RE.search(reply_text):
            print(f"  No 'add' command found, skipping", file=sys.stderr)
            continue

        print(f"  'add' command detected", file=sys.stderr)

        # Extract batch ID from subject
        batch_id = extract_batch_id_from_subject(reply['subject'])
        if not batch_id:
            print(f"  Could not determine batch ID from subject", file=sys.stderr)
            continue

        # Look up pending batch
        batch = get_pending_batch(batch_id)
        if not batch:
            print(f"  No pending batch found for {batch_id}", file=sys.stderr)
            # Mark as processed to avoid re-checking
            mark_processed(message_id)
            continue

        print(f"  Found pending batch: {batch_id}", file=sys.stderr)
        print(f"  Rates: {len(batch['rates'])}, Date range: {batch['startDate']} to {batch['endDate']}", file=sys.stderr)

        sender = extract_email_address(reply['from'])

        if dry_run:
            print(f"  [DRY RUN] Would push {len(batch['rates'])} rates to OT", file=sys.stderr)
            results['processed'] += 1
            continue

        # Call the writer
        print(f"  Pushing rates to OT...", file=sys.stderr)
        write_result = call_currency_writer(
            batch['rates'],
            batch['startDate'],
            batch['endDate'],
        )

        if write_result.get('success'):
            print(f"  Success: {write_result.get('created', 0)} created, {write_result.get('skipped', 0)} skipped", file=sys.stderr)
            send_confirmation_reply(sender, reply['subject'], write_result)
            remove_pending_batch(batch_id)
            mark_processed(message_id)
            move_to_processed(reply['id'])
            results['processed'] += 1
        else:
            print(f"  Error: {write_result.get('error')}", file=sys.stderr)
            send_error_reply(sender, reply['subject'], write_result.get('error', 'Unknown error'))
            results['errors'] += 1

    return results


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

            # Parse CSV to get rates for pending storage
            rates = parse_csv_for_rates(output_path)
            batch_id = f"{year}-{month:02d}"

            # Save to pending for approval
            add_pending_batch(batch_id, rates, start_date, end_date, sender)
            print(f"  Saved {len(rates)} rates to pending batch {batch_id}", file=sys.stderr)

            # Send reply with attachment and instructions
            body = f"""Currency conversion rates processed successfully.

Date Range: {start_date} to {end_date}
Source: {attachment['filename']}
Currency Pairs: {len(rates)}

The attached CSV file is ready for review.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TO LOAD RATES INTO ORANGE TSUNAMI:

Reply to this email with "add" to push all {len(rates)} currency
pairs directly to the C_Conversion_Rate table.

Or import the CSV manually if you prefer.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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


def show_pending():
    """Show pending rate batches awaiting approval."""
    pending = load_pending_rates()

    if not pending:
        print("No pending rate batches")
        return

    print(f"Pending rate batches ({len(pending)}):\n")
    for batch_id, data in pending.items():
        print(f"  {batch_id}")
        print(f"    Rates: {len(data['rates'])}")
        print(f"    Date Range: {data['startDate']} to {data['endDate']}")
        print(f"    Sender: {data['sender']}")
        print(f"    Created: {data['created']}")
        print()


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
    parser.add_argument('--pending', action='store_true',
                        help='Show pending rate batches and exit')
    parser.add_argument('--replies-only', action='store_true',
                        help='Only process reply emails (skip new emails)')

    args = parser.parse_args()

    if args.clear:
        save_processed_state(set())
        print("Cleared processed message IDs")
        return

    if args.pending:
        show_pending()
        return

    if not SMTP_PASS:
        print("Warning: No SMTP/IMAP password configured", file=sys.stderr)

    if args.watch:
        print(f"Watching {INBOX_EMAIL} for currency emails (interval: {args.interval}s)", file=sys.stderr)
        print("Press Ctrl+C to stop", file=sys.stderr)

        while True:
            try:
                # Process new emails
                if not args.replies_only:
                    results = process_currency_emails(args.dry_run)
                    ts = datetime.now().strftime('%H:%M:%S')
                    print(f"\n[{ts}] New: Found={results['found']}, Processed={results['processed']}, Errors={results['errors']}", file=sys.stderr)

                # Process add replies
                reply_results = process_add_replies(args.dry_run)
                ts = datetime.now().strftime('%H:%M:%S')
                print(f"[{ts}] Replies: Found={reply_results['found']}, Processed={reply_results['processed']}, Errors={reply_results['errors']}", file=sys.stderr)

                time.sleep(args.interval)
            except KeyboardInterrupt:
                print("\nStopped", file=sys.stderr)
                break
            except Exception as e:
                print(f"Error: {e}", file=sys.stderr)
                time.sleep(args.interval)
    else:
        # Process new emails
        if not args.replies_only:
            results = process_currency_emails(args.dry_run)
            print(f"\nNew emails: {json.dumps(results)}")

        # Process add replies
        reply_results = process_add_replies(args.dry_run)
        print(f"Replies: {json.dumps(reply_results)}")


if __name__ == '__main__':
    main()
