// Error Pattern Detection Example
// This example shows how to detect error patterns across services
// and correlate them with metrics to identify root causes

const { TimeBridgeEngine } = require("@timebridge/core");
const { LokiAdapter } = require("@timebridge/loki");
const { PromQLAdapter } = require("@timebridge/promql");

async function detectErrorPatterns() {
  // Initialize correlation engine
  const engine = new TimeBridgeEngine({
    defaultTimeWindow: "5m",
    maxEvents: 50000,
    lateTolerance: "30s",
  });

  // Add log source adapters
  engine.addAdapter(
    "loki",
    new LokiAdapter({
      url: process.env.LOKI_URL || "http://localhost:3100",
      websocket: true,
      authToken: process.env.LOKI_TOKEN,
    })
  );

  // Add metrics adapter for correlation with system metrics
  engine.addAdapter(
    "promql",
    new PromQLAdapter({
      url: process.env.PROMETHEUS_URL || "http://localhost:9090",
      authToken: process.env.PROMETHEUS_TOKEN,
    })
  );

  console.log("🔍 Starting error pattern detection...\n");

  // Example 1: Detect cascading failures across services
  await detectCascadingFailures(engine);

  // Example 2: Correlate errors with high latency
  await correlateErrorsWithLatency(engine);

  // Example 3: Find error patterns without corresponding requests
  await detectOrphanedErrors(engine);

  // Example 4: Real-time error monitoring with alerts
  await monitorErrorsRealTime(engine);

  // Cleanup
  await engine.destroy();
}

async function detectCascadingFailures(engine) {
  console.log("📊 Example 1: Detecting Cascading Failures");
  console.log("----------------------------------------");

  // Query to find errors that cascade from frontend to backend
  const cascadeQuery = `
    loki({service="frontend",level="error"})[5m]
      and on(request_id) within(5s)
      loki({service="backend",level="error"})[5m]
  `;

  const cascadingErrors = [];

  for await (const correlation of engine.correlate(cascadeQuery)) {
    cascadingErrors.push(correlation);

    // Analyze the cascade pattern
    const frontendError = correlation.events.find(
      (e) => e.labels.service === "frontend"
    );
    const backendError = correlation.events.find(
      (e) => e.labels.service === "backend"
    );

    if (frontendError && backendError) {
      const timeDiff =
        new Date(backendError.timestamp) - new Date(frontendError.timestamp);

      console.log(`  ⚠️  Cascading failure detected:`);
      console.log(`     Request ID: ${correlation.joinValue}`);
      console.log(`     Frontend error: ${frontendError.message}`);
      console.log(`     Backend error: ${backendError.message}`);
      console.log(`     Cascade time: ${timeDiff}ms`);

      // Check if this is a critical pattern
      if (timeDiff < 100) {
        console.log(
          `     🔴 CRITICAL: Near-instant cascade indicates synchronous failure!`
        );
      }
    }
  }

  console.log(
    `\n  Total cascading failures found: ${cascadingErrors.length}\n`
  );
}

async function correlateErrorsWithLatency(engine) {
  console.log("📊 Example 2: Correlating Errors with High Latency");
  console.log("------------------------------------------------");

  // Correlate application errors with high HTTP request duration
  const latencyErrorQuery = `
    loki({service="api",level="error"})[5m]
      and on(request_id) 
      promql(http_request_duration_seconds{quantile="0.99"})[5m]
      {__value__=~"[1-9].*"}
  `;

  const highLatencyErrors = [];

  for await (const correlation of engine.correlate(latencyErrorQuery)) {
    highLatencyErrors.push(correlation);

    // Find the metric value
    const metricEvent = correlation.events.find((e) => e.source === "promql");
    const errorEvent = correlation.events.find(
      (e) => e.labels.level === "error"
    );

    if (metricEvent && errorEvent) {
      const latency = parseFloat(metricEvent.labels.__value__);

      console.log(`  🐌 High latency error detected:`);
      console.log(`     Request ID: ${correlation.joinValue}`);
      console.log(`     Error: ${errorEvent.message}`);
      console.log(`     P99 Latency: ${latency.toFixed(2)}s`);

      // Categorize severity
      if (latency > 5) {
        console.log(`     🔴 SEVERE: Latency > 5s, likely timeout`);
      } else if (latency > 2) {
        console.log(`     🟠 WARNING: Latency > 2s, poor user experience`);
      }
    }
  }

  console.log(`\n  Total high-latency errors: ${highLatencyErrors.length}\n`);
}

