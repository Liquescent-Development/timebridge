#!/usr/bin/env node

/**
 * Example demonstrating multi-source queries with named adapters
 *
 * This shows how to:
 * 1. Register multiple instances of the same adapter type
 * 2. Use them in both direct and correlation queries
 * 3. Let the library automatically detect query type
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TimeQLExecutor } = require("../dist");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GraylogAdapter } = require("@timebridge/graylog");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LokiAdapter } = require("@timebridge/loki");

async function main() {
  // Create the query executor
  const executor = new TimeQLExecutor({
    timeWindow: 30000, // 30 second correlation window
    maxEvents: 10000,
  });

  // Register multiple Graylog instances
  executor.addAdapter(
    "graylog-prod",
    new GraylogAdapter({
      url: "https://prod.graylog.example.com",
      apiToken: process.env.GRAYLOG_PROD_TOKEN,
      apiVersion: "v6",
    }),
    { isDefault: true }
  ); // This will be the default for 'graylog' queries

  executor.addAdapter(
    "graylog-staging",
    new GraylogAdapter({
      url: "https://staging.graylog.example.com",
      apiToken: process.env.GRAYLOG_STAGING_TOKEN,
      apiVersion: "v6",
    })
  );

  executor.addAdapter(
    "graylog-dev",
    new GraylogAdapter({
      url: "http://localhost:9000",
      username: "admin",
      password: "admin",
      apiVersion: "legacy",
    })
  );

  // Register multiple Loki instances
  executor.addAdapter(
    "loki-us-east",
    new LokiAdapter({
      url: "https://loki-us-east.example.com",
    }),
    { isDefault: true }
  );

  executor.addAdapter(
    "loki-eu-west",
    new LokiAdapter({
      url: "https://loki-eu-west.example.com",
    })
  );

  // Show registered adapters
  console.log("📊 Registered Data Sources:");
  for (const info of executor.getAdapterInfo()) {
    console.log(
      `  - ${info.name} (type: ${info.baseType})${
        info.isDefault ? " [DEFAULT]" : ""
      }`
    );
  }
  console.log("");

  // Example queries
  const queries = [
    {
      name: "Direct query to default Graylog",
      query: "graylog(level:error)[5m]",
      // Uses graylog-prod since it's the default
    },
    {
      name: "Direct query to specific Graylog",
      query: "graylog-staging(level:warn)[10m]",
      // Explicitly uses staging instance
    },
    {
      name: "Cross-environment correlation",
      query: `
        graylog-prod(service:api AND level:error)[30m]
        and on(request_id)
        graylog-staging(service:api)[30m]
      `,
      // Correlates errors in prod with staging logs
    },
    {
      name: "Multi-region correlation",
      query: `
        loki-us-east({job="nginx"})[5m]
        and on(trace_id)
        loki-eu-west({job="nginx"})[5m]
      `,
      // Correlates across regions
    },
    {
      name: "Cross-platform correlation",
      query: `
        graylog-prod(application:frontend)[10m]
        and on(session_id)
        loki-us-east({service="api"})[10m]
      `,
      // Correlates between different logging systems
    },
    {
      name: "Three-way correlation across environments",
      query: `
        graylog-dev(feature:experimental)[1h]
        and on(feature_flag_id)
        graylog-staging(feature:experimental)[1h]
        and on(feature_flag_id)
        graylog-prod(feature:experimental)[1h]
      `,
      // Tracks feature flag usage across all environments
    },
  ];

  // Execute each query
  for (const { name, query } of queries) {
    console.log(`🔍 ${name}`);

    // Validate the query first
    const validation = executor.validateQuery(query);
    if (!validation.valid) {
      console.log(`  ❌ Invalid query: ${validation.error}`);
      continue;
    }

    console.log(`  📝 Query type: ${validation.type}`);
    console.log(`  🔗 Sources: ${validation.sources?.join(", ")}`);

    try {
      let count = 0;
      const maxResults = 5;

      // Execute the query (automatically handles direct vs correlation)
      for await (const result of executor.execute(query)) {
        count++;

        if (validation.type === "direct") {
          // Direct query returns LogEvents
          console.log(
            `    Event ${count}: ${
              result.timestamp
            } - ${result.message?.substring(0, 50)}...`
          );
        } else {
          // Correlation query returns CorrelatedEvents
          console.log(
            `    Correlation ${count}: Found ${result.events.length} correlated events`
          );
        }

        if (count >= maxResults) break;
      }

      if (count === 0) {
        console.log("    No results found");
      }
    } catch (error) {
      console.log(`  ⚠️ Error: ${error.message}`);
    }

    console.log("");
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
