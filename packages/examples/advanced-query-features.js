// Advanced query features demonstration - vanilla JavaScript
const { TimeBridgeEngine } = require("@timebridge/core");
const { LokiAdapter } = require("@timebridge/loki");
const { GraylogAdapter } = require("@timebridge/graylog");
const { PromQLAdapter } = require("@timebridge/promql");

async function main() {
  // Create correlation engine with advanced configuration
  const engine = new TimeBridgeEngine({
    defaultTimeWindow: "5m",
    timeWindow: 300000, // 5 minute window
    maxEvents: 50000, // Higher memory limit for complex correlations
    lateTolerance: "30s", // 30 second late arrival tolerance
    bufferSize: 5000, // Larger buffer for high-volume streams
    maxMemoryMB: 512, // 512MB memory limit
  });

  // Setup all adapters
  engine.addAdapter(
    "loki",
    new LokiAdapter({
      url: "http://localhost:3100",
      websocket: true, // Use WebSocket for real-time
      reconnectInterval: 5000,
    })
  );

  engine.addAdapter(
    "graylog",
    new GraylogAdapter({
      url: "http://localhost:9000",
      username: "admin",
      password: "admin",
      pollInterval: 1000,
    })
  );

  engine.addAdapter(
    "promql",
    new PromQLAdapter({
      url: "http://localhost:9090",
      pollInterval: 5000,
    })
  );

  // ============================================
  // Example 1: Temporal Constraints
  // ============================================
  console.log("Example 1: Temporal Constraints");
  console.log("================================");

  const temporalQuery = `
    loki({service="frontend"})[5m] 
      and on(request_id) within(2s)
      loki({service="backend"})[5m]
  `;

  console.log("Query:", temporalQuery.trim());
  console.log("Finding correlations within 2 second window...\n");

  try {
    for await (const correlation of engine.correlate(temporalQuery)) {
      const timeSpan =
        new Date(correlation.timeWindow.end) -
        new Date(correlation.timeWindow.start);
      console.log(`  Request ${correlation.joinValue}: ${timeSpan}ms span`);
    }
  } catch (error) {
    console.error("Temporal correlation failed:", error);
  }

  // ============================================
  // Example 2: Group Modifiers
  // ============================================
  console.log("\nExample 2: Group Modifiers");
  console.log("==========================");

  const groupLeftQuery = `
    loki({service="api"})[5m] 
      and on(user_id) group_left(region, tier)
      loki({service="auth"})[5m]
  `;

  console.log("Query:", groupLeftQuery.trim());
  console.log("Many-to-one join preserving auth service labels...\n");

  try {
    for await (const correlation of engine.correlate(groupLeftQuery)) {
      console.log(`  User ${correlation.joinValue}:`);
      console.log(
        `    API events: ${
          correlation.events.filter(
            (e) => e.source === "loki" && e.labels.service === "api"
          ).length
        }`
      );
      console.log(
        `    Auth events: ${
          correlation.events.filter(
            (e) => e.source === "loki" && e.labels.service === "auth"
          ).length
        }`
      );
    }
  } catch (error) {
    console.error("Group modifier correlation failed:", error);
  }

  // ============================================
  // Example 3: Ignoring Clause
  // ============================================
  console.log("\nExample 3: Ignoring Clause");
  console.log("==========================");

  const ignoringQuery = `
    loki({service="frontend"})[5m] 
      and on(request_id) ignoring(instance_id, pod_name)
      loki({service="backend"})[5m]
  `;

  console.log("Query:", ignoringQuery.trim());
  console.log("Correlating while ignoring infrastructure labels...\n");

  try {
    let correlationCount = 0;
    for await (const correlation of engine.correlate(ignoringQuery)) {
      correlationCount++;
    }
    console.log(
      `  Found ${correlationCount} correlations ignoring instance differences`
    );
  } catch (error) {
    console.error("Ignoring clause correlation failed:", error);
  }

  // ============================================
  // Example 4: Label Mapping
  // ============================================
  console.log("\nExample 4: Label Mapping");
  console.log("========================");

  const labelMappingQuery = `
    loki({service="orders"})[5m] 
      and on(order_id=transaction_id, customer_id=user_id)
      graylog(service:payments)[5m]
  `;

  console.log("Query:", labelMappingQuery.trim());
  console.log(
    "Mapping order_id to transaction_id and customer_id to user_id...\n"
  );

  try {
    for await (const correlation of engine.correlate(labelMappingQuery)) {
      console.log(
        `  Correlated order ${correlation.joinValue} with payment transaction`
      );
    }
  } catch (error) {
    console.error("Label mapping correlation failed:", error);
  }

  // ============================================
  // Example 5: Post-Correlation Filtering
  // ============================================
  console.log("\nExample 5: Post-Correlation Filtering");
  console.log("=====================================");

  const filterQuery = `
    loki({service="api"})[5m] 
      and on(request_id)
      loki({service="backend"})[5m]
    {status=~"4..|5..", level!="DEBUG"}
  `;

  console.log("Query:", filterQuery.trim());
  console.log(
    "Filtering for errors (4xx/5xx status) excluding DEBUG logs...\n"
  );

  try {
    for await (const correlation of engine.correlate(filterQuery)) {
      const errorEvents = correlation.events.filter(
        (e) => e.labels.status && e.labels.status.match(/^[45]/)
      );
      console.log(
        `  Request ${correlation.joinValue}: ${errorEvents.length} error events`
      );
    }
  } catch (error) {
    console.error("Filtered correlation failed:", error);
  }

  // ============================================
  // Example 6: Anti-Join (Unless)
  // ============================================
  console.log("\nExample 6: Anti-Join (Unless)");
  console.log("=============================");

  const unlessQuery = `
    loki({service="frontend"})[5m] 
      unless on(request_id)
      loki({service="backend"})[5m]
  `;

  console.log("Query:", unlessQuery.trim());
  console.log("Finding frontend requests WITHOUT backend processing...\n");

  try {
    let orphanedRequests = 0;
    for await (const correlation of engine.correlate(unlessQuery)) {
      orphanedRequests++;
    }
    console.log(
      `  Found ${orphanedRequests} frontend requests with no backend correlation`
    );
  } catch (error) {
    console.error("Anti-join correlation failed:", error);
  }

  // ============================================
  // Example 7: Multi-Stream Correlation (3+ streams)
  // ============================================
  console.log("\nExample 7: Multi-Stream Correlation");
  console.log("====================================");

  const multiStreamQuery = `
    loki({service="frontend"})[5m] 
      and on(trace_id) within(10s)
      loki({service="api"})[5m]
      and on(trace_id) within(10s)
      loki({service="database"})[5m]
      and on(trace_id) within(10s)
      graylog(service:cache)[5m]
  `;

  console.log("Query:", multiStreamQuery.trim());
  console.log("Correlating across 4 services with trace_id...\n");

  try {
    for await (const correlation of engine.correlate(multiStreamQuery)) {
      const services = new Set(
        correlation.events.map((e) => e.labels.service || e.source)
      );
      console.log(
        `  Trace ${correlation.joinValue}: ${services.size} services involved`
      );
      console.log(`    Services: ${Array.from(services).join(", ")}`);
    }
  } catch (error) {
    console.error("Multi-stream correlation failed:", error);
  }

  // ============================================
  // Example 8: Metrics and Logs Correlation
  // ============================================
  console.log("\nExample 8: Metrics and Logs Correlation");
  console.log("========================================");

  const metricsLogsQuery = `
    loki({service="app", level="error"})[1m] 
      and on(instance_id=instance) within(5s)
      promql(rate(http_requests_total{status=~"5.."}[1m]))[1m]
  `;

  console.log("Query:", metricsLogsQuery.trim());
  console.log("Correlating error logs with HTTP 5xx metrics...\n");

  try {
    for await (const correlation of engine.correlate(metricsLogsQuery)) {
      const logs = correlation.events.filter((e) => e.source === "loki");
      const metrics = correlation.events.filter((e) => e.source === "promql");
      console.log(`  Instance ${correlation.joinValue}:`);
      console.log(`    Error logs: ${logs.length}`);
      console.log(`    Metric points: ${metrics.length}`);
    }
  } catch (error) {
    console.error("Metrics/logs correlation failed:", error);
  }

  // ============================================
  // Example 9: Complex Combined Query
  // ============================================
  console.log("\nExample 9: Complex Combined Query");
  console.log("==================================");

  const complexQuery = `
    loki({service="frontend", env="prod"})[10m] 
      and on(session_id=trace_id) within(30s) ignoring(version, build_id) group_left(user_type)
      graylog(service:auth AND level:INFO)[10m]
      or on(session_id)
      promql(up{job="frontend"})[10m]
    {status=~"2..", duration_ms>1000}
  `;

  console.log("Query:", complexQuery.trim());
  console.log("Complex query with all features combined...\n");

  try {
    let complexCorrelations = 0;
    for await (const correlation of engine.correlate(complexQuery)) {
      complexCorrelations++;
      if (complexCorrelations === 1) {
        console.log(`  Sample correlation:`);
        console.log(
          `    Join: ${correlation.joinKey} = ${correlation.joinValue}`
        );
        console.log(`    Events: ${correlation.events.length}`);
        console.log(`    Completeness: ${correlation.metadata.completeness}`);
        console.log(
          `    Time span: ${correlation.timeWindow.start} to ${correlation.timeWindow.end}`
        );
      }
    }
    console.log(`\n  Total complex correlations found: ${complexCorrelations}`);
  } catch (error) {
    console.error("Complex correlation failed:", error);
  }

  // ============================================
  // Performance Monitoring
  // ============================================
  console.log("\nPerformance Metrics");
  console.log("===================");

  engine.on("performanceMetrics", (metrics) => {
    console.log(
      `  Memory: ${(metrics.memoryUsage / 1024 / 1024).toFixed(2)} MB`
    );
    console.log(`  CPU: ${metrics.cpuUsage.toFixed(2)}%`);
    console.log(`  Event rate: ${metrics.eventRate} events/sec`);
  });

  // Clean up
  await engine.destroy();
  console.log("\nEngine destroyed successfully");
  console.log("All examples completed!");
}

// Run the examples
console.log("Log Correlator - Advanced Query Features Demo");
console.log("=============================================\n");

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
