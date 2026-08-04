#!/usr/bin/env python3
"""
Manufacturer Batch Check + Email Report

Reads manufacturer requests from an email/file, runs OT fuzzy match,
and emails the results as JSON.

Supports two input formats:
1. Simple list - one manufacturer name per line
2. Structured form - "MFR Name:", "Website URL:", "Alias:" fields

Usage:
    python mfr-batch-check.py input.txt
    python mfr-batch-check.py input.txt --to jake.harris@astutegroup.com
    python mfr-batch-check.py input.txt --dry-run   # skip email, print JSON to console
    python mfr-batch-check.py input.txt --output results.json  # save JSON to file

Future: Add --mailbox flag to poll from an OT mailbox instead of file
"""

import argparse
import json
import re
import subprocess
import smtplib
import os
import sys
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from pathlib import Path

# Load environment variables from ~/workspace/.env
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
SMTP_USER = 'bizops@orangetsunami.com'
SMTP_PASS = os.environ.get('WORKMAIL_PASS') or os.environ.get('SMTP_PASS')
FROM_EMAIL = 'bizops@orangetsunami.com'
FROM_NAME = 'MFR Check'

# Allowed email domains (security: only send to internal addresses)
ALLOWED_DOMAINS = ['astutegroup.com', 'orangetsunami.com']


def is_internal_email(email: str) -> bool:
    """Check if email is internal (allowed domain)."""
    if not email:
        return False
    domain = email.lower().split('@')[-1]
    return any(domain == d or domain.endswith('.' + d) for d in ALLOWED_DOMAINS)


def format_email_links(email_string: str) -> str:
    """
    Convert email addresses in a string to mailto: hyperlinks.

    Handles formats like:
    - "Name <email@example.com>"
    - "email@example.com"
    - Multiple addresses separated by commas
    """
    if not email_string:
        return ''

    # Pattern to match "Name <email>" or just "email"
    email_pattern = re.compile(r'([^<,]+?)\s*<([^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})')

    result = email_string

    # Find all email patterns and replace with links
    for match in email_pattern.finditer(email_string):
        if match.group(2):  # "Name <email>" format
            name = match.group(1).strip().strip('"')
            email = match.group(2).strip()
            original = match.group(0)
            linked = f'{name} &lt;<a href="mailto:{email}">{email}</a>&gt;'
            result = result.replace(original, linked)
        elif match.group(3):  # Plain email format
            email = match.group(3)
            result = result.replace(email, f'<a href="mailto:{email}">{email}</a>')

    return result


# Company suffix normalization patterns
# Maps various forms to a canonical form for comparison
SUFFIX_NORMALIZATIONS = [
    # Italian - Società per Azioni
    (r'\bS\.?p\.?A\.?\b', 'SPA'),
    (r'\bSocieta per Azioni\b', 'SPA'),
    # Italian - Società a responsabilità limitata
    (r'\bS\.?r\.?l\.?\b', 'SRL'),
    # German - Gesellschaft mit beschränkter Haftung
    (r'\bG\.?m\.?b\.?H\.?\b', 'GMBH'),
    (r'\bGesellschaft mit beschrankter Haftung\b', 'GMBH'),
    # German - Aktiengesellschaft
    (r'\bA\.?G\.?\b', 'AG'),
    # US/UK - Incorporated
    (r'\bInc\.?\b', 'INC'),
    (r'\bIncorporated\b', 'INC'),
    # US/UK - Corporation
    (r'\bCorp\.?\b', 'CORP'),
    (r'\bCorporation\b', 'CORP'),
    # US/UK - Limited
    (r'\bLtd\.?\b', 'LTD'),
    (r'\bLimited\b', 'LTD'),
    # US - Limited Liability Company
    (r'\bL\.?L\.?C\.?\b', 'LLC'),
    # US - Limited Partnership
    (r'\bL\.?P\.?\b', 'LP'),
    # France - Société Anonyme
    (r'\bS\.?A\.?\b', 'SA'),
    # Netherlands - Besloten Vennootschap
    (r'\bB\.?V\.?\b', 'BV'),
    # Netherlands - Naamloze Vennootschap
    (r'\bN\.?V\.?\b', 'NV'),
    # Japan - Kabushiki Kaisha
    (r'\bK\.?K\.?\b', 'KK'),
    # Korea - Co., Ltd.
    (r'\bCo\.?,?\s*Ltd\.?\b', 'CO LTD'),
    # General - Company
    (r'\bCo\.?\b', 'CO'),
    # General - And / &
    (r'\s+&\s+', ' AND '),
]


def normalize_company_name(name: str) -> str:
    """
    Normalize company name for better fuzzy matching.

    - Standardizes company suffixes (Spa -> SPA, Inc. -> INC, etc.)
    - Removes extra whitespace
    - Converts to uppercase for comparison
    """
    if not name:
        return ''

    normalized = name.upper().strip()

    # Apply suffix normalizations
    for pattern, replacement in SUFFIX_NORMALIZATIONS:
        normalized = re.sub(pattern, replacement, normalized, flags=re.IGNORECASE)

    # Clean up whitespace
    normalized = re.sub(r'\s+', ' ', normalized).strip()

    return normalized


def parse_mfr_request(content: str) -> list:
    """
    Parse manufacturer request from email content.

    Supports two formats:
    1. Structured form with "MFR Name:", "Website URL:", "Alias:" fields
       - Value can be on same line OR next line
    2. Simple list with one manufacturer name per line

    Returns list of dicts: [{'name': str, 'url': str|None, 'alias': str|None}]
    """
    requests = []

    # Check if it's a structured form (contains "MFR Name:")
    if 'MFR Name:' in content:
        # Parse structured format
        # Can have multiple requests in one email (separated by "New MFR" or "A new MFR Request")

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
            if line and not line.startswith('#'):
                requests.append({
                    'name': line,
                    'url': None,
                    'alias': None
                })

    return requests


def check_website_type(url: str) -> dict:
    """
    Check if a website appears to be a manufacturer vs distributor.
    Calls mfr-fuzzy-check.js with --check-website flag.

    Returns dict with: type (MANUFACTURER/DISTRIBUTOR/UNKNOWN), confidence, signals
    """
    import subprocess

    if not url:
        return None

    # Normalize URL
    if not url.startswith('http'):
        url = 'https://' + url

    script_dir = os.path.dirname(os.path.abspath(__file__))
    js_script = os.path.join(script_dir, 'mfr-fuzzy-check.js')

    try:
        # Run the JS script with --url flag (which triggers website check)
        result = subprocess.run(
            ['node', js_script, 'URL_CHECK_ONLY', '--url', url],
            capture_output=True,
            text=True,
            timeout=60
        )

        output = result.stdout + result.stderr

        # Parse the output for website check results
        website_result = {
            'url': url,
            'type': 'UNKNOWN',
            'confidence': 'low',
            'signals': []
        }

        # Look for the classification line
        if 'MANUFACTURER' in output.upper() and 'DISTRIBUTOR' not in output.upper():
            website_result['type'] = 'MANUFACTURER'
            website_result['confidence'] = 'high' if 'high confidence' in output.lower() else 'medium'
        elif 'DISTRIBUTOR' in output.upper():
            website_result['type'] = 'DISTRIBUTOR'
            website_result['confidence'] = 'high' if 'high confidence' in output.lower() else 'medium'

        # Extract signals if present
        for line in output.split('\n'):
            if 'signal:' in line.lower() or '✓' in line or '✗' in line:
                website_result['signals'].append(line.strip())

        return website_result

    except subprocess.TimeoutExpired:
        return {'url': url, 'type': 'TIMEOUT', 'confidence': 'none', 'signals': ['Website check timed out']}
    except Exception as e:
        return {'url': url, 'type': 'ERROR', 'confidence': 'none', 'signals': [str(e)]}


def fuzzy_match_manufacturer(name: str, threshold: float = 0.3) -> list:
    """
    Run fuzzy match query against OT manufacturers.
    Returns list of matches with score, quality, etc.

    Uses company name normalization to improve matching of equivalent
    suffixes like "Spa" vs "S.p.A", "Inc" vs "Inc.", etc.
    """
    escaped_name = name.replace("'", "''")
    normalized_search = normalize_company_name(name)
    escaped_normalized = normalized_search.replace("'", "''")

    # Query with both raw and normalized matching
    # Use lower threshold initially, then re-score with normalization
    query = f"""
    WITH scored AS (
      SELECT
        chuboe_mfr_id,
        name,
        value as code,
        url,
        description,
        similarity(LOWER(name), LOWER('{escaped_name}')) as raw_name_score,
        COALESCE(word_similarity(LOWER('{escaped_name}'), LOWER(description)), 0) as desc_score
      FROM adempiere.chuboe_mfr
      WHERE isactive = 'Y'
    )
    SELECT
      chuboe_mfr_id,
      name,
      code,
      url,
      description,
      raw_name_score,
      desc_score
    FROM scored
    WHERE raw_name_score >= 0.2
       OR desc_score >= 0.2
    ORDER BY GREATEST(raw_name_score, desc_score) DESC
    LIMIT 20;
    """

    try:
        result = subprocess.run(
            ['psql', '-t', '-A', '-F|', '-c', query.replace('\n', ' ')],
            capture_output=True,
            text=True,
            check=True
        )

        candidates = []
        for row in result.stdout.strip().split('\n'):
            if not row:
                continue
            parts = row.split('|')
            if len(parts) >= 7:
                candidates.append({
                    'id': int(parts[0]) if parts[0] else None,
                    'name': parts[1].strip() if parts[1] else None,
                    'code': parts[2].strip() if parts[2] else None,
                    'url': parts[3].strip() if parts[3] else None,
                    'alias': parts[4].strip() if parts[4] else None,
                    'raw_name_score': float(parts[5]) if parts[5] else 0,
                    'desc_score': float(parts[6]) if parts[6] else 0,
                })

        # Re-score candidates with normalized names
        matches = []
        for c in candidates:
            normalized_db = normalize_company_name(c['name'] or '')

            # Check for exact match after normalization (e.g., "DMG Spa" == "DMG S.p.A")
            is_exact = normalized_search == normalized_db

            if is_exact:
                # Exact normalized match - this is what we want normalization for
                best_score = 1.0
                match_field = 'name (normalized)'
            else:
                # Not exact - use original trigram scores only
                # Don't use SequenceMatcher as it inflates scores for shared suffixes
                # e.g., "ACME CORP" vs "COMPEX CORP" would get 80% just from "CORP"
                best_score = max(c['raw_name_score'], c['desc_score'])
                match_field = 'name' if c['raw_name_score'] >= c['desc_score'] else 'alias'

            # Determine quality
            if is_exact:
                quality = 'EXACT'
            elif best_score >= 0.6:
                quality = 'HIGH'
            elif best_score >= 0.4:
                quality = 'MEDIUM'
            else:
                quality = 'LOW'

            if best_score >= threshold:
                matches.append({
                    'id': c['id'],
                    'name': c['name'],
                    'code': c['code'],
                    'url': c['url'],
                    'alias': c['alias'],
                    'score': best_score,
                    'quality': quality,
                    'matchField': match_field,
                    'normalizedSearch': normalized_search,
                    'normalizedDb': normalized_db,
                })

        # Sort by: exact match first, then score, then prefer name matches over alias
        # Tiebreaker: name matches are more relevant than alias/description matches
        def sort_key(m):
            exact_priority = 0 if m['quality'] == 'EXACT' else 1
            field_priority = 0 if 'name' in m['matchField'] else 1  # prefer name matches
            return (exact_priority, -m['score'], field_priority)

        matches.sort(key=sort_key)

        return matches[:5]

    except subprocess.CalledProcessError as e:
        print(f"Query error for '{name}': {e.stderr}", file=sys.stderr)
        return []


