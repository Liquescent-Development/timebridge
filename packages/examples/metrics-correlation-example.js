/**
 * Example: Correlating Metrics with Logs
 *
 * This example demonstrates how to correlate metrics from Prometheus/InfluxDB
 * with logs from Graylog/Loki to gain insights across your observability stack.
 */

const { TimeQLExecutor } = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");
const { PrometheusAdapter } = require("@timebridge/prometheus");
const { InfluxDBAdapter } = require("@timebridge/influxdb");

async function main() {
  // Initialize the query executor
  const executor = new TimeQLExecutor({
    timeWindow: 60000, // 1 minute correlation window
    maxEvents: 10000,
  });

  // Configure adapters (replace with your actual endpoints)
  executor.addAdapter(
    "prometheus",
    new PrometheusAdapter({
      url: process.env.PROMETHEUS_URL || "http://localhost:9090",
      pollInterval: 5000, // Poll every 5 seconds for real-time data
    })
  );

  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      url: process.env.GRAYLOG_URL || "http://localhost:9000",
      apiToken: process.env.GRAYLOG_TOKEN || "your-token",
      apiVersion: "v6",
    })
  );

  executor.addAdapter(
    "influxdb",
    new InfluxDBAdapter({
      url: process.env.INFLUXDB_URL || "http://localhost:8086",
      database: "monitoring",
      version: "1.x",
    })
  );

  console.log("Starting metrics-logs correlation examples...\n");

  // Example 1: Correlate HTTP 500 errors with error logs
  await correlateHttpErrors(executor);

  // Example 2: Correlate high latency with database queries
  await correlateLatencyIssues(executor);

  // Example 3: Correlate resource usage with application behavior
  await correlateResourceUsage(executor);

  // Example 4: Real-time alerting on correlated events
  await realTimeCorrelationAlerts(executor);
}

/**
 * Example 1: Correlate HTTP 500 errors from metrics with application error logs
 */
async function correlateHttpErrors(executor) {
  console.log("=== Example 1: HTTP 500 Errors Correlation ===\n");

  const query = `
    prometheus(http_requests_total{status="500"})[5m]
      and on(request_id)
    graylog(level:error AND service:api)[5m]
  `;

  try {
    let correlationCount = 0;
    for await (const correlation of executor.execute(query)) {
      correlationCount++;

      console.log(`Correlation ${correlationCount} found:`);
      console.log(`  Request ID: ${correlation.joinValue}`);
      console.log(
        `  Time window: ${new Date(
          correlation.timeWindow.start
        ).toLocaleTimeString()} - ${new Date(
          correlation.timeWindow.end
        ).toLocaleTimeString()}`
      );

      // Find the metric and log events
      const metricEvent = correlation.events.find(
        (e) => e.source === "prometheus"
      );
      const logEvent = correlation.events.find((e) => e.source === "graylog");

      if (metricEvent) {
        console.log(
          `  Metric: ${metricEvent.labels.method} ${metricEvent.labels.path} returned 500`
        );
      }

      if (logEvent) {
        console.log(`  Error: ${logEvent.message}`);
      }

      console.log("");

      // Stop after 5 correlations for demo
      if (correlationCount >= 5) break;
    }

    if (correlationCount === 0) {
      console.log(
        "No HTTP 500 errors correlated with logs in the last 5 minutes.\n"
      );
    }
  } catch (error) {
    console.error("Error in HTTP correlation:", error);
  }
}

/**
 * Example 2: Correlate high API latency with slow database queries
 */
async function correlateLatencyIssues(executor) {
  console.log("=== Example 2: Latency Issues Correlation ===\n");

  const query = `
    prometheus(http_request_duration_seconds{quantile="0.99"} > 1)[10m]
      and on(trace_id)
    influxdb(SELECT * FROM db_queries WHERE duration > 1000)[10m]
  `;

  try {
    let issueCount = 0;
    for await (const correlation of executor.execute(query)) {
      issueCount++;

      console.log(`Performance issue ${issueCount} detected:`);
      console.log(`  Trace ID: ${correlation.joinValue}`);

      const apiMetric = correlation.events.find(
        (e) => e.source === "prometheus"
      );
      const dbMetric = correlation.events.find((e) => e.source === "influxdb");

      if (apiMetric && dbMetric) {
        console.log(`  API endpoint: ${apiMetric.labels.endpoint}`);
        console.log(`  API latency: ${apiMetric.labels.__value__}s`);
        console.log(`  DB query: ${dbMetric.labels.query_type}`);
        console.log(`  DB duration: ${dbMetric.labels.duration}ms`);
      }

      console.log(`  Correlation suggests database is causing API latency\n`);

      // Stop after 3 issues for demo
      if (issueCount >= 3) break;
    }

    if (issueCount === 0) {
      console.log("No latency issues detected in the last 10 minutes.\n");
    }
  } catch (error) {
    console.error("Error in latency correlation:", error);
  }
}

/**
 * Example 3: Correlate CPU/memory usage with application behavior
 */
async function correlateResourceUsage(executor) {
  console.log("=== Example 3: Resource Usage Correlation ===\n");

  const query = `
    influxdb(SELECT * FROM cpu WHERE usage > 80)[15m]
      and on(host)
    graylog(level:warn OR level:error)[15m]
  `;

  try {
    let alertCount = 0;
    for await (const correlation of executor.execute(query)) {
      alertCount++;

      console.log(`Resource alert ${alertCount}:`);
      console.log(`  Host: ${correlation.joinValue}`);

      const cpuEvent = correlation.events.find((e) => e.source === "influxdb");
      const logEvents = correlation.events.filter(
        (e) => e.source === "graylog"
      );

      if (cpuEvent) {
        console.log(`  CPU Usage: ${cpuEvent.labels.usage}%`);
      }

      if (logEvents.length > 0) {
        console.log(`  Related application issues:`);
        logEvents.slice(0, 3).forEach((log) => {
          console.log(`    - [${log.labels.level}] ${log.message}`);
        });
      }

      console.log("");

      // Stop after 3 alerts for demo
      if (alertCount >= 3) break;
    }

    if (alertCount === 0) {
      console.log(
        "No high resource usage correlated with application issues.\n"
      );
    }
  } catch (error) {
    console.error("Error in resource correlation:", error);
  }
}

/**
 * Example 4: Real-time correlation alerting
 */
async function realTimeCorrelationAlerts(executor) {
  console.log("=== Example 4: Real-time Correlation Alerts ===\n");
  console.log("Monitoring for correlated events (press Ctrl+C to stop)...\n");

  // Complex correlation across multiple sources
  const query = `
    prometheus(rate(http_requests_total{status=~"5.."}[1m]) > 0.1)[5m]
      and on(service)
    influxdb(SELECT mean(memory_usage) FROM container WHERE memory_usage > 80 GROUP BY service)[5m]
      and on(service)
    graylog(level:error)[5m]
  `;

  try {
    for await (const correlation of executor.execute(query)) {
      // Alert on correlation
      console.log("🚨 ALERT: Multi-source correlation detected!");
      console.log(`  Service: ${correlation.joinValue}`);
      console.log(`  Issue: High error rate + High memory + Error logs`);
      console.log(`  Time: ${new Date().toLocaleTimeString()}`);
      console.log(
        `  Matched sources: ${correlation.metadata.matchedStreams.join(", ")}`
      );

      // Analyze the correlation
      const metrics = correlation.events.filter(
        (e) => e.source === "prometheus"
      );
      const memory = correlation.events.find((e) => e.source === "influxdb");
      const errors = correlation.events.filter((e) => e.source === "graylog");

      if (metrics.length > 0) {
        console.log(
          `  Error rate: ${metrics[0].labels.__value__} requests/sec`
        );
      }

      if (memory) {
        console.log(`  Memory usage: ${memory.labels.mean}%`);
      }

      if (errors.length > 0) {
        console.log(`  Recent errors: ${errors.length} error log entries`);
        console.log(
          `  Sample error: ${errors[0].message.substring(0, 100)}...`
        );
      }

      console.log(
        "\n  Recommended action: Check service health and consider scaling or restart"
      );
      console.log("  " + "=".repeat(60) + "\n");

      // In production, you would send this to your alerting system
      // sendAlert(correlation);
    }
  } catch (error) {
    console.error("Error in real-time alerting:", error);
  }
}

// Helper function to format correlation data for display
function formatCorrelation(correlation) {
  const summary = {
    id: correlation.correlationId,
    joinKey: correlation.joinKey,
    joinValue: correlation.joinValue,
    timeWindow: {
      start: new Date(correlation.timeWindow.start).toLocaleTimeString(),
      end: new Date(correlation.timeWindow.end).toLocaleTimeString(),
    },
    sources: correlation.metadata.matchedStreams,
    eventCount: correlation.events.length,
  };

  return JSON.stringify(summary, null, 2);
}

// Run the example
main().catch(console.error);
