#!/bin/bash

# TimeBridge Dry Run Publishing Script
# Tests publishing without actually publishing to npm

set -e

echo "🧪 Dry run - Testing TimeBridge publishing..."
echo "=============================================="

# Build all packages
echo "📦 Building all packages..."
npm run clean
npm run build

# Run tests
echo "🧪 Running tests..."
npm test

# Dry run publish for each package
echo ""
echo "📤 Testing publish (dry run)..."

echo "Testing @timebridge/timeql-parser..."
npm publish packages/query-parser --access public --dry-run

echo ""
echo "Testing @timebridge/core..."
npm publish packages/core --access public --dry-run

echo ""
echo "Testing @timebridge/graylog..."
npm publish packages/adapters/graylog --access public --dry-run

echo ""
echo "Testing @timebridge/loki..."
npm publish packages/adapters/loki --access public --dry-run

echo ""
echo "Testing @timebridge/prometheus..."
npm publish packages/adapters/prometheus --access public --dry-run

echo ""
echo "Testing @timebridge/influxdb..."
npm publish packages/adapters/influxdb --access public --dry-run

echo ""
echo "✅ Dry run completed successfully!"
echo ""
echo "All packages are ready to publish. Run ./scripts/publish-timebridge.sh to publish for real."