#!/usr/bin/env node

/**
 * Test Named Instances
 *
 * This example demonstrates how to use multiple named instances of Graylog adapters.
 * We'll simulate having prod and staging by using the same server but different stream names.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TimeQLExecutor } = require("@timebridge/core");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GraylogAdapter } = require("../dist/graylog-adapter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("dotenv").config({ path: "../.env" });

async function main() {
  console.log("🔬 Testing Named Adapter Instances\n");

  const executor = new TimeQLExecutor({
    timeWindow: 30000,
    maxEvents: 10000,
  });

  // Base configuration
  const baseConfig = {
    url: process.env.GRAYLOG_URL,
    apiVersion: process.env.GRAYLOG_API_VERSION || "v6",
    username: process.env.GRAYLOG_USERNAME,
    password: process.env.GRAYLOG_PASSWORD,
    apiToken: process.env.GRAYLOG_API_TOKEN,
    pollInterval: 2000,
  };

  // Add proxy if configured
  if (process.env.SOCKS_PROXY_HOST) {
    baseConfig.proxy = {
      host: process.env.SOCKS_PROXY_HOST,
      port: parseInt(process.env.SOCKS_PROXY_PORT) || 1080,
      type: 5,
    };
  }

  // Register multiple named instances
  // We'll simulate different environments using the same server
  console.log("📊 Registering Named Adapters:");

  // Default adapter - responds to 'graylog' queries
  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      ...baseConfig,
      streamName: process.env.GRAYLOG_STREAM_NAME,
    }),
    { isDefault: true }
  );
  console.log("  ✅ graylog (default) -> " + process.env.GRAYLOG_URL);

  // Production adapter - responds to 'graylog-prod' queries
  executor.addAdapter(
    "graylog-prod",
    new GraylogAdapter({
      ...baseConfig,
      streamName: process.env.GRAYLOG_STREAM_NAME, // Same stream for demo
    })
  );
  console.log(
    "  ✅ graylog-prod -> " + process.env.GRAYLOG_URL + " (simulated prod)"
  );

  // Staging adapter - responds to 'graylog-staging' queries
  executor.addAdapter(
    "graylog-staging",
    new GraylogAdapter({
      ...baseConfig,
      streamName: process.env.GRAYLOG_STREAM_NAME, // Same stream for demo
    })
  );
  console.log(
    "  ✅ graylog-staging -> " +
      process.env.GRAYLOG_URL +
      " (simulated staging)"
  );

  // Development adapter
  executor.addAdapter(
    "graylog-dev",
    new GraylogAdapter({
      ...baseConfig,
      streamName: process.env.GRAYLOG_STREAM_NAME,
    })
  );
  console.log(
    "  ✅ graylog-dev -> " + process.env.GRAYLOG_URL + " (simulated dev)"
  );

  console.log("\n" + "═".repeat(80) + "\n");

  // Test queries with different patterns
  const testQueries = [
    {
      name: "Test 1: Default adapter resolution",
      query: "graylog(tier:prd)[2m]",
      expected: "Should use the default graylog adapter",
    },
    {
      name: "Test 2: Explicit named adapter",
      query: "graylog-prod(tier:prd)[2m]",
      expected: "Should use the graylog-prod adapter",
    },
    {
      name: "Test 3: Different named adapter",
      query: "graylog-staging(tier:prd)[2m]",
      expected: "Should use the graylog-staging adapter",
    },
    {
      name: "Test 4: Cross-environment correlation",
      query: `
        graylog-prod(tier:prd AND message:"APIGW receiver")[2m]
        and on(request_id)
        graylog-staging(tier:prd AND message:"proxy response")[2m]
      `,
      expected: "Should correlate between prod and staging adapters",
    },
    {
      name: "Test 5: Three-way correlation",
      query: `
        graylog-dev(tier:prd)[2m]
        and on(request_id)
        graylog-staging(tier:prd)[2m]
        and on(request_id)
        graylog-prod(tier:prd)[2m]
      `,
      expected: "Should correlate across all three environments",
    },
    {
      name: "Test 6: Mixed default and named",
      query: `
        graylog(tier:prd)[2m]
        and on(request_id)
        graylog-prod(tier:prd)[2m]
      `,
      expected: "Should correlate between default and prod adapters",
    },
  ];

  for (const test of testQueries) {
    console.log(`🧪 ${test.name}`);
    console.log(`   Expected: ${test.expected}`);

    // Clean up query
    const query = test.query.trim().replace(/\s+/g, " ");

    // Validate
    const validation = executor.validateQuery(query);

    if (!validation.valid) {
      console.log(`   ❌ Validation failed: ${validation.error}\n`);
      continue;
    }

    console.log(`   ✅ Valid ${validation.type} query`);
    console.log(`   📍 Sources: ${validation.sources?.join(", ")}`);

    try {
      let count = 0;
      const maxResults = 3;

      console.log(`   🔍 Executing query...`);

      for await (const result of executor.execute(query)) {
        count++;

        if (validation.type === "direct") {
          // For direct queries, just count
          if (count === 1) {
            console.log(`   📝 Found events:`);
          }
          console.log(
            `      Event ${count}: ${new Date(result.timestamp)
              .toISOString()
              .substring(11, 19)} - ${result.message?.substring(0, 40)}...`
          );
        } else {
          // For correlations, show the correlation info
          if (count === 1) {
            console.log(`   🔗 Found correlations:`);
          }
          console.log(
            `      Correlation ${count}: ${
              result.events.length
            } events joined on ${result.joinKey}=${result.joinValue?.substring(
              0,
              20
            )}...`
          );
        }

        if (count >= maxResults) break;
      }

      if (count === 0) {
        console.log(`   ⚠️ No results found`);
      } else {
        console.log(`   ✅ Successfully executed (${count} results)`);
      }
    } catch (error) {
      console.log(`   ❌ Execution error: ${error.message}`);
    }

    console.log("");
  }

  console.log("═".repeat(80));
  console.log("\n✅ All tests completed!\n");
  console.log("Key takeaways:");
  console.log("  • The same query syntax works with named adapters");
  console.log("  • Adapters can be registered with any hyphenated name");
  console.log(
    "  • The library automatically routes queries to the right adapter"
  );
  console.log("  • Correlations work seamlessly across named instances");
  console.log('  • Base names (like "graylog") resolve to default adapters');
}

if (require.main === module) {
  main().catch(console.error);
}
