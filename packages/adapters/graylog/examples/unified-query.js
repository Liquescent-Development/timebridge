#!/usr/bin/env node

/**
 * Unified Query Example
 *
 * Demonstrates the new unified query interface that:
 * 1. Automatically detects query type (direct vs correlation)
 * 2. Supports multiple named adapters (graylog-prod, graylog-staging, etc.)
 * 3. Handles both simple queries and complex correlations
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TimeQLExecutor } = require("@timebridge/core");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GraylogAdapter } = require("../dist/graylog-adapter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("dotenv").config({ path: "../.env" });

// Helper to format timestamps
function formatTime(timestamp) {
  return new Date(timestamp).toISOString().replace("T", " ").substring(0, 19);
}

// Helper to truncate long messages
function truncate(str, maxLength = 80) {
  if (!str) return "";
  return str.length > maxLength ? str.substring(0, maxLength) + "..." : str;
}

async function main() {
  console.log("🚀 Unified Query Interface Demo\n");
  console.log(
    "This demo shows how the library automatically handles different query types.\n"
  );

  // Create the query executor
  const executor = new TimeQLExecutor({
    timeWindow: 30000, // 30 second correlation window
    maxEvents: 10000,
  });

  // Configure base Graylog settings from environment
  const baseConfig = {
    apiVersion: process.env.GRAYLOG_API_VERSION || "v6",
    pollInterval: 2000,
    timeout: 15000,
  };

  // Add authentication
  if (process.env.GRAYLOG_API_TOKEN) {
    baseConfig.apiToken = process.env.GRAYLOG_API_TOKEN;
  } else if (process.env.GRAYLOG_USERNAME) {
    baseConfig.username = process.env.GRAYLOG_USERNAME;
    baseConfig.password = process.env.GRAYLOG_PASSWORD;
  }

  // Add proxy if configured
  if (process.env.SOCKS_PROXY_HOST) {
    baseConfig.proxy = {
      host: process.env.SOCKS_PROXY_HOST,
      port: parseInt(process.env.SOCKS_PROXY_PORT) || 1080,
      type: parseInt(process.env.SOCKS_PROXY_TYPE) || 5,
      username: process.env.SOCKS_PROXY_USERNAME,
      password: process.env.SOCKS_PROXY_PASSWORD,
    };
  }

  // Register multiple Graylog adapters
  // This is the default adapter for 'graylog' queries
  if (process.env.GRAYLOG_URL) {
    console.log("📊 Registering adapters:");

    executor.addAdapter(
      "graylog",
      new GraylogAdapter({
        ...baseConfig,
        url: process.env.GRAYLOG_URL,
        streamName: process.env.GRAYLOG_STREAM_NAME,
      }),
      { isDefault: true }
    );
    console.log(`  ✅ graylog (default) -> ${process.env.GRAYLOG_URL}`);
  }

  // Register additional named instances if configured
  if (process.env.GRAYLOG_PROD_URL) {
    executor.addAdapter(
      "graylog-prod",
      new GraylogAdapter({
        ...baseConfig,
        url: process.env.GRAYLOG_PROD_URL,
        streamName: process.env.GRAYLOG_PROD_STREAM,
      })
    );
    console.log(`  ✅ graylog-prod -> ${process.env.GRAYLOG_PROD_URL}`);
  }

  if (process.env.GRAYLOG_STAGING_URL) {
    executor.addAdapter(
      "graylog-staging",
      new GraylogAdapter({
        ...baseConfig,
        url: process.env.GRAYLOG_STAGING_URL,
        streamName: process.env.GRAYLOG_STAGING_STREAM,
      })
    );
    console.log(`  ✅ graylog-staging -> ${process.env.GRAYLOG_STAGING_URL}`);
  }

  console.log("");

  // Example queries to demonstrate different capabilities
  const demoQueries = [
    {
      name: "Direct Query (Auto-detected)",
      query: "graylog(level:error)[5m]",
      description: "Simple direct query to default Graylog instance",
    },
    {
      name: "Named Instance Query",
      query: "graylog-prod(level:warn AND service:api)[10m]",
      description: "Query specific Graylog instance by name",
      skip: !process.env.GRAYLOG_PROD_URL,
    },
    {
      name: "Correlation Query (Auto-detected)",
      query: `
        graylog(level:error)[5m] 
        and on(request_id) 
        graylog(level:info)[5m]
      `,
      description: "Correlate errors with related info logs",
    },
    {
      name: "Cross-Instance Correlation",
      query: `
        graylog-prod(service:api)[10m]
        and on(request_id)
        graylog-staging(service:api)[10m]
      `,
      description: "Correlate logs across production and staging",
      skip: !process.env.GRAYLOG_PROD_URL || !process.env.GRAYLOG_STAGING_URL,
    },
  ];

  // Get query from command line or use demo queries
  const userQuery = process.argv[2];

  if (userQuery) {
    // User provided a query
    await executeQuery(executor, userQuery, "User Query");
  } else {
    // Run demo queries
    for (const demo of demoQueries) {
      if (demo.skip) continue;

      console.log("─".repeat(80));
      console.log(`\n🔍 ${demo.name}`);
      console.log(`📝 ${demo.description}`);
      await executeQuery(executor, demo.query, demo.name);
    }
  }
}

async function executeQuery(executor, query, _name) {
  // Clean up the query
  query = query.trim().replace(/\s+/g, " ");

  // Validate the query
  const validation = executor.validateQuery(query);

  if (!validation.valid) {
    console.log(`❌ Invalid query: ${validation.error}`);
    return;
  }

  console.log(`\n📊 Query Details:`);
  console.log(`  Type: ${validation.type}`);
  console.log(`  Sources: ${validation.sources?.join(", ")}`);
  console.log(`  Query: ${truncate(query, 100)}`);
  console.log("");

  try {
    const startTime = Date.now();
    let resultCount = 0;
    const maxResults = 10; // Limit for demo

    console.log("📡 Executing query...\n");

    for await (const result of executor.execute(query)) {
      resultCount++;

      if (validation.type === "direct") {
        // Direct query returns LogEvent
        console.log(`Event ${resultCount}:`);
        console.log(`  Time: ${formatTime(result.timestamp)}`);
        console.log(`  Message: ${truncate(result.message)}`);

        // Show some fields if available
        if (result.fields) {
          const fields = Object.entries(result.fields)
            .slice(0, 3)
            .map(([k, v]) => `${k}=${truncate(String(v), 20)}`)
            .join(", ");
          if (fields) console.log(`  Fields: ${fields}`);
        }

        // Show join keys if present
        if (result.joinKeys && Object.keys(result.joinKeys).length > 0) {
          console.log(`  Join Keys: ${JSON.stringify(result.joinKeys)}`);
        }
      } else {
        // Correlation query returns CorrelatedEvent
        console.log(`Correlation ${resultCount}:`);
        console.log(`  Correlated Events: ${result.events.length}`);
        console.log(`  Join Key: ${result.joinKey} = ${result.joinValue}`);
        console.log(
          `  Time Window: ${formatTime(
            result.timeWindow.start
          )} to ${formatTime(result.timeWindow.end)}`
        );

        // Show first few events
        result.events.slice(0, 3).forEach((event, i) => {
          console.log(
            `  Event ${i + 1}: ${formatTime(event.timestamp)} - ${truncate(
              event.message,
              60
            )}`
          );
        });

        if (result.events.length > 3) {
          console.log(`  ... and ${result.events.length - 3} more events`);
        }
      }

      console.log("");

      if (resultCount >= maxResults) {
        console.log(
          `⚠️ Showing first ${maxResults} results only (demo limit)\n`
        );
        break;
      }
    }

    const elapsed = Date.now() - startTime;

    if (resultCount === 0) {
      console.log("📭 No results found\n");
    } else {
      console.log(`✅ Query Statistics:`);
      console.log(`  Total Results: ${resultCount}`);
      console.log(`  Query Time: ${elapsed}ms`);
      console.log(
        `  Average: ${(elapsed / resultCount).toFixed(2)}ms per result\n`
      );
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    if (process.env.DEBUG) {
      console.error("Stack:", error);
    }
  }
}

// Show help
if (process.argv.includes("--help")) {
  console.log(`
Unified Query Interface Demo

This demonstrates the new unified query interface that automatically handles
both direct and correlation queries, with support for named adapter instances.

Usage: 
  node unified-query.js [query]
  node unified-query.js --help

Examples:
  # Direct query to default instance
  node unified-query.js "graylog(level:error)[5m]"
  
  # Query specific named instance
  node unified-query.js "graylog-prod(service:api)[10m]"
  
  # Correlation query (auto-detected)
  node unified-query.js "graylog(level:error)[5m] and on(request_id) graylog(level:info)[5m]"
  
  # Cross-instance correlation
  node unified-query.js "graylog-prod(service:api)[5m] and on(request_id) graylog-staging(service:api)[5m]"

Environment Variables:
  # Default Graylog instance
  GRAYLOG_URL              - Main Graylog server URL
  GRAYLOG_STREAM_NAME      - Stream to filter (optional)
  
  # Additional named instances (optional)
  GRAYLOG_PROD_URL         - Production Graylog URL
  GRAYLOG_PROD_STREAM      - Production stream name
  GRAYLOG_STAGING_URL      - Staging Graylog URL
  GRAYLOG_STAGING_STREAM   - Staging stream name
  
  # Authentication (applies to all instances)
  GRAYLOG_USERNAME         - Username for basic auth
  GRAYLOG_PASSWORD         - Password for basic auth
  GRAYLOG_API_TOKEN        - API token (preferred over username/password)
  
  # Proxy configuration (optional)
  SOCKS_PROXY_HOST         - SOCKS proxy hostname
  SOCKS_PROXY_PORT         - SOCKS proxy port
  
  # Other
  DEBUG                    - Show debug information

Without arguments, runs demo queries showing different capabilities.
`);
  process.exit(0);
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