def process_manufacturers(requests: list, threshold: float = 0.3) -> dict:
    """
    Process a list of manufacturer requests and return results as JSON-serializable dict.

    Args:
        requests: List of dicts with 'name', 'url', 'alias' keys
        threshold: Similarity threshold for fuzzy matching
    """
    results = {
        'timestamp': datetime.now().isoformat(),
        'threshold': threshold,
        'totalChecked': len(requests),
        'summary': {
            'exact': 0,
            'high': 0,
            'medium': 0,
            'low': 0,
            'noMatch': 0
        },
        'manufacturers': []
    }

    for req in requests:
        name = req['name']
        print(f"  Checking: {name}", file=sys.stderr)
        matches = fuzzy_match_manufacturer(name, threshold)
        best_match = matches[0] if matches else None

        # Check website if URL provided
        website_check = None
        if req.get('url'):
            print(f"    Checking website: {req['url']}", file=sys.stderr)
            website_check = check_website_type(req['url'])
            if website_check:
                print(f"    -> Website type: {website_check['type']} ({website_check['confidence']})", file=sys.stderr)

        mfr_result = {
            'searchName': name,
            'providedUrl': req.get('url'),
            'providedAlias': req.get('alias'),
            'websiteCheck': website_check,
            'matchCount': len(matches),
            'bestMatch': best_match,
            'allMatches': matches,
            'action': None
        }

        # Determine recommended action
        if not best_match:
            mfr_result['action'] = 'ADD'
            results['summary']['noMatch'] += 1
            print(f"    -> No match (recommend ADD)", file=sys.stderr)
        elif best_match['quality'] == 'EXACT':
            mfr_result['action'] = 'EXISTS'
            results['summary']['exact'] += 1
            print(f"    -> EXACT: {best_match['name']} (ID: {best_match['id']})", file=sys.stderr)
        elif best_match['quality'] == 'HIGH':
            mfr_result['action'] = 'REVIEW'
            results['summary']['high'] += 1
            print(f"    -> HIGH ({best_match['score']*100:.0f}%): {best_match['name']}", file=sys.stderr)
        elif best_match['quality'] == 'MEDIUM':
            mfr_result['action'] = 'REVIEW'
            results['summary']['medium'] += 1
            print(f"    -> MEDIUM ({best_match['score']*100:.0f}%): {best_match['name']}", file=sys.stderr)
        else:
            mfr_result['action'] = 'ADD'
            results['summary']['low'] += 1
            print(f"    -> LOW ({best_match['score']*100:.0f}%): {best_match['name']}", file=sys.stderr)

        results['manufacturers'].append(mfr_result)

    return results