async function detectOrphanedErrors(engine) {
  console.log("📊 Example 3: Detecting Orphaned Errors");
  console.log("------------------------------------");

  // Find backend errors without corresponding frontend requests
  const orphanQuery = `
    loki({service="backend",level="error"})[5m]
      unless on(request_id)
      loki({service="frontend"})[5m]
  `;

  const orphanedErrors = [];

  for await (const correlation of engine.correlate(orphanQuery)) {
    orphanedErrors.push(correlation);

    const error = correlation.events[0];
    console.log(`  👻 Orphaned backend error:`);
    console.log(`     Request ID: ${correlation.joinValue}`);
    console.log(`     Error: ${error.message}`);
    console.log(`     Timestamp: ${error.timestamp}`);

    // Try to identify the cause
    if (error.message.includes("cron") || error.message.includes("scheduled")) {
      console.log(`     📅 Likely cause: Scheduled job error`);
    } else if (
      error.message.includes("timeout") ||
      error.message.includes("connection")
    ) {
      console.log(`     🔌 Likely cause: External service issue`);
    } else {
      console.log(`     ❓ Unknown origin - investigate further`);
    }
  }

  console.log(`\n  Total orphaned errors: ${orphanedErrors.length}\n`);
}

async function monitorErrorsRealTime(engine) {
  console.log("📊 Example 4: Real-time Error Monitoring");
  console.log("-------------------------------------");
  console.log("  Monitoring for 30 seconds...\n");

  // Monitor for critical errors in real-time
  const criticalQuery = `
    loki({level=~"error|fatal|panic"})[30s]
      and on(request_id)
      loki({status=~"5.."})[30s]
  `;

  // Set up real-time monitoring
  let errorCount = 0;
  let lastAlertTime = 0;
  const alertThreshold = 5; // Alert if more than 5 errors in 10 seconds
  const alertWindow = 10000; // 10 seconds

  const timeout = setTimeout(() => {
    console.log("\n  ✅ Monitoring period complete");
  }, 30000);

  try {
    for await (const correlation of engine.correlate(criticalQuery)) {
      errorCount++;
      const now = Date.now();

      // Check for error spike
      if (now - lastAlertTime > alertWindow) {
        errorCount = 1;
        lastAlertTime = now;
      }

      console.log(
        `  🔴 Critical error detected at ${new Date().toISOString()}`
      );
      console.log(`     Request: ${correlation.joinValue}`);

      // Find status code
      const statusEvent = correlation.events.find((e) => e.labels.status);
      if (statusEvent) {
        console.log(`     Status: ${statusEvent.labels.status}`);
      }

      // Alert on error spike
      if (errorCount >= alertThreshold) {
        console.log(
          `\n  🚨 ALERT: Error spike detected! ${errorCount} errors in ${
            alertWindow / 1000
          }s`
        );
        console.log(`     Consider scaling up or enabling circuit breakers\n`);
        errorCount = 0; // Reset counter after alert
      }

      // Stop after timeout
      if (Date.now() - now > 30000) break;
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Helper function to analyze error patterns
function analyzeErrorPattern(errors) {
  const patterns = {
    timeouts: 0,
    connectionErrors: 0,
    authErrors: 0,
    serverErrors: 0,
    other: 0,
  };

  errors.forEach((error) => {
    const message = error.message.toLowerCase();
    if (message.includes("timeout")) {
      patterns.timeouts++;
    } else if (message.includes("connection") || message.includes("refused")) {
      patterns.connectionErrors++;
    } else if (
      message.includes("401") ||
      message.includes("403") ||
      message.includes("auth")
    ) {
      patterns.authErrors++;
    } else if (message.includes("500") || message.includes("internal")) {
      patterns.serverErrors++;
    } else {
      patterns.other++;
    }
  });

  return patterns;
}

// Run the examples
if (require.main === module) {
  detectErrorPatterns().catch((error) => {
    console.error("Error detection failed:", error);
    process.exit(1);
  });
}

module.exports = { detectErrorPatterns, analyzeErrorPattern };
