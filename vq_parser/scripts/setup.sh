#!/bin/bash
set -e

echo "VQ Parser Setup"
echo "==============="

BASE="$(cd "$(dirname "$0")/.." && pwd)"

# Check himalaya
if command -v himalaya &> /dev/null; then
    echo "✓ himalaya installed: $(himalaya --version 2>&1 | head -1)"
else
    echo "✗ himalaya not found. Install from https://github.com/pimalaya/himalaya/releases"
    exit 1
fi

# Check node
if command -v node &> /dev/null; then
    echo "✓ node installed: $(node --version)"
else
    echo "✗ node not found"
    exit 1
fi

# Install deps
echo "Installing dependencies..."
cd "$BASE" && npm install --production

# Create directories
mkdir -p "$BASE/output" "$BASE/data"

# Initialize data files if needed
[ -f "$BASE/data/processed-ids.json" ] || echo '{"processedIds":{},"lastRun":null}' > "$BASE/data/processed-ids.json"
[ -f "$BASE/data/vendor-cache.json" ] || echo '{}' > "$BASE/data/vendor-cache.json"
[ -f "$BASE/data/mfr-cache.json" ] || echo '{}' > "$BASE/data/mfr-cache.json"

# Test connection
echo ""
echo "Testing IMAP connection..."
cd "$BASE" && node src/index.js test-connection

echo ""
echo "Setup complete! Usage:"
echo "  node src/index.js fetch --dry-run --verbose   # Test parsing"
echo "  node src/index.js fetch --limit 5             # Process 5 emails"
echo "  node src/index.js status                      # Check stats"
