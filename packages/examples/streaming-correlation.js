// Streaming correlation example with real-time processing
const { TimeBridgeEngine } = require("@timebridge/core");
const { LokiAdapter } = require("@timebridge/loki");

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

// Helper function to simulate real-time visualization
function updateTimelineChart(correlation) {
  console.log(`\n📊 Timeline Update:`);
  console.log(`   Correlation ID: ${correlation.correlationId}`);
  console.log(
    `   Time Range: ${correlation.timeWindow.start} to ${correlation.timeWindow.end}`
  );

  // Create ASCII timeline
  const events = correlation.events.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  if (events.length > 0) {
    const startTime = new Date(events[0].timestamp).getTime();
    const endTime = new Date(events[events.length - 1].timestamp).getTime();
    const duration = endTime - startTime;

    console.log(`   Timeline (${duration}ms):`);

    events.forEach((event) => {
      const eventTime = new Date(event.timestamp).getTime();
      const position =
        duration > 0
          ? Math.floor(((eventTime - startTime) / duration) * 50)
          : 0;

      const timeline = " ".repeat(position) + "█";
      const label = `${event.source}/${event.alias || "unknown"}`;
      console.log(`     ${timeline} ${label}`);
    });
  }
}

// Helper function to check for error patterns
function hasErrorPattern(correlation) {
  return correlation.events.some((event) => {
    // Check labels for error indicators
    if (
      event.labels.level === "error" ||
      event.labels.level === "ERROR" ||
      event.labels.severity === "error"
    ) {
      return true;
    }

    // Check message for error keywords
    const errorKeywords = ["error", "failed", "exception", "critical"];
    const messageLower = event.message.toLowerCase();
    return errorKeywords.some((keyword) => messageLower.includes(keyword));
  });
}

// Helper function to alert user
function alertUser(correlation) {
  console.log(`\n🚨 ALERT: Error pattern detected!`);
  console.log(`   Correlation: ${correlation.correlationId}`);
  console.log(`   Join Value: ${correlation.joinValue}`);

  const errorEvents = correlation.events.filter((event) => {
    const messageLower = event.message.toLowerCase();
    return (
      messageLower.includes("error") ||
      messageLower.includes("failed") ||
      event.labels.level === "error"
    );
  });

  console.log(`   Error Events (${errorEvents.length}):`);
  errorEvents.forEach((event) => {
    console.log(`     - [${event.source}] ${event.message}`);
  });
}

// Main streaming correlation function
async function streamCorrelations() {
  console.log("Streaming Correlation Example");
  console.log("=============================\n");

  // Create engine with streaming-optimized settings
  const engine = new TimeBridgeEngine({
    defaultTimeWindow: "1m", // 1 minute window
    maxEvents: 5000, // Lower limit for streaming
    lateTolerance: "10s", // 10 second late tolerance
    bufferSize: 100, // Small buffer for quick processing
    processingInterval: "50ms", // Fast processing interval
    maxMemoryMB: 50, // Conservative memory limit
  });

  // In CI, use mock adapter to avoid network connections
  if (process.env.CI) {
    console.log("Running in CI mode - using mock adapter");
    engine.addAdapter("loki", new MockAdapter("loki"));
  } else {
    // Set up Loki adapter with WebSocket for real-time streaming
    engine.addAdapter(
      "loki",
      new LokiAdapter({
        url: process.env.LOKI_URL || "http://localhost:3100",
        websocket: true,
        authToken: process.env.LOKI_TOKEN,
      })
    );
  }

  // PromQL-style join query
  const query = `
    loki({service="frontend",environment="production"})[1m] 
      and on(request_id) 
      loki({service="backend",environment="production"})[1m]
  `;

  console.log("Starting real-time correlation stream...");
  console.log("Query:", query.trim());
  console.log("\nListening for correlations...\n");
  console.log("=".repeat(60));

  // In CI mode, just validate the setup and exit
  if (process.env.CI) {
    console.log("\nCI mode: Skipping actual correlation (no data sources)");
    console.log("✅ Streaming correlation example setup validated");
    await engine.destroy();
    return;
  }

  // Statistics
  let totalCorrelations = 0;
  let errorCorrelations = 0;
  let completeCorrelations = 0;
  let partialCorrelations = 0;
  const startTime = Date.now();

  try {
    // Stream results as they're found
    for await (const correlation of engine.correlate(query)) {
      totalCorrelations++;

      // Update statistics
      if (correlation.metadata.completeness === "complete") {
        completeCorrelations++;
      } else {
        partialCorrelations++;
      }

      // Display correlation info
      console.log(`\n🔗 Correlation #${totalCorrelations} found`);
      console.log(`   Join: ${correlation.joinKey} = ${correlation.joinValue}`);
      console.log(`   Events: ${correlation.events.length}`);
      console.log(`   Completeness: ${correlation.metadata.completeness}`);
      console.log(
        `   Streams: ${correlation.metadata.matchedStreams.join(", ")}`
      );

      // Show event details
      correlation.events.forEach((event, index) => {
        const prefix = index === 0 ? "   ├─" : "   └─";
        console.log(
          `${prefix} [${event.source}] ${
            event.timestamp
          }: ${event.message.substring(0, 50)}...`
        );
      });

      // Update visualization
      updateTimelineChart(correlation);

      // Check for error patterns and alert if found
      if (hasErrorPattern(correlation)) {
        errorCorrelations++;
        alertUser(correlation);
      }

      // Show statistics every 10 correlations
      if (totalCorrelations % 10 === 0) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log(`\n📈 Statistics after ${elapsed}s:`);
        console.log(`   Total: ${totalCorrelations}`);
        console.log(`   Complete: ${completeCorrelations}`);
        console.log(`   Partial: ${partialCorrelations}`);
        console.log(`   With Errors: ${errorCorrelations}`);
        console.log(`   Rate: ${(totalCorrelations / elapsed).toFixed(2)}/s`);
        console.log("=".repeat(60));
      }

      // Optional: Stop after certain number or time
      if (totalCorrelations >= 100) {
        console.log("\n✅ Reached 100 correlations, stopping stream...");
        break;
      }
    }
  } catch (error) {
    console.error("\n❌ Streaming error:", error.message);
    if (error.code) {
      console.error("   Error code:", error.code);
    }
    if (error.details) {
      console.error("   Details:", error.details);
    }
  }

  // Final statistics
  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log("\n" + "=".repeat(60));
  console.log("📊 Final Statistics:");
  console.log(`   Duration: ${totalElapsed}s`);
  console.log(`   Total Correlations: ${totalCorrelations}`);
  console.log(
    `   Complete: ${completeCorrelations} (${(
      (completeCorrelations / totalCorrelations) *
      100
    ).toFixed(1)}%)`
  );
  console.log(
    `   Partial: ${partialCorrelations} (${(
      (partialCorrelations / totalCorrelations) *
      100
    ).toFixed(1)}%)`
  );
  console.log(
    `   With Errors: ${errorCorrelations} (${(
      (errorCorrelations / totalCorrelations) *
      100
    ).toFixed(1)}%)`
  );
  console.log(
    `   Average Rate: ${(totalCorrelations / totalElapsed).toFixed(2)}/s`
  );

  // Clean up
  await engine.destroy();
  console.log("\n✅ Engine destroyed successfully");
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nReceived SIGINT, shutting down gracefully...");
  process.exit(0);
});

// Run the streaming example
console.log("Press Ctrl+C to stop the stream\n");
streamCorrelations().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
