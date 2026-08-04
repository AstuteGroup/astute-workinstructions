# CLI Update Required for MFR Writer

**analytics_user** needs to add the following to `/opt/writeback/cli.js`:

## 1. Add to SUBCOMMANDS object

Find the `SUBCOMMANDS` object and add these two entries:

```javascript
  mfr: {
    required: ['opts'],
    handler: async (payload) => {
      const { writeMfr } = require('/home/analytics_user/workspace/astute-workinstructions/shared/mfr-writer');
      return writeMfr(payload.opts);
    },
  },

  'mfr-alias': {
    required: ['opts'],
    handler: async (payload) => {
      const { updateMfrAlias } = require('/home/analytics_user/workspace/astute-workinstructions/shared/mfr-writer');
      return updateMfrAlias(payload.opts);
    },
  },
```

## 2. Test after adding

```bash
# Test mfr (create manufacturer):
echo '{"opts":{"name":"TEST_MFR_DELETE_ME","url":"https://example.com"}}' \
  | sudo -n -u analytics_user /opt/writeback/cli mfr

# Should return: {"ok":true,"result":{"mfrId":...,"code":"MFR...","name":"TEST_MFR_DELETE_ME","created":true}}

# Test mfr-alias (update description with M code):
echo '{"opts":{"mfrId":1021234,"mCode":"M99999"}}' \
  | sudo -n -u analytics_user /opt/writeback/cli mfr-alias

# Should return: {"ok":true,"result":{"mfrId":1021234,"description":"M99999","updated":true}}
```

## Files already updated

| File | Purpose |
|------|---------|
| `shared/mfr-writer.js` | Writer module: `writeMfr()` and `updateMfrAlias()` |
| `shared/writeback-proxy-client.js` | Dispatch entries for both functions |
| `shared/writeback-proxy.md` | Documentation |

## Two-Step Workflow

1. **User sends MFR request email** → `mfr-batch-check.py` runs, sends results
2. **User replies "add"** → `mfr-reply-handler.py` creates MFR, returns Search Key, asks for M code
3. **User replies with M code (e.g., "M12345")** → `mfr-reply-handler.py` updates description

## Usage

```bash
# Process MFR check requests
python3 mfr-batch-check.py input.txt

# Process replies (create MFRs, handle M codes)
python3 mfr-reply-handler.py --mailbox vq

# Watch continuously
python3 mfr-reply-handler.py --mailbox vq --watch

# Show pending M code assignments
python3 mfr-reply-handler.py --pending

# Dry run
python3 mfr-reply-handler.py --dry-run
```

## State File

Pending M code assignments are tracked in `~/.mfr-pending-mcodes.json`