def format_html_email(results: dict, requested_by: str = '', cc_recipients: str = '') -> str:
    """Format results as HTML email body."""
    timestamp = datetime.fromisoformat(results['timestamp']).strftime('%Y-%m-%d %H:%M:%S CT')
    summary = results['summary']

    html = f"""
<!DOCTYPE html>
<html>
<head>
  <style>
    body {{ font-family: Arial, sans-serif; font-size: 14px; color: #333; }}
    h1 {{ color: #2c3e50; font-size: 20px; }}
    h2 {{ color: #34495e; font-size: 16px; margin-top: 20px; border-bottom: 1px solid #ddd; padding-bottom: 5px; }}
    .exact {{ color: #27ae60; font-weight: bold; }}
    .high {{ color: #2980b9; }}
    .medium {{ color: #f39c12; }}
    .low {{ color: #95a5a6; }}
    .no-match {{ color: #e74c3c; }}
    .action-add {{ background: #e8f5e9; padding: 3px 8px; border-radius: 3px; }}
    .action-exists {{ background: #fff3e0; padding: 3px 8px; border-radius: 3px; }}
    .action-review {{ background: #fff8e1; padding: 3px 8px; border-radius: 3px; }}
    table {{ border-collapse: collapse; margin: 10px 0; }}
    th, td {{ border: 1px solid #ddd; padding: 6px 10px; text-align: left; }}
    th {{ background: #f5f5f5; }}
    .summary {{ background: #ecf0f1; padding: 10px; border-radius: 4px; margin: 15px 0; }}
    .mfr-block {{ margin: 15px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }}
    .mfr-name {{ font-size: 16px; font-weight: bold; }}
    .mfr-url {{ font-size: 12px; color: #666; }}
  </style>
</head>
<body>
  <h1>Manufacturer Check Results</h1>
  <p>Generated: {timestamp}</p>
  <p>Checked {results['totalChecked']} manufacturer(s)</p>
"""

    # Add requester and CC info if provided
    if requested_by or cc_recipients:
        html += '  <div style="background: #f5f5f5; padding: 10px; border-radius: 4px; margin: 10px 0; font-size: 13px;">\n'
        if requested_by:
            requester_linked = format_email_links(requested_by)
            html += f'    <p style="margin: 3px 0;"><strong>Requested by:</strong> {requester_linked}</p>\n'
        if cc_recipients:
            cc_linked = format_email_links(cc_recipients)
            html += f'    <p style="margin: 3px 0;"><strong>Also copied:</strong> {cc_linked}</p>\n'
        html += '  </div>\n'

    html += """
  <div class="summary">
    <strong>Summary:</strong>
    <ul>
      <li><span class="exact">EXACT matches:</span> {summary['exact']} (already in OT - no action needed)</li>
      <li><span class="high">HIGH matches:</span> {summary['high']} (likely duplicates - review before adding)</li>
      <li><span class="medium">MEDIUM matches:</span> {summary['medium']} (possible match - review)</li>
      <li><span class="no-match">No matches:</span> {summary['noMatch']} (may need to add to OT)</li>
    </ul>
  </div>

  <div style="background: #e3f2fd; padding: 12px; border-radius: 4px; margin: 15px 0; border-left: 4px solid #2196f3;">
    <strong>To add a manufacturer:</strong> Reply to this email with "<strong>add</strong>" and the manufacturer will be created in OT automatically.
    <br><small style="color: #666;">Other commands: "skip" to dismiss without adding</small>
  </div>
"""

    # Add each manufacturer result
    for mfr in results['manufacturers']:
        action = mfr['action']
        action_class = 'action-add' if action == 'ADD' else ('action-exists' if action == 'EXISTS' else 'action-review')
        best = mfr.get('bestMatch')

        html += f"""
  <div class="mfr-block">
    <div class="mfr-name">{mfr['searchName']}</div>
"""
        if mfr.get('providedUrl'):
            html += f'    <div class="mfr-url">URL: <a href="{mfr["providedUrl"]}">{mfr["providedUrl"]}</a></div>\n'
        if mfr.get('providedAlias'):
            html += f'    <div class="mfr-url">Alias: {mfr["providedAlias"]}</div>\n'

        # Show website check results
        if mfr.get('websiteCheck'):
            wc = mfr['websiteCheck']
            wc_type = wc.get('type', 'UNKNOWN')
            wc_conf = wc.get('confidence', 'low')

            if wc_type == 'MANUFACTURER':
                wc_style = 'background: #c8e6c9; color: #2e7d32; padding: 4px 8px; border-radius: 4px; font-weight: bold;'
                wc_icon = '✓'
            elif wc_type == 'DISTRIBUTOR':
                wc_style = 'background: #ffcdd2; color: #c62828; padding: 4px 8px; border-radius: 4px; font-weight: bold;'
                wc_icon = '✗'
            else:
                wc_style = 'background: #fff3e0; color: #ef6c00; padding: 4px 8px; border-radius: 4px;'
                wc_icon = '?'

            html += f'    <p><strong>Website Check:</strong> <span style="{wc_style}">{wc_icon} {wc_type}</span> ({wc_conf} confidence)</p>\n'

        html += f'    <p><strong>Action:</strong> <span class="{action_class}">{action}</span></p>\n'

        if best:
            # Show top 3 matches over 30% threshold
            top_matches = [m for m in mfr.get('allMatches', [])[:3] if m.get('score', 0) >= 0.3]
            if top_matches:
                html += '    <p><strong>Potential matches in OT:</strong></p>\n'
                html += '    <table style="width:100%; margin: 5px 0;">\n'
                html += '      <tr><th>Match</th><th>Score</th><th>Code</th><th>URL</th></tr>\n'
                for i, match in enumerate(top_matches):
                    quality_class = match['quality'].lower()
                    row_style = 'background: #e8f5e9;' if i == 0 else ''
                    score_pct = match['score'] * 100
                    match_url = match.get('url') or '-'
                    if match_url != '-':
                        match_url = f'<a href="{match_url}">{match_url[:30]}...</a>' if len(match_url) > 30 else f'<a href="{match_url}">{match_url}</a>'
                    html += f'      <tr style="{row_style}"><td>{match["name"]}</td><td><span class="{quality_class}">{match["quality"]}</span> ({score_pct:.0f}%)</td><td>{match["code"]}</td><td>{match_url}</td></tr>\n'
                html += '    </table>\n'
            else:
                quality_class = best['quality'].lower()
                html += f'    <p>Best match: <span class="{quality_class}">{best["quality"]}</span> ({best["score"]*100:.0f}%) - {best["name"]} (ID: {best["id"]}, Code: {best["code"]})</p>\n'
                if best.get('url'):
                    html += f'    <p>OT URL: <a href="{best["url"]}">{best["url"]}</a></p>\n'
        else:
            html += '    <p class="no-match">No matches found in OT</p>\n'

        html += '  </div>\n'

    html += """
  <hr>
  <p style="font-size: 12px; color: #666;">
    Generated by OT Manufacturer Screening
  </p>
</body>
</html>
"""
    return html


