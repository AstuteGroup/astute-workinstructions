# Vendor Template Candidates

**Last updated:** 2026-03-05
**Cumulative data** - updated each session, counts are ongoing totals (not per-session)

To refresh counts:
```bash
cut -d',' -f7 vq-upload-ready-tracking.csv | tail -n +2 | sort | uniq -c | sort -rn | head -20
```

## Existing Templates

| Template | Vendor | File |
|----------|--------|------|
| velocity | Velocity Electronics | `vq-parser/templates/velocity.js` |
| chip1 | Chip 1 Stop | `vq-parser/templates/chip1.js` |
| j2-sourcing | J2 Sourcing | `vq-parser/templates/j2-sourcing.js` |
| semitech | Semitech Semiconductor | `vq-parser/templates/semitech.js` |
| akira-global | Akira Global | `vq-parser/templates/akira-global.js` |

---

## High Priority (5+ quotes, no template)

| Vendor | Quote Count | Notes |
|--------|-------------|-------|
| Prism Electronics | 15 | Top volume - priority candidate |
| ComS.I.T. Inc. | 12 | High volume |
| Cyclops Electronics | 7 | |
| Atlantic Semiconductor | 6 | |
| Elcom Components Inc. | 5 | |

---

## Medium Priority (3-4 quotes)

| Vendor | Quote Count |
|--------|-------------|
| Rebound EU | 4 |
| Ozdisan | 4 |
| Micros sp.j. | 4 |
| INELCO | 4 |
| IC TRONIX INC | 4 |
| Fly Chips Electronics | 4 |
| ECOMAL UK Ltd. | 4 |
| J2 Sourcing | 3 | *Has template* |
| Solid Technology Solutions Inc. | 3 |
| SVT | 3 |
| PC Components Company | 3 |
| Inelco Components | 3 |
| Flip Electronics | 3 |
| Flex-Com International | 3 |
| DERF ELECTRONICS CORP | 3 |
| Component Electronics Inc. | 3 |
| Braun EC | 3 |

---

## Low Priority (2 quotes)

| Vendor | Quote Count |
|--------|-------------|
| ZD Integrated Circuits | 2 |
| Voyager Components | 2 |
| Semi Source Inc. | 2 |
| Seba Components | 2 |
| Rotakorn Electronics AB | 2 |
| Q Components | 2 |
| NuSource Tech | 2 |
| KC Electronics | 2 |
| Inventory Management Partners | 2 |
| Integrated Electronics | 2 |
| Husky International Electronics | 2 |
| EMS Net Online | 2 |
| Crestwood Technology Group | 2 |
| Converge | 2 |
| Celestica Global Limited | 2 |
| Carlin Systems Inc | 2 |
| CVC Components Ltd | 2 |
| CHANETECH | 2 |
| Area51 Electronics | 2 |
| Accord Technologies | 2 |

---

## Action Items

- [ ] Review Prism Electronics email format for template development
- [ ] Review ComS.I.T. Inc. email format for template development
- [ ] Consider consolidating duplicate vendor names (e.g., "Fly Chips" vs "FlyChips" vs "Fly Chips Electronics")
