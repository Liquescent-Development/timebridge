// Basic correlation example - vanilla JavaScript
const { TimeBridgeEngine } = require("@timebridge/core");
const { LokiAdapter } = require("@timebridge/loki");
const { GraylogAdapter } = require("@timebridge/graylog");

// Mock adapter for CI testing
class MockAdapter {
  constructor(name) {
    this.name = name;
  }

  getName() {
    return this.name;
  }

  validateQuery() {
    return true;
  }

  async *createStream() {
    // Return empty stream for CI
    yield* [];
  }

  extractJoinKeys() {
    return {};
  }

  async destroy() {}

  async getAvailableStreams() {
    return [];
  }
}

async function main() {
  // Create correlation engine with simple configuration
  const engine = new TimeBridgeEngine({
    timeWindow: 30000, // 30 second window
    maxEvents: 10000, // Memory limit
    lateTolerance: 5000, // 5 second late arrival tolerance
  });

  // In CI, use mock adapters to avoid network connections
  if (process.env.CI) {
    console.log("Running in CI mode - using mock adapters");
    engine.addAdapter("loki", new MockAdapter("loki"));
    engine.addAdapter("graylog", new MockAdapter("graylog"));
  } else {
    // Add Loki adapter
    engine.addAdapter(
      "loki",
      new LokiAdapter({
        url: "http://localhost:3100",
        websocket: false, // Use polling for this example
        pollInterval: 1000,
      })
    );

    // Add Graylog adapter
    engine.addAdapter(
      "graylog",
      new GraylogAdapter({
        url: "http://localhost:9000",
        username: "admin",
        password: "admin",
        pollInterval: 2000,
        // apiVersion: "v6", // Use for Graylog 6.x+ (requires API token, returns CSV)
      })
    );
  }

  // In CI mode, just validate the setup and exit
  if (process.env.CI) {
    console.log("\nCI mode: Skipping actual correlation (no data sources)");
    console.log("✅ Basic correlation example setup validated");
    await engine.destroy();
    return;
  }

  // Example 1: Basic inner join
  console.log("Example 1: Basic Inner Join");
  console.log("----------------------------");

  const query1 = `
    loki({service="frontend"})[5m] 
      and on(request_id) 
      loki({service="backend"})[5m]
  `;

  try {
    for await (const correlation of engine.correlate(query1)) {
      console.log(`Found correlation for request_id: ${correlation.joinValue}`);
      console.log(`  Total events: ${correlation.events.length}`);

      correlation.events.forEach((event) => {
        console.log(
          `    [${event.source}] ${event.timestamp}: ${event.message}`
        );
      });
      console.log("");
    }
  } catch (error) {
    console.error("Correlation failed:", error);
  }

  // Example 2: Cross-source correlation
  console.log("\nExample 2: Cross-Source Correlation");
  console.log("------------------------------------");

  const query2 = `
    loki({job="nginx"})[5m] 
      and on(request_id) 
      graylog(service:api)[5m]
  `;

  try {
    for await (const correlation of engine.correlate(query2)) {
      console.log(`Cross-source correlation found:`);
      console.log(`  Join key: ${correlation.joinKey}`);
      console.log(`  Join value: ${correlation.joinValue}`);
      console.log(
        `  Sources: ${correlation.metadata.matchedStreams.join(", ")}`
      );
      console.log("");
    }
  } catch (error) {
    console.error("Cross-source correlation failed:", error);
  }

  // Example 3: Left join (all frontend events, backend if available)
  console.log("\nExample 3: Left Join");
  console.log("--------------------");

  const query3 = `
    loki({service="frontend"})[5m] 
      or on(request_id) 
      loki({service="backend"})[5m]
  `;

  try {
    let completeCount = 0;
    let partialCount = 0;

    for await (const correlation of engine.correlate(query3)) {
      if (correlation.metadata.completeness === "complete") {
        completeCount++;
      } else {
        partialCount++;
      }
    }

    console.log(`  Complete correlations: ${completeCount}`);
    console.log(`  Partial correlations: ${partialCount}`);
  } catch (error) {
    console.error("Left join failed:", error);
  }

  // Clean up
  await engine.destroy();
  console.log("\nEngine destroyed successfully");
}

// Run the example
main().catch(console.error);
