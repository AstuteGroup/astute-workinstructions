# AI-Assisted RFQ & VQ Loading — User Guide

**For: Buyers, Sales, and Support Staff**

This guide explains how to use the AI-assisted tools to load RFQs (customer requests) and VQs (vendor quotes) into Orange Tsunami without manual data entry.

---

## How It Works

Claude (the AI assistant) monitors two email inboxes 24/7:

| Inbox | Purpose | What to Forward |
|-------|---------|-----------------|
| `rfqloading@orangetsunami.com` | Customer RFQs | Customer emails requesting quotes on parts |
| `vq@orangetsunami.com` | Vendor Quotes | Broker/supplier emails with pricing |

When you forward an email to these inboxes, Claude:
1. Extracts the part numbers, quantities, prices, and other details
2. Matches customers/vendors to the database
3. Writes the data directly to OT
4. Emails you a confirmation (or asks for clarification if needed)

---

## Loading Customer RFQs

### Step 1: Forward the Customer Email

Forward the customer's RFQ email to: **`rfqloading@orangetsunami.com`**

**What to include:**
- The original customer email with part numbers and quantities
- If the customer sent an attachment (Excel, PDF), include it

**Optional — Add a note** at the top of your forward if helpful:
```
RFQ Type: Shortage
Customer: Celestica
```

### Step 2: Wait for Confirmation

Within 5-30 minutes, you'll receive one of:

| Response | What It Means | Your Action |
|----------|---------------|-------------|
| **RFQ Loaded** | Success — RFQ is in OT | None — start sourcing |
| **Need Info** | Missing required details | Reply with the missing info |
| **Needs Review** | Claude couldn't process it | Check OT or reply with guidance |

### What Claude Extracts

| Field | Source |
|-------|--------|
| Customer | Email domain / signature |
| Contact | Sender email |
| RFQ Type | Your note, or Claude asks |
| Part Numbers | Email body / attachments |
| Quantities | Email body / attachments |
| Target Price | If customer provided one |

---

## Loading Vendor Quotes (VQs)

### Step 1: Forward the Vendor's Quote

Forward the vendor/broker quote email to: **`vq@orangetsunami.com`**

**What to include:**
- The broker's email with pricing
- Keep the full email chain (helps Claude identify the RFQ)

### Step 2: Wait for Confirmation

Within 5-30 minutes, you'll receive:

| Response | What It Means | Your Action |
|----------|---------------|-------------|
| **VQ Loaded** | Success — quotes in OT | None — review in OT |
| **Clarify Vendor** | Vendor not in database | Reply with vendor name or "create new" |
| **Needs RFQ** | Can't match to an RFQ | Reply with RFQ number |
| **Needs Review** | Claude couldn't process it | Reply with guidance |

### What Claude Extracts

| Field | Source |
|-------|--------|
| Vendor | Email domain lookup |
| RFQ | MPN matching to recent RFQs |
| MPN | Quote body |
| Quantity | Quote body |
| Unit Cost | Quote body |
| Lead Time | Quote body (default: stock) |
| Date Code | Quote body |
| Packaging | Quote body |

---

## Tips for Best Results

### Do This

- **Forward the original email** — don't copy/paste into a new email
- **Include attachments** — Claude can read Excel and PDF files
- **Keep the email chain** — context helps match RFQs
- **Reply promptly** to clarification requests — the quote is waiting

### Avoid This

- Don't split one RFQ across multiple emails
- Don't forward the same email twice (duplicates are detected but waste time)
- Don't delete vendor emails before forwarding — forward first, then organize

---

## Responding to Clarification Requests

When Claude emails you asking for information, reply directly to that email.

### Example: RFQ Type Missing

```
From: rfqloading@orangetsunami.com
Subject: [Need Info] RFQ from Celestica — missing RFQ type

Hi Jake,

I'm processing this RFQ but need a few details:
- RFQ Type: Is this a Shortage, PPV, EOL/LTB, or other?

Thanks,
Claude
```

**Your reply:**
```
Shortage
```

That's it — one word is enough. Claude will process the RFQ with that type.

### Example: Vendor Not Found

```
From: vq@orangetsunami.com
Subject: [Clarify Vendor] Quote from sales@newbroker.com

I couldn't match this vendor to the database.

Vendor email: sales@newbroker.com
Company mentioned: New Broker Electronics

Options:
1. Reply with the correct vendor name if it exists under a different name
2. Reply "create new" and I'll flag it for vendor setup
```

**Your reply:**
```
This is "New Broker Electronics Ltd" - search key 1005234
```

or

```
create new
```

---

## Bulk Sourcing Summaries (APAC Team)

If you're compiling quotes from multiple brokers into a single email (common for APAC sourcing), forward the summary email to `vq@orangetsunami.com`.

**Format that works well:**
```
RFQ 1132456

Broker: Poplar Technology
MT47H128M16RT-25E:C  1000pcs  $14.00  DC: 25+  3 days

Broker: XJH Electronics
MT47H128M16RT-25E:C  2000pcs  $13.50  DC: 24+  stock
```

Claude will:
- Parse each broker section
- Match vendors by name
- Load all quotes to the specified RFQ

---

## Checking Results in OT

After Claude confirms your data was loaded, here's how to verify it in Orange Tsunami.

### Finding Your RFQ

1. **From the confirmation email:** The email includes the RFQ number (e.g., "RFQ 1134567 loaded")
2. **In OT:** Go to **Trading > RFQ** and search by:
   - RFQ number from the email
   - Customer name
   - Your name (as salesperson)
   - Date created (today)

### What to Check on the RFQ

| Field | Where to Look | What to Verify |
|-------|---------------|----------------|
| Customer | RFQ header | Correct business partner |
| Contact | RFQ header | Customer contact person |
| RFQ Type | RFQ header | Shortage, PPV, EOL, etc. |
| Line count | RFQ Lines tab | All parts loaded |
| MPNs | RFQ Lines > MPN subtab | Part numbers correct |
| Quantities | RFQ Lines tab | Quantities match request |
| Target prices | RFQ Lines tab | If customer provided any |

### Finding Your VQs

1. **From the confirmation email:** Shows RFQ number and vendor count
2. **In OT:** Open the RFQ, then go to **VQ Lines** tab
3. **Filter by:** Vendor name, or sort by Created date (newest first)

### What to Check on VQs

| Field | What to Verify |
|-------|----------------|
| Vendor | Correct broker/supplier |
| MPN | Matches the RFQ line |
| Quantity | What vendor quoted |
| Cost | Unit price (check currency if non-USD) |
| Lead Time | Stock vs. lead time |
| Date Code | If vendor provided |

### Quick Verification Checklist

After loading, spot-check:

- [ ] Line count matches what you forwarded
- [ ] A few MPNs look correct (especially unusual ones)
- [ ] Prices are in the right ballpark
- [ ] Vendor names resolved correctly

**If something looks wrong:**
1. Don't edit the VQ/RFQ yet
2. Email justin.oberhofer@astutegroup.com with the RFQ number and what's wrong
3. We'll investigate and fix the extraction logic if needed

---

## Common Questions

### Q: How long does processing take?
Processing happens every 5-30 minutes depending on the workflow. You'll get an email confirmation when it's done.

### Q: What if I forward the wrong email?
No problem — Claude will either:
- Recognize it's not an RFQ/quote and skip it
- Ask you for clarification
- You can reply "ignore" to any clarification request

### Q: Can I forward multiple RFQs at once?
Yes, forward each customer email separately. Don't combine multiple customers in one forward.

### Q: What if the attachment is a PDF?
Claude can read PDFs. Just forward the email with the attachment.

### Q: Who sees my forwarded emails?
Only Claude (the system) and operators (Jake, Justin) see the inbox. Your forwarded emails are processed and moved to archive folders.

---

## Need Help?

- **Something stuck?** Email jake.harris@astutegroup.com
- **Bug or issue?** Email justin.oberhofer@astutegroup.com
- **Training?** Ask your manager to schedule a walkthrough

---

*Last updated: 2026-07-23*
