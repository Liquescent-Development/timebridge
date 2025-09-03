#!/usr/bin/env node

/**
 * Simplified Graylog query script that automatically handles direct vs correlation queries
 *
 * This demonstrates the proposed architecture where:
 * 1. The library automatically detects query type from syntax
 * 2. Direct queries work without needing a correlation engine
 * 3. Multiple data sources can be registered and used by name
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TimeQLExecutor } = require("@timebridge/core");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GraylogAdapter } = require("../dist/graylog-adapter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("dotenv").config({ path: "../.env" });

async function main() {
  // Create query executor with default settings
  const executor = new TimeQLExecutor({
    timeWindow: 30000,
    maxEvents: 10000,
  });

  // Configure Graylog adapter from environment
  const graylogConfig = {
    url: process.env.GRAYLOG_URL,
    apiVersion: process.env.GRAYLOG_API_VERSION || "v6",
    pollInterval: parseInt(process.env.GRAYLOG_POLL_INTERVAL) || 2000,
  };

  // Add authentication
  if (process.env.GRAYLOG_API_TOKEN) {
    graylogConfig.apiToken = process.env.GRAYLOG_API_TOKEN;
  } else {
    graylogConfig.username = process.env.GRAYLOG_USERNAME;
    graylogConfig.password = process.env.GRAYLOG_PASSWORD;
  }

  // Add stream filtering
  if (process.env.GRAYLOG_STREAM_NAME) {
    graylogConfig.streamName = process.env.GRAYLOG_STREAM_NAME;
  }

  // Add proxy if configured
  if (process.env.SOCKS_PROXY_HOST) {
    graylogConfig.proxy = {
      host: process.env.SOCKS_PROXY_HOST,
      port: parseInt(process.env.SOCKS_PROXY_PORT) || 1080,
      type: parseInt(process.env.SOCKS_PROXY_TYPE) || 5,
      username: process.env.SOCKS_PROXY_USERNAME,
      password: process.env.SOCKS_PROXY_PASSWORD,
    };
  }

  // Register the adapter
  // You can register multiple with different names if needed
  executor.addAdapter("graylog", new GraylogAdapter(graylogConfig));

  // Optional: Register additional instances
  if (process.env.GRAYLOG_STAGING_URL) {
    executor.addAdapter(
      "graylog-staging",
      new GraylogAdapter({
        url: process.env.GRAYLOG_STAGING_URL,
        // ... other staging config
      })
    );
  }

  // Get query from environment or command line
  const query =
    process.argv[2] || process.env.GRAYLOG_QUERY || "graylog(*)[5m]";
  const timeRange = process.env.GRAYLOG_TIME_RANGE || "5m";

  // Build the full query if it's not already formatted
  let fullQuery = query;
  if (!query.includes("[") && !query.includes("graylog(")) {
    // Auto-format as a direct query
    fullQuery = `graylog(${query})[${timeRange}]`;
  }

  console.log("🚀 Executing Query\n");

  // Validate the query
  const validation = executor.validateQuery(fullQuery);
  if (!validation.valid) {
    console.error(`❌ Invalid query: ${validation.error}`);
    process.exit(1);
  }

  console.log(`📊 Query Type: ${validation.type}`);
  console.log(`🔍 Query: ${fullQuery}`);
  console.log(`🔗 Data Sources: ${validation.sources?.join(", ")}\n`);

  try {
    let resultCount = 0;
    const maxResults = parseInt(process.env.MAX_RESULTS) || 100;
    const startTime = Date.now();

    // Execute the query - it automatically handles direct vs correlation
    for await (const result of executor.execute(fullQuery)) {
      resultCount++;

      if (validation.type === "direct") {
        // Direct query returns individual log events
        console.log(`📝 Event ${resultCount}:`);
        console.log(`   Time: ${new Date(result.timestamp).toISOString()}`);
        console.log(`   Message: ${result.message?.substring(0, 100)}...`);

        // Show relevant fields
        if (result.fields?.request_id) {
          console.log(`   Request ID: ${result.fields.request_id}`);
        }
        if (result.fields?.level) {
          console.log(`   Level: ${result.fields.level}`);
        }
      } else {
        // Correlation query returns correlated event groups
        console.log(`🔗 Correlation ${resultCount}:`);
        console.log(`   Events: ${result.events.length}`);
        console.log(`   Join Keys: ${JSON.stringify(result.joinKeys)}`);

        // Show first few events in the correlation
        result.events.slice(0, 3).forEach((event, i) => {
          console.log(
            `   Event ${i + 1}: ${event.timestamp} - ${event.message?.substring(
              0,
              50
            )}...`
          );
        });
      }

      console.log("");

      if (resultCount >= maxResults) {
        console.log(`⚠️ Reached maximum result limit (${maxResults})`);
        break;
      }
    }

    const elapsed = Date.now() - startTime;

    console.log("📊 Summary:");
    console.log(`   Total Results: ${resultCount}`);
    console.log(`   Query Time: ${elapsed}ms`);
    console.log(
      `   Average: ${
        resultCount > 0 ? (elapsed / resultCount).toFixed(2) : 0
      }ms per result`
    );
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (process.env.DEBUG) {
      console.error("Stack trace:", error);
    }
    process.exit(1);
  }
}

// Show usage if --help is passed
if (process.argv.includes("--help")) {
  console.log(`
Usage: node simplified-query.js [query]

The query can be:
  1. A direct query: graylog(level:error)[5m]
  2. A correlation query: graylog(service:frontend)[5m] and on(request_id) graylog(service:backend)[5m]
  3. Just the search part: level:error (will be auto-wrapped as graylog(level:error)[timerange])

Environment Variables:
  GRAYLOG_URL           - Graylog server URL
  GRAYLOG_USERNAME      - Username for basic auth
  GRAYLOG_PASSWORD      - Password for basic auth
  GRAYLOG_API_TOKEN     - API token (alternative to username/password)
  GRAYLOG_API_VERSION   - API version (legacy or v6, default: v6)
  GRAYLOG_STREAM_NAME   - Stream name to filter
  GRAYLOG_TIME_RANGE    - Default time range (default: 5m)
  GRAYLOG_QUERY         - Default query if none provided
  MAX_RESULTS           - Maximum results to display (default: 100)
  DEBUG                 - Show debug information

Proxy Configuration:
  SOCKS_PROXY_HOST      - SOCKS proxy hostname
  SOCKS_PROXY_PORT      - SOCKS proxy port
  SOCKS_PROXY_TYPE      - 4 or 5 (default: 5)
  SOCKS_PROXY_USERNAME  - Proxy username
  SOCKS_PROXY_PASSWORD  - Proxy password

Examples:
  # Direct query
  node simplified-query.js 'graylog(level:error)[5m]'
  
  # Auto-formatted direct query
  node simplified-query.js 'level:error'
  
  # Correlation query
  node simplified-query.js 'graylog(service:api)[5m] and on(request_id) graylog(service:db)[5m]'
  
  # Using environment variables
  GRAYLOG_QUERY="level:error" GRAYLOG_TIME_RANGE="1h" node simplified-query.js
`);
  process.exit(0);
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
