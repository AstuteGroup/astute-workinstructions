#!/usr/bin/env python3
"""
MFR Reply Handler - Two-Step Workflow

Polls a mailbox for replies to MFR Check results emails.
Handles a two-step workflow:
  1. User replies "add" → Create MFR, send back Search Key, ask for M code
  2. User replies with M code → Update MFR description with M code

Usage:
    python mfr-reply-handler.py                    # Poll once
    python mfr-reply-handler.py --watch            # Poll continuously
    python mfr-reply-handler.py --dry-run          # Parse but don't create
    python mfr-reply-handler.py --mailbox vq       # Use specific mailbox

Supported reply commands:
  Step 1:
    - "add" / "yes" / "approve" / "create" → Creates the manufacturer

  Step 2:
    - "M12345" (M followed by digits) → Updates the MFR description with this code
    - "skip" / "no" → Skips adding M code, completes workflow

State is tracked in ~/.mfr-pending-mcodes.json
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from pathlib import Path
import smtplib

# State file for tracking pending M code assignments
STATE_FILE = Path.home() / '.mfr-pending-mcodes.json'

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

# Default mailbox
DEFAULT_MAILBOX = 'bizops'

# Account mapping
ACCOUNT_MAP = {
    'bizops': 'bizops@orangetsunami.com',
    'vq': 'bizops@orangetsunami.com',
    'excess': 'excess@orangetsunami.com',
    'stockrfq': 'stockRFQ@orangetsunami.com',
    'vortex': 'vortex@orangetsunami.com',
    'mfrcheck': 'mfrcheck@orangetsunami.com',
}

# Reply command patterns
ADD_PATTERNS = [
    r'\badd\b',
    r'\byes\b',
    r'\bapprove\b',
    r'\bcreate\b',
    r'\bconfirm\b',
    r'\bgo ahead\b',
    r'\bproceed\b',
]

SKIP_PATTERNS = [
    r'\bskip\b',
    r'\bno\b',
    r'\breject\b',
    r'\bignore\b',
    r'\bcancel\b',
    r'\bdone\b',
]

# M code pattern
MCODE_PATTERN = re.compile(r'\b(M\d{4,6})\b', re.IGNORECASE)

# Outlook URL pattern: text<url> or just url
OUTLOOK_URL_PATTERN = re.compile(r'([^<>\s]+)<([^<>]+)>')

ADD_RE = re.compile('|'.join(ADD_PATTERNS), re.IGNORECASE)
SKIP_RE = re.compile('|'.join(SKIP_PATTERNS), re.IGNORECASE)


def load_pending_state() -> dict:
    """Load pending M code assignments from state file."""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                data = json.load(f)
                # Ensure both keys exist
                if 'pending' not in data:
                    data['pending'] = {}
                if 'processed_ids' not in data:
                    data['processed_ids'] = []
                return data
        except (json.JSONDecodeError, IOError):
            return {'pending': {}, 'processed_ids': []}
    return {'pending': {}, 'processed_ids': []}


def save_pending_state(state: dict):
    """Save pending M code assignments to state file."""
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


def add_pending_mcode(mfr_id: int, mfr_name: str, mfr_code: str, recipient: str):
    """Add a manufacturer to the pending M code list."""
    state = load_pending_state()
    state['pending'][str(mfr_id)] = {
        'mfrId': mfr_id,
        'name': mfr_name,
        'code': mfr_code,
        'recipient': recipient,
        'created': datetime.now().isoformat(),
    }
    save_pending_state(state)


def remove_pending_mcode(mfr_id: int):
    """Remove a manufacturer from the pending M code list."""
    state = load_pending_state()
    state['pending'].pop(str(mfr_id), None)
    save_pending_state(state)


def find_pending_by_code(search_key: str) -> dict:
    """Find a pending MFR by its search key (code)."""
    state = load_pending_state()
    for mfr_id, data in state['pending'].items():
        if data.get('code') == search_key:
            return data
    return None


def is_email_processed(message_id: str) -> bool:
    """Check if an email has already been processed."""
    state = load_pending_state()
    return message_id in state.get('processed_ids', [])


def mark_email_processed(message_id: str):
    """Mark an email as processed to prevent duplicate handling."""
    state = load_pending_state()
    if 'processed_ids' not in state:
        state['processed_ids'] = []
    if message_id not in state['processed_ids']:
        state['processed_ids'].append(message_id)
        # Keep only last 500 message IDs to prevent unbounded growth
        if len(state['processed_ids']) > 500:
            state['processed_ids'] = state['processed_ids'][-500:]
        save_pending_state(state)


def get_imap_client(mailbox: str):
    """Create IMAP client for the specified mailbox."""
    import imaplib

    email_addr = ACCOUNT_MAP.get(mailbox.lower())
    if not email_addr:
        raise ValueError(f"Unknown mailbox: {mailbox}. Valid: {', '.join(ACCOUNT_MAP.keys())}")

    client = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    client.login(email_addr, SMTP_PASS)

    return client, email_addr


def fetch_mfr_replies(mailbox: str, folder: str = 'INBOX'):
    """Fetch emails that are replies to MFR Check or MFR Created emails."""
    import imaplib
    import email
    from email.header import decode_header

    client, email_addr = get_imap_client(mailbox)

    try:
        client.select(folder)

        # Search for MFR-related emails
        status, messages = client.search(None, '(OR (SUBJECT "MFR Check") (SUBJECT "MFR Created"))')

        if status != 'OK':
            print(f"Search failed: {status}", file=sys.stderr)
            return []

        email_ids = messages[0].split()
        results = []

        for eid in email_ids[-50:]:
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

            # Only process replies
            if not subject.lower().startswith('re:'):
                continue

            # Get body - combine text/plain and text/html for better extraction
            body = ''
            html_body = ''
            if msg.is_multipart():
                for part in msg.walk():
                    content_type = part.get_content_type()
                    payload = part.get_payload(decode=True)
                    if payload:
                        decoded = payload.decode('utf-8', errors='ignore')
                        if content_type == 'text/plain' and not body:
                            body = decoded
                        elif content_type == 'text/html' and not html_body:
                            html_body = decoded
            else:
                payload = msg.get_payload(decode=True)
                if payload:
                    body = payload.decode('utf-8', errors='ignore')

            # Combine plain text and HTML for extraction (HTML often has quoted content)
            combined_body = body + '\n' + html_body if html_body else body

            from_addr = msg['From'] or ''
            message_id = msg['Message-ID'] or f"no-id-{eid}"

            results.append({
                'id': eid.decode() if isinstance(eid, bytes) else eid,
                'message_id': message_id,
                'subject': subject,
                'from': from_addr,
                'date': msg['Date'],
                'body': combined_body,
                'raw': msg,
            })

        return results

    finally:
        client.logout()


def fetch_mfr_requests(mailbox: str, folder: str = 'INBOX'):
    """Fetch NEW MFR request emails (not replies)."""
    import imaplib
    import email
    from email.header import decode_header

    client, email_addr = get_imap_client(mailbox)

    try:
        client.select(folder)

        # Search for MFR request emails (flexible: any subject containing "MFR")
        status, messages = client.search(None, '(SUBJECT "MFR")')

        if status != 'OK':
            print(f"Search failed: {status}", file=sys.stderr)
            return []

        email_ids = messages[0].split()
        results = []

        for eid in email_ids[-50:]:
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

            # Skip replies - we want NEW requests only
            if subject.lower().startswith('re:'):
                continue

            # Skip our own outbound emails (check results, created notifications)
            if 'MFR Check Results' in subject or 'MFR Created' in subject or 'MFR Updated' in subject:
                continue

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

            from_addr = msg['From'] or ''
            message_id = msg['Message-ID'] or f"no-id-{eid}"

            results.append({
                'id': eid.decode() if isinstance(eid, bytes) else eid,
                'message_id': message_id,
                'subject': subject,
                'from': from_addr,
                'date': msg['Date'],
                'body': body,
                'raw': msg,
            })

        return results

    finally:
        client.logout()


def parse_mfr_input(content: str) -> list:
    """
    Parse MFR request content from email body.

    Supports two formats:
    1. Structured form with "MFR Name:", "Website URL:", "Alias:" fields
       - Value can be on same line OR next line
    2. Simple list with one manufacturer name per line
    """
    requests = []

    # Check if it's a structured form (contains "MFR Name:")
    if 'MFR Name:' in content:
        # Split by request markers
        blocks = re.split(r'(?:A new MFR Request has been submitted:|New MFR\s*\n)', content)

        for block in blocks:
            if not block.strip():
                continue

            # Extract fields using regex - handle value on same line OR next line
            # Pattern: "MFR Name:" followed by optional whitespace, then either:
            #   - content on same line, OR
            #   - newline + content on next line (before next field or blank line)
            name_match = re.search(r'MFR Name:\s*\n?\s*([^\n]+?)(?:\n|$)', block)
            url_match = re.search(r'Website URL:\s*\n?\s*(https?://[^\s\n]+)', block)
            alias_match = re.search(r'Alias:\s*\n?\s*([^\n]+?)(?:\n|$)', block)

            if name_match:
                name = name_match.group(1).strip()
                # Skip if name looks like another field label
                if name and not name.startswith('Website') and not name.startswith('Alias'):
                    requests.append({
                        'name': name,
                        'url': url_match.group(1).strip() if url_match else None,
                        'alias': alias_match.group(1).strip() if alias_match and alias_match.group(1).strip() else None
                    })
    else:
        # Simple list format - one name per line
        for line in content.split('\n'):
            line = line.strip()
            if line and not line.startswith('#') and not line.startswith('>'):
                # Skip common email artifacts
                if any(skip in line.lower() for skip in ['from:', 'to:', 'sent:', 'date:', 'subject:', 'cc:', 'bcc:']):
                    continue
                requests.append({
                    'name': line,
                    'url': None,
                    'alias': None
                })

    return requests


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
        if line.strip().startswith('_____'):
            break
        reply_lines.append(line)

    return '\n'.join(reply_lines).strip()


def parse_reply_command(body: str, subject: str) -> dict:
    """
    Parse the reply body to determine the command.
    Returns: {'type': 'add'|'mcode'|'skip'|'unknown', 'value': str|None}
    """
    reply_text = get_reply_text(body)

    # Check for M code first (takes priority if present)
    mcode_match = MCODE_PATTERN.search(reply_text)
    if mcode_match:
        return {'type': 'mcode', 'value': mcode_match.group(1).upper(), 'text': reply_text}

    # Check for add command
    if ADD_RE.search(reply_text):
        return {'type': 'add', 'value': None, 'text': reply_text}

    # Check for skip command
    if SKIP_RE.search(reply_text):
        return {'type': 'skip', 'value': None, 'text': reply_text}

    return {'type': 'unknown', 'value': None, 'text': reply_text}


def clean_outlook_url(url: str) -> str:
    """Clean Outlook's URL formatting like 'text<url>' -> 'url'."""
    if not url:
        return url

    # Handle Outlook format: friendly_text<actual_url>
    match = OUTLOOK_URL_PATTERN.match(url)
    if match:
        # Return just the URL from inside angle brackets
        return match.group(2)

    # Handle stray angle brackets
    url = url.strip('<>')

    return url


def extract_mfr_from_email(body: str) -> list:
    """Extract manufacturer details from the email thread."""
    manufacturers = []

    # Look for JSON block
    json_match = re.search(r'```json\s*([\s\S]*?)\s*```', body)
    if json_match:
        try:
            data = json.loads(json_match.group(1))
            if 'manufacturers' in data:
                for mfr in data['manufacturers']:
                    if mfr.get('action') == 'ADD':
                        manufacturers.append({
                            'name': mfr.get('searchName'),
                            'url': clean_outlook_url(mfr.get('providedUrl')),
                            'alias': mfr.get('providedAlias'),
                        })
            return manufacturers
        except json.JSONDecodeError:
            pass

    # Look for structured data
    name_match = re.search(r'"searchName":\s*"([^"]+)"', body)
    url_match = re.search(r'"providedUrl":\s*"([^"]*)"', body)
    alias_match = re.search(r'"providedAlias":\s*"([^"]*)"', body)

    if name_match:
        raw_url = url_match.group(1) if url_match and url_match.group(1) != 'null' else None
        manufacturers.append({
            'name': name_match.group(1),
            'url': clean_outlook_url(raw_url) if raw_url else None,
            'alias': alias_match.group(1) if alias_match and alias_match.group(1) != 'null' else None,
        })

    # Look for MFR Name: pattern
    mfr_name_match = re.search(r'MFR Name:\s*(.+?)(?:\n|$)', body)
    url_field_match = re.search(r'Website URL:\s*(.+?)(?:\n|$)', body)
    alias_field_match = re.search(r'Alias:\s*(.+?)(?:\n|$)', body)

    if mfr_name_match and not manufacturers:
        name = mfr_name_match.group(1).strip()
        if name:
            raw_url = url_field_match.group(1).strip() if url_field_match else None
            manufacturers.append({
                'name': name,
                'url': clean_outlook_url(raw_url) if raw_url else None,
                'alias': alias_field_match.group(1).strip() if alias_field_match else None,
            })

    # Look for HTML email format (quoted in reply)
    # Pattern: <div class="mfr-name">Name</div> or <div class="x_mfr-name">Name</div>
    # Note: Outlook adds "x_" prefix to CSS class names in quoted content
    if not manufacturers:
        # Try HTML div pattern (with optional x_ prefix for Outlook)
        html_name_match = re.search(r'class="(?:x_)?mfr-name"[^>]*>([^<]+)<', body)
        if html_name_match:
            name = html_name_match.group(1).strip()
            # Look for URL in nearby content
            html_url_match = re.search(r'URL:\s*<a[^>]*href="([^"]+)"', body)
            if not html_url_match:
                html_url_match = re.search(r'URL:\s*(https?://[^\s<>"]+)', body)
            # Also check for alias in the x_mfr-url div
            html_alias_match = re.search(r'class="(?:x_)?mfr-url"[^>]*>Alias:\s*([^<]+)<', body)
            raw_url = html_url_match.group(1) if html_url_match else None
            alias = html_alias_match.group(1).strip() if html_alias_match else None
            manufacturers.append({
                'name': name,
                'url': clean_outlook_url(raw_url) if raw_url else None,
                'alias': alias,
            })

    # Fallback: look for plain text patterns from email thread
    if not manufacturers:
        # Look for lines like "DMG Spa" followed by "URL: https://..."
        # Common in plain-text version of HTML emails
        lines = body.split('\n')
        for i, line in enumerate(lines):
            line = line.strip()
            # Skip common email headers and noise
            if any(skip in line.lower() for skip in ['from:', 'to:', 'sent:', 'date:', 'subject:', 'action:', 'best match:', 'website check:']):
                continue
            # Look for URL on next line
            if i + 1 < len(lines) and 'URL:' in lines[i + 1]:
                url_line = lines[i + 1]
                url_match = re.search(r'https?://[^\s<>"]+', url_line)
                if url_match and line and len(line) < 100:
                    manufacturers.append({
                        'name': line,
                        'url': clean_outlook_url(url_match.group(0)),
                        'alias': None,
                    })
                    break

    return manufacturers


def extract_mfr_code_from_subject(subject: str) -> str:
    """Extract MFR search key from subject like 'Re: MFR Created: MFR1000163 - SHURE'."""
    match = re.search(r'(MFR\d+)', subject)
    return match.group(1) if match else None


def call_write_mfr(opts: dict, dry_run: bool = False) -> dict:
    """Call the writeMfr CLI command via sudo."""
    if dry_run:
        print(f"  [DRY RUN] Would create: {opts}", file=sys.stderr)
        return {
            'mfrId': 0,
            'code': 'DRY_RUN',
            'name': opts.get('name'),
            'url': opts.get('url'),
            'alias': opts.get('alias'),
            'created': False,
            'dryRun': True
        }

    payload = json.dumps({'opts': opts})

    try:
        result = subprocess.run(
            ['sudo', '-n', '-u', 'analytics_user', '/opt/writeback/cli', 'mfr'],
            input=payload,
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode == 0:
            response = json.loads(result.stdout)
            return response.get('result', {})
        else:
            error_msg = result.stderr.strip() or result.stdout.strip() or f'Exit code {result.returncode}'
            raise RuntimeError(f"CLI error: {error_msg}")

    except subprocess.TimeoutExpired:
        raise RuntimeError("CLI timeout after 30s")
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON response: {e}")


def call_update_mfr_alias(opts: dict, dry_run: bool = False) -> dict:
    """Call the updateMfrAlias CLI command via sudo."""
    if dry_run:
        print(f"  [DRY RUN] Would update alias: {opts}", file=sys.stderr)
        return {'mfrId': opts['mfrId'], 'description': opts['mCode'], 'updated': False, 'dryRun': True}

    payload = json.dumps({'opts': opts})

    try:
        result = subprocess.run(
            ['sudo', '-n', '-u', 'analytics_user', '/opt/writeback/cli', 'mfr-alias'],
            input=payload,
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode == 0:
            response = json.loads(result.stdout)
            return response.get('result', {})
        else:
            error_msg = result.stderr.strip() or result.stdout.strip() or f'Exit code {result.returncode}'
            raise RuntimeError(f"CLI error: {error_msg}")

    except subprocess.TimeoutExpired:
        raise RuntimeError("CLI timeout after 30s")
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON response: {e}")


def send_mfr_created_email(to: str, mfr_result: dict, original_subject: str):
    """Send email after creating MFR, asking for M code."""
    if not SMTP_PASS:
        print("Warning: No SMTP password, skipping email", file=sys.stderr)
        return False

    mfr_code = mfr_result.get('code')
    mfr_name = mfr_result.get('name')

    subject = f"MFR Created: {mfr_code} - {mfr_name} - Reply with M Code"

    mfr_url = mfr_result.get('url') or 'N/A'
    mfr_alias = mfr_result.get('alias') or 'N/A'

    body = f"""Manufacturer created successfully!

Search Key: {mfr_code}
Name: {mfr_name}
ID: {mfr_result.get('mfrId')}
URL: {mfr_url}
Alias: {mfr_alias}

---

Please reply with the M code to add to the description/alias field.

Example reply: M12345

Or reply "skip" if no M code is needed.
"""

    try:
        msg = MIMEText(body)
        msg['Subject'] = subject
        msg['From'] = f'"MFR Check" <bizops@orangetsunami.com>'
        msg['To'] = to

        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login('bizops@orangetsunami.com', SMTP_PASS)
            server.send_message(msg)

        return True
    except Exception as e:
        print(f"Failed to send email: {e}", file=sys.stderr)
        return False


def send_manual_mfr_request_email(to: str, mfr: dict):
    """Send email requesting manual MFR creation (when CLI not available)."""
    if not SMTP_PASS:
        print("Warning: No SMTP password, skipping email", file=sys.stderr)
        return False

    mfr_name = mfr.get('name', 'Unknown')
    mfr_url = mfr.get('url') or 'N/A'
    mfr_alias = mfr.get('alias') or 'N/A'

    subject = f"Manual MFR Creation Request: {mfr_name}"

    body = f"""A new manufacturer needs to be created manually in OT.

Manufacturer Details:
- Name: {mfr_name}
- URL: {mfr_url}
- Alias: {mfr_alias}

The automated CLI is not yet configured for MFR creation.
Please create this manufacturer in OT and reply with the M code.

---
This request was approved via email reply.
"""

    try:
        msg = MIMEText(body)
        msg['Subject'] = subject
        msg['From'] = f'"MFR Check" <bizops@orangetsunami.com>'
        msg['To'] = to

        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login('bizops@orangetsunami.com', SMTP_PASS)
            server.send_message(msg)

        return True
    except Exception as e:
        print(f"Failed to send email: {e}", file=sys.stderr)
        return False


def send_mcode_confirmation_email(to: str, update_result: dict, mfr_code: str):
    """Send confirmation email after adding M code."""
    if not SMTP_PASS:
        return False

    subject = f"MFR Updated: {mfr_code} - M Code Added"

    body = f"""M code added successfully!

Manufacturer: {update_result.get('name')}
Search Key: {mfr_code}
Description: {update_result.get('description')}

The manufacturer record is now complete.
"""

    try:
        msg = MIMEText(body)
        msg['Subject'] = subject
        msg['From'] = f'"MFR Check" <bizops@orangetsunami.com>'
        msg['To'] = to

        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login('bizops@orangetsunami.com', SMTP_PASS)
            server.send_message(msg)

        return True
    except Exception as e:
        print(f"Failed to send email: {e}", file=sys.stderr)
        return False


def move_to_processed(mailbox: str, email_id: str, folder: str = 'INBOX'):
    """Move processed email to Processed folder."""
    import imaplib

    client, _ = get_imap_client(mailbox)

    try:
        client.select(folder)
        client.create('Processed')
        client.copy(email_id, 'Processed')
        client.store(email_id, '+FLAGS', '\\Deleted')
        client.expunge()
        return True
    except Exception as e:
        print(f"Failed to move email: {e}", file=sys.stderr)
        return False
    finally:
        client.logout()


def extract_email_address(from_field: str) -> str:
    """Extract email address from 'Name <email>' format."""
    match = re.search(r'<([^>]+)>', from_field)
    return match.group(1) if match else from_field


def process_replies(mailbox: str, dry_run: bool = False, folder: str = 'INBOX'):
    """Main processing loop."""
    print(f"Fetching MFR replies from {mailbox}@orangetsunami.com...", file=sys.stderr)

    try:
        replies = fetch_mfr_replies(mailbox, folder)
    except Exception as e:
        print(f"Error fetching emails: {e}", file=sys.stderr)
        return {'processed': 0, 'errors': 1}

    print(f"Found {len(replies)} MFR reply(ies)", file=sys.stderr)

    results = {'processed': 0, 'created': 0, 'updated': 0, 'skipped': 0, 'errors': 0}

    for reply in replies:
        message_id = reply.get('message_id', '')

        # Skip if already processed
        if is_email_processed(message_id):
            print(f"\nSkipping (already processed): {reply['subject']}", file=sys.stderr)
            continue

        print(f"\nProcessing: {reply['subject']}", file=sys.stderr)
        print(f"  From: {reply['from']}", file=sys.stderr)

        cmd = parse_reply_command(reply['body'], reply['subject'])
        print(f"  Command type: {cmd['type']}", file=sys.stderr)

        sender = extract_email_address(reply['from'])

        # Handle M code reply (step 2)
        if cmd['type'] == 'mcode':
            mcode = cmd['value']
            print(f"  M code detected: {mcode}", file=sys.stderr)

            # Find the MFR code from the subject
            mfr_code = extract_mfr_code_from_subject(reply['subject'])
            if not mfr_code:
                print(f"  Error: Could not find MFR code in subject", file=sys.stderr)
                results['errors'] += 1
                continue

            # Look up pending MFR
            pending = find_pending_by_code(mfr_code)
            if not pending:
                print(f"  Error: No pending MFR found for {mfr_code}", file=sys.stderr)
                results['errors'] += 1
                continue

            print(f"  Updating {pending['name']} (ID: {pending['mfrId']}) with {mcode}", file=sys.stderr)

            try:
                update_result = call_update_mfr_alias({
                    'mfrId': pending['mfrId'],
                    'mCode': mcode,
                }, dry_run=dry_run)

                if update_result.get('updated') or update_result.get('dryRun'):
                    print(f"  Updated: {update_result.get('description')}", file=sys.stderr)
                    results['updated'] += 1

                    # Send confirmation
                    send_mcode_confirmation_email(sender, {
                        **update_result,
                        'name': pending['name'],
                    }, mfr_code)

                    # Remove from pending and mark as processed
                    mark_email_processed(message_id)
                    if not dry_run:
                        remove_pending_mcode(pending['mfrId'])
                        move_to_processed(mailbox, reply['id'], folder)

                else:
                    print(f"  Already has M code: {update_result.get('description')}", file=sys.stderr)
                    mark_email_processed(message_id)

                results['processed'] += 1

            except Exception as e:
                print(f"  Error updating MFR: {e}", file=sys.stderr)
                results['errors'] += 1
            continue

        # Handle skip command
        if cmd['type'] == 'skip':
            # Check if this is step 2 (skip M code for pending MFR)
            mfr_code = extract_mfr_code_from_subject(reply['subject'])
            if mfr_code:
                pending = find_pending_by_code(mfr_code)
                if pending:
                    print(f"  Skipping M code for {pending['name']}", file=sys.stderr)
                    mark_email_processed(message_id)
                    if not dry_run:
                        remove_pending_mcode(pending['mfrId'])
                        move_to_processed(mailbox, reply['id'], folder)
                    results['skipped'] += 1
                    results['processed'] += 1
                    continue

            # Otherwise this is step 1 skip (user doesn't want to add the MFR)
            print(f"  Skipping MFR creation (user declined)", file=sys.stderr)
            mark_email_processed(message_id)
            if not dry_run:
                move_to_processed(mailbox, reply['id'], folder)
            results['skipped'] += 1
            results['processed'] += 1
            continue

        # Handle add command (step 1)
        if cmd['type'] == 'add':
            manufacturers = extract_mfr_from_email(reply['body'])

            if not manufacturers:
                print(f"  Error: Could not extract manufacturer details", file=sys.stderr)
                results['errors'] += 1
                continue

            for mfr in manufacturers:
                print(f"  Creating: {mfr['name']}", file=sys.stderr)

                try:
                    mfr_result = call_write_mfr(mfr, dry_run=dry_run)

                    if mfr_result.get('created') or mfr_result.get('dryRun'):
                        print(f"  Created: {mfr_result['name']} (Code: {mfr_result['code']})", file=sys.stderr)
                        results['created'] += 1

                        # Add to pending M code list
                        if not dry_run:
                            add_pending_mcode(
                                mfr_result['mfrId'],
                                mfr_result['name'],
                                mfr_result['code'],
                                sender
                            )

                        # Send email asking for M code
                        send_mfr_created_email(sender, mfr_result, reply['subject'])

                    else:
                        print(f"  Already exists: {mfr_result.get('name')}", file=sys.stderr)

                except Exception as e:
                    error_msg = str(e)
                    # Check if CLI subcommand not available yet
                    if 'Unknown subcommand: mfr' in error_msg:
                        print(f"  CLI not ready - sending manual request email", file=sys.stderr)
                        # Send email to operator for manual creation
                        send_manual_mfr_request_email(sender, mfr)
                        results['created'] += 1  # Count as handled
                    else:
                        print(f"  Error creating MFR: {e}", file=sys.stderr)
                        results['errors'] += 1
                    continue

            mark_email_processed(message_id)
            if not dry_run:
                move_to_processed(mailbox, reply['id'], folder)
            results['processed'] += 1
            continue

        # Unknown command
        if cmd['type'] == 'unknown':
            print(f"  Skipping - no clear command detected", file=sys.stderr)
            print(f"  Reply text: {cmd['text'][:100]}...", file=sys.stderr)

    return results


def show_pending():
    """Show pending M code assignments."""
    state = load_pending_state()
    pending = state.get('pending', {})

    if not pending:
        print("No pending M code assignments")
        return

    print(f"Pending M code assignments ({len(pending)}):\n")
    for mfr_id, data in pending.items():
        print(f"  {data['code']} - {data['name']}")
        print(f"    ID: {mfr_id}, Created: {data['created']}")
        print(f"    Recipient: {data['recipient']}")
        print()


def clear_processed():
    """Clear the list of processed message IDs."""
    state = load_pending_state()
    count = len(state.get('processed_ids', []))
    state['processed_ids'] = []
    save_pending_state(state)
    print(f"Cleared {count} processed message ID(s)")


def process_mfr_requests(mailbox: str, reviewer: str, dry_run: bool = False, folder: str = 'INBOX'):
    """
    Fetch new MFR request emails, run batch check, and send results to reviewer.

    This is the inbox scraper mode: monitors mailbox for incoming MFR requests,
    parses them, runs the fuzzy match check, and emails results to the reviewer.
    """
    import subprocess
    import tempfile

    print(f"Fetching MFR requests from {mailbox}@orangetsunami.com...", file=sys.stderr)

    results = {
        'found': 0,
        'processed': 0,
        'errors': 0,
    }

    try:
        requests = fetch_mfr_requests(mailbox, folder)
    except Exception as e:
        print(f"Error fetching emails: {e}", file=sys.stderr)
        return results

    if not requests:
        print("No new MFR requests found", file=sys.stderr)
        return results

    print(f"Found {len(requests)} MFR request email(s)", file=sys.stderr)
    results['found'] = len(requests)

    state = load_pending_state()
    processed_ids = set(state.get('processed_ids', []))

    for req in requests:
        message_id = req['message_id']

        # Skip already processed
        if message_id in processed_ids:
            print(f"  Already processed: {req['subject'][:50]}...", file=sys.stderr)
            continue

        print(f"\nProcessing: {req['subject']}", file=sys.stderr)
        print(f"  From: {req['from']}", file=sys.stderr)

        # Parse MFR info from email body
        mfrs = parse_mfr_input(req['body'])

        if not mfrs:
            print(f"  No MFR names found in email body", file=sys.stderr)
            results['errors'] += 1
            continue

        print(f"  Found {len(mfrs)} manufacturer(s): {', '.join(m['name'] for m in mfrs)}", file=sys.stderr)

        # Create temp file with MFR info in structured format
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            for mfr in mfrs:
                f.write(f"MFR Name: {mfr['name']}\n")
                if mfr.get('url'):
                    f.write(f"Website URL: {mfr['url']}\n")
                if mfr.get('alias'):
                    f.write(f"Alias: {mfr['alias']}\n")
                f.write("\n")  # Blank line separator
            temp_file = f.name

        try:
            # Run batch check
            script_dir = os.path.dirname(os.path.abspath(__file__))
            batch_check = os.path.join(script_dir, 'mfr-batch-check.py')

            cmd = ['python3', batch_check, temp_file, '--to', reviewer]
            if dry_run:
                cmd.append('--dry-run')

            print(f"  Running batch check...", file=sys.stderr)
            result = subprocess.run(cmd, capture_output=True, text=True)

            if result.returncode == 0 or 'Email sent' in result.stderr:
                print(f"  Results sent to {reviewer}", file=sys.stderr)
                results['processed'] += 1

                # Mark as processed
                if not dry_run:
                    mark_email_processed(message_id)
                    move_to_processed(mailbox, req['id'], folder)
            else:
                print(f"  Batch check failed: {result.stderr}", file=sys.stderr)
                results['errors'] += 1

        except Exception as e:
            print(f"  Error running batch check: {e}", file=sys.stderr)
            results['errors'] += 1
        finally:
            # Clean up temp file
            try:
                os.unlink(temp_file)
            except:
                pass

    return results


def main():
    parser = argparse.ArgumentParser(description='Handle MFR Check email replies (two-step workflow)')
    parser.add_argument('--mailbox', '-m', default=DEFAULT_MAILBOX,
                        help=f'Mailbox to poll (default: {DEFAULT_MAILBOX})')
    parser.add_argument('--folder', '-f', default='INBOX',
                        help='Folder to check (default: INBOX)')
    parser.add_argument('--watch', '-w', action='store_true',
                        help='Poll continuously (every 60s)')
    parser.add_argument('--interval', '-i', type=int, default=60,
                        help='Poll interval in seconds (default: 60)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Parse emails but do not create/update manufacturers')
    parser.add_argument('--pending', action='store_true',
                        help='Show pending M code assignments and exit')
    parser.add_argument('--clear-processed', action='store_true',
                        help='Clear processed message IDs and exit')
    parser.add_argument('--requests', '-r', action='store_true',
                        help='Scrape inbox for new MFR requests (instead of replies)')
    parser.add_argument('--reviewer', default='justin.oberhofer@astutegroup.com',
                        help='Email to send check results to (default: justin.oberhofer@astutegroup.com)')

    args = parser.parse_args()

    if args.clear_processed:
        clear_processed()
        return

    if args.pending:
        show_pending()
        return

    if args.mailbox not in ACCOUNT_MAP:
        print(f"Error: Unknown mailbox '{args.mailbox}'", file=sys.stderr)
        print(f"Valid mailboxes: {', '.join(ACCOUNT_MAP.keys())}", file=sys.stderr)
        sys.exit(1)

    if not SMTP_PASS:
        print("Warning: No SMTP/IMAP password configured", file=sys.stderr)

    # Handle --requests mode (scrape for new MFR requests)
    if args.requests:
        if args.watch:
            print(f"Watching {args.mailbox}@orangetsunami.com for MFR requests (interval: {args.interval}s)", file=sys.stderr)
            print(f"Results will be sent to: {args.reviewer}", file=sys.stderr)
            print("Press Ctrl+C to stop", file=sys.stderr)

            while True:
                try:
                    results = process_mfr_requests(args.mailbox, args.reviewer, args.dry_run, args.folder)
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
            results = process_mfr_requests(args.mailbox, args.reviewer, args.dry_run, args.folder)
            print(f"\nResults: {json.dumps(results)}")
        return

    # Default mode: handle replies
    if args.watch:
        print(f"Watching {args.mailbox}@orangetsunami.com (interval: {args.interval}s)", file=sys.stderr)
        print("Press Ctrl+C to stop", file=sys.stderr)

        while True:
            try:
                results = process_replies(args.mailbox, args.dry_run, args.folder)
                ts = datetime.now().strftime('%H:%M:%S')
                print(f"\n[{ts}] Processed: {results['processed']}, Created: {results['created']}, Updated: {results['updated']}, Errors: {results['errors']}", file=sys.stderr)
                time.sleep(args.interval)
            except KeyboardInterrupt:
                print("\nStopped", file=sys.stderr)
                break
            except Exception as e:
                print(f"Error: {e}", file=sys.stderr)
                time.sleep(args.interval)
    else:
        results = process_replies(args.mailbox, args.dry_run, args.folder)
        print(f"\nResults: {json.dumps(results)}")


if __name__ == '__main__':
    main()