def send_email(recipient: str, subject: str, html_body: str, json_attachment: str = None) -> bool:
    """Send email via SMTP."""
    if not SMTP_PASS:
        print("Error: No SMTP password configured (set WORKMAIL_PASS or SMTP_PASS)", file=sys.stderr)
        return False

    if not is_internal_email(recipient):
        print(f"Error: Cannot send to external email: {recipient}", file=sys.stderr)
        return False

    try:
        msg = MIMEMultipart()
        msg['From'] = f'"{FROM_NAME}" <{FROM_EMAIL}>'
        msg['To'] = recipient
        msg['Subject'] = subject

        msg.attach(MIMEText(html_body, 'html'))

        # Attach JSON file if provided
        if json_attachment:
            attachment = MIMEText(json_attachment, 'plain')
            attachment.add_header('Content-Disposition', 'attachment', filename='mfr-check-results.json')
            msg.attach(attachment)

        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(msg)

        return True

    except Exception as e:
        print(f"Failed to send email: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Check manufacturers against OT database and email results'
    )
    parser.add_argument('input_file', help='Text file with one manufacturer name per line')
    parser.add_argument('--to', default='bizops@orangetsunami.com',
                        help='Recipient email address')
    parser.add_argument('--cc', default='',
                        help='CC recipients from original request (for display only)')
    parser.add_argument('--requested-by', default='',
                        help='Original requester email (for display only)')
    parser.add_argument('--threshold', type=float, default=0.3,
                        help='Similarity threshold 0-1 (default: 0.3)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print JSON to stdout, do not send email')
    parser.add_argument('--output', '-o', help='Save JSON results to file')

    args = parser.parse_args()

    # Read input file
    if not os.path.exists(args.input_file):
        print(f"Error: Input file not found: {args.input_file}", file=sys.stderr)
        sys.exit(1)

    with open(args.input_file) as f:
        content = f.read()

    # Parse manufacturer requests (supports structured form or simple list)
    requests = parse_mfr_request(content)

    if not requests:
        print("Error: No manufacturer names found in input file", file=sys.stderr)
        sys.exit(1)

    print(f"Processing {len(requests)} manufacturer(s)...", file=sys.stderr)
    print(f"Threshold: {args.threshold}", file=sys.stderr)
    print("", file=sys.stderr)

    # Process manufacturers
    results = process_manufacturers(requests, args.threshold)

    # Output JSON
    json_output = json.dumps(results, indent=2)

    if args.output:
        with open(args.output, 'w') as f:
            f.write(json_output)
        print(f"\nResults saved to: {args.output}", file=sys.stderr)

    if args.dry_run:
        print("\n" + json_output)
        print("\n(Dry run - no email sent)", file=sys.stderr)
    else:
        print(f"\nSending results to {args.to}...", file=sys.stderr)

        today = datetime.now().strftime('%Y-%m-%d')
        subject = f"MFR Check Results - {len(requests)} manufacturer(s) - {today}"
        html_body = format_html_email(results, args.requested_by, args.cc)

        success = send_email(args.to, subject, html_body, json_output)

        if success:
            print(f"Email sent to {args.to}", file=sys.stderr)
        else:
            print("Failed to send email. Check SMTP configuration.", file=sys.stderr)
            # Print JSON to stdout as fallback
            print(json_output)
            sys.exit(1)


if __name__ == '__main__':
    main()
