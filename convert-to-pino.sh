#!/bin/bash

# Script to convert console.log statements to pino logger calls
# This handles the most common patterns in the Graylog adapter

FILE="/workspace/packages/adapters/graylog/src/graylog-adapter.ts"
TEMP="/tmp/graylog-adapter-temp.ts"

# Copy the file
cp "$FILE" "$TEMP"

# Replace console.log/warn/error with appropriate logger calls
# Using perl for more complex replacements

perl -i -pe '
  # Simple console.log statements for Graylog v6
  s/console\.log\(`\[Graylog v6\] ([^`]+)`\);/apiLogger.debug("$1");/g;
  s/console\.log\(\`\[Graylog v6\] ([^`]+): \$\{([^}]+)\}\`\);/apiLogger.debug({ $2 }, "$1");/g;
  
  # CSV Streaming logs
  s/console\.log\(`\[CSV Streaming\] ([^`]+)`\);/csvLogger.debug("$1");/g;
  s/console\.log\(\`\[CSV Parser\] ([^`]+)`\);/csvLogger.trace("$1");/g;
  
  # General Graylog logs
  s/console\.log\(`\[Graylog\] ([^`]+)`\);/logger.debug("$1");/g;
  s/console\.log\(\`\[Graylog\] ([^`]+): \$\{([^}]+)\}\`\);/logger.debug({ $2 }, "$1");/g;
  
  # Warnings
  s/console\.warn\(`\[Graylog v6\] ([^`]+)`\);/apiLogger.warn("$1");/g;
  s/console\.warn\(`\[Graylog\] ([^`]+)`\);/logger.warn("$1");/g;
  s/console\.warn\(\`\[CSV Streaming\] ([^`]+)`\);/csvLogger.warn("$1");/g;
  
  # Errors
  s/console\.error\(`\[Graylog v6\] ([^`]+)`\);/apiLogger.error("$1");/g;
  s/console\.error\(`\[Graylog\] ([^`]+)`\);/logger.error("$1");/g;
  s/console\.error\(\`\[CSV Streaming\] ([^`]+)`\);/csvLogger.error("$1");/g;
  
  # SmartGunzip logs
  s/console\.log\(`\[SmartGunzip\] ([^`]+)`\);/streamLogger.trace("$1");/g;
' "$TEMP"

# Count remaining console statements
echo "Remaining console statements:"
grep -c "console\." "$TEMP" || echo "0"

# Show diff
echo ""
echo "Sample changes (first 50 lines of diff):"
diff -u "$FILE" "$TEMP" | head -50

echo ""
echo "Apply changes? (y/n)"
read -r response
if [[ "$response" == "y" ]]; then
  mv "$TEMP" "$FILE"
  echo "Changes applied!"
else
  rm "$TEMP"
  echo "Changes discarded."
fi