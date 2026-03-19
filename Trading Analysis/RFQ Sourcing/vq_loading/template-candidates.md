# Template Candidates

Track high-volume vendors for template development. **Cumulative counts** across manual extraction sessions only.

**Note:** Historical data from rigid parser sessions (pre-Mar 10) excluded due to bad vendor assignments.

**When a template is created:** Remove vendor from this list and add to Existing Templates.

## When to Create a Template

- **5+ cumulative quotes** → Mark as PRIORITY, assess templateability
- **Structured format** → Create template, remove from candidates
- **Free-form** → Mark as `FREE-FORM`, keep on manual extraction

## Templateability Assessment

Pull 3-5 sample emails from vendor and check:

| Format Type | Templateable? | Characteristics |
|-------------|---------------|-----------------|
| **Structured** | YES | Tables, consistent columns, delimiters, repeating patterns |
| **Semi-structured** | MAYBE | Consistent sections but variable content, may need flexible regex |
| **Free-form** | NO | Prose responses, varying layouts, no consistent structure |

**Mark in the Format column:**
- `STRUCTURED` → prioritize for template
- `FREE-FORM` → manual extraction only
- `?` → not yet assessed

## Existing Templates

| Template | Vendor | Search Key | Domain | Added |
|----------|--------|------------|--------|-------|
| velocity.js | Velocity Electronics | 1001036 | velocityelec.com | - |
| chip1.js | Chip 1 Stop | - | chip1.com | - |
| j2-sourcing.js | J2 Sourcing | 1002946 | j2sourcing.com | - |
| semitech.js | Semitech Semiconductor | 1006806 | semitech.net | - |
| akira-global.js | Akira Global | 1007942 | akiraglobal.com | - |
| atlantic-semi.js | Atlantic Semiconductor | 1002457 | atlanticsemi.com | Mar 11 |

## Cumulative Vendor Counts

**Last updated:** 2026-03-13

| Search Key | Vendor | Cumulative | Format | Priority | Sessions |
|------------|--------|------------|--------|----------|----------|
| 1002948 | Inelco Components | 4 | ? | - | Mar 10 (2), Mar 11 (2) |
| 1002787 | Hybrid Electronics | 4 | ? | - | Mar 10 (2), Mar 11 (2) |
| 1002612 | Integrated Electronics | 4 | ? | - | Mar 10 (2), Mar 11 (2) |
| 1002842 | Nexus Electronics | 4 | ? | - | Mar 10 (2), Mar 11 (2) |
| 1002337 | Select Technology | 4 | ? | - | Mar 10 (2), Mar 11 (2) |
| 1004879 | N-tronics GmbH | 4 | ? | - | Mar 10 (2), Mar 11 (2) |
| 1003141 | Component Sense | 3 | ? | - | Mar 11 (2), Mar 13 (1) |
| 1002491 | ComSIT | 2 | STRUCTURED | - | Mar 13 (2 PDF) |
| 1002428 | Concord Components | 2 | ? | - | Mar 13 (2) |
| 1003290 | NetSource Technology | 2 | ? | - | Mar 10 (2) |
| 1005735 | Fly Chips | 2 | ? | - | Mar 11 (2) |
| 1002863 | Flex-Com International | 2 | ? | - | Mar 11 (2) |
| 1004515 | Schukat | 1 | STRUCTURED | - | Mar 13 (1 PDF) |
| 1003327 | AED Electronics | 1 | STRUCTURED | - | Mar 13 (1 PDF) |
| 1005739 | Solsta | 1 | STRUCTURED | - | Mar 13 (1 PDF) |
| 1003320 | Charcroft | 1 | STRUCTURED | - | Mar 13 (1 PDF) |
| 1002495 | Cyclops/Lantek | 1 | STRUCTURED | - | Mar 13 (1 PDF) |
| 1003723 | 4Source | 1 | STRUCTURED | - | Mar 13 (1 PDF) |
| 1006201 | IBH Elektrotechnik | 1 | STRUCTURED | - | Mar 13 (1 PDF) |

## PDF Extraction Notes (Mar 13)

Discovered that Claude's **Read tool** can natively extract data from PDF attachments without external libraries. This enables direct processing of PDF quotes in NeedsReview folder.

**Structured PDF vendors** (good template candidates when volume increases):
- Schukat: German distributor, consistent table format
- ComSIT: EMEA broker, standardized quote layout
- Charcroft: UK distributor, clean tabular quotes
- 4Source: German broker, price break tables
- IBH Elektrotechnik: German supplier, formal quote structure

## How to Update (Step 7)

After each VQ loading session:

1. Count vendors from session upload CSV:
   ```bash
   cut -d',' -f3 [session]-upload.csv | tail -n +2 | sort | uniq -c | sort -rn
   ```

2. Add session counts to existing vendors OR add new rows

3. Update cumulative totals and mark 5+ as **PRIORITY**

4. When template created: move vendor to Existing Templates table
