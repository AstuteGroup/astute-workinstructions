# TSK: New MFR Screening

Automated manufacturer verification and creation workflow for Orange Tsunami. Scrapes incoming MFR requests from bizops inbox, verifies against OT database and website, emails results for approval, and creates manufacturers on reply.

## Workflow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  bizops inbox   │────▶│  Parse MFR      │────▶│  Fuzzy Match    │────▶│  Website Check  │
│  (MFR requests) │     │  name + URL     │     │  (OT database)  │     │  (Playwright)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
                                                                                │
                                                                                ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  MFR Created    │◀────│  Reply Handler  │◀────│  Reviewer       │◀────│  Email Results  │
│  in OT          │     │  (add/skip)     │     │  (justin)       │     │  to reviewer    │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌─────────────────┐
                        │  M Code Email   │
                        │  (reply M12345) │
                        └─────────────────┘
```

## Quick Start

```bash
# Scrape bizops for new MFR requests (one-time)
python3 mfr-reply-handler.py --requests --mailbox bizops

# Watch continuously (every 60s)
python3 mfr-reply-handler.py --requests --mailbox bizops --watch

# Process add/skip replies
python3 mfr-reply-handler.py --mailbox bizops
```

## Email Format

**Incoming request to bizops:**
```
Subject: New MFR Request

MFR Name: DMG Spa
Website URL: https://www.dmgspa.com
Alias: DMG, DMG S.p.A.
```

**Results email to reviewer:**
- MFR name with provided URL
- Website Check: MANUFACTURER / DISTRIBUTOR / UNKNOWN (with confidence)
- OT fuzzy match results (EXACT / HIGH / MEDIUM / LOW / NO MATCH)
- Recommended action: EXISTS / REVIEW / ADD

**Reviewer replies:**
- `add` - Create manufacturer in OT
- `skip` - Do not create

**After creation, M code email:**
- Reviewer replies with `M12345` to assign M code
- Or `skip` to leave without M code

## Components

### mfr-reply-handler.py

Main workflow script. Two modes:

**Request mode (`--requests`):** Scrapes bizops for new MFR requests
```bash
python3 mfr-reply-handler.py --requests --mailbox bizops --dry-run
python3 mfr-reply-handler.py --requests --mailbox bizops --reviewer someone@astutegroup.com
```

**Reply mode (default):** Processes add/skip replies
```bash
python3 mfr-reply-handler.py --mailbox bizops --dry-run
python3 mfr-reply-handler.py --mailbox bizops
```

**Other commands:**
```bash
python3 mfr-reply-handler.py --pending           # Show pending M code assignments
python3 mfr-reply-handler.py --clear-processed   # Reset deduplication
```

### mfr-batch-check.py

Standalone batch checker (called by reply handler, or run manually):
```bash
python3 mfr-batch-check.py input.txt --to reviewer@example.com
python3 mfr-batch-check.py input.txt --dry-run
python3 mfr-batch-check.py input.txt --threshold 0.5
```

**Features:**
- Fuzzy matching against OT manufacturer database
- Website verification via Playwright (MANUFACTURER / DISTRIBUTOR)
- Clean HTML email with results

### mfr-fuzzy-check.js

Website verification module (called by batch check):
```bash
node mfr-fuzzy-check.js "Company Name" --url https://company.com
```

## Configuration

**Environment variables (`~/workspace/.env`):**
```
WORKMAIL_PASS=<app password for bizops@orangetsunami.com>
SMTP_HOST=smtp.mail.us-east-1.awsapps.com
SMTP_PORT=465
IMAP_HOST=imap.mail.us-east-1.awsapps.com
IMAP_PORT=993
```

**Defaults:**
- Inbox: `bizops@orangetsunami.com`
- Reviewer: `justin.oberhofer@astutegroup.com`
- Similarity threshold: 0.3

## Match Quality Levels

| Quality | Score | Action |
|---------|-------|--------|
| EXACT | 100% | EXISTS - Already in OT |
| HIGH | 80-99% | REVIEW - Likely duplicate |
| MEDIUM | 50-79% | REVIEW - Possible match |
| LOW | 30-49% | ADD - Weak match |
| NO MATCH | <30% | ADD - New manufacturer |

## State Files

- `~/.mfr-pending-mcodes.json` - Pending M code assignments and processed message IDs

## Dependencies

- Python 3.11+
- Node.js 22+ (for Playwright website checks)
- psql (for OT database queries)
- Playwright with Chromium
- Access to `/opt/writeback/cli` (runs as analytics_user via sudo)

## CLI Commands Required

**Status: PENDING** - analytics_user must add these to `/opt/writeback/cli.js`:

- `mfr` - Create new manufacturer
- `mfr-alias` - Update manufacturer description (for M code)

See `CLI_UPDATE_REQUIRED.md` for implementation details.
