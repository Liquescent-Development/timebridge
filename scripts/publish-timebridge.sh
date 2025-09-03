#!/bin/bash

# TimeBridge Publishing Script
# Publishes all packages to @timebridge npm organization

set -e

echo "🚀 Publishing TimeBridge packages to npm..."
echo "==========================================="

# Ensure we're on a clean working directory
if [[ -n $(git status -s) ]]; then
    echo "❌ Error: Working directory is not clean. Please commit your changes first."
    exit 1
fi

# Build all packages
echo "📦 Building all packages..."
npm run clean
npm run build

# Run tests
echo "🧪 Running tests..."
npm test

# Publish packages in dependency order
echo ""
echo "📤 Publishing packages to @timebridge..."

# 1. First publish timeql-parser (no dependencies)
echo "Publishing @timebridge/timeql-parser..."
npm publish packages/query-parser --access public

# 2. Then publish core (depends on timeql-parser)
echo "Publishing @timebridge/core..."
npm publish packages/core --access public

# 3. Finally publish all adapters (depend on core)
echo "Publishing adapters..."
npm publish packages/adapters/graylog --access public
npm publish packages/adapters/loki --access public
npm publish packages/adapters/prometheus --access public
npm publish packages/adapters/influxdb --access public

echo ""
echo "✅ All packages published successfully!"
echo ""
echo "Published packages:"
echo "  - @timebridge/timeql-parser@0.0.7"
echo "  - @timebridge/core@0.0.7"
echo "  - @timebridge/graylog@0.0.7"
echo "  - @timebridge/loki@0.0.7"
echo "  - @timebridge/prometheus@0.0.7"
echo "  - @timebridge/influxdb@0.0.7"
echo ""
echo "🎉 TimeBridge is now available on npm!"
echo ""
echo "Install with:"
echo "  npm install @timebridge/core"