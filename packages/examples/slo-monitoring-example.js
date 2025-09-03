/**
 * Example: SLO Monitoring with Correlated Observability Data
 *
 * This example shows how to monitor Service Level Objectives (SLOs)
 * by correlating metrics, logs, and time-series data.
 */

const { TimeQLExecutor } = require("@timebridge/core");
const { PrometheusAdapter } = require("@timebridge/prometheus");
const { InfluxDBAdapter } = require("@timebridge/influxdb");
const { GraylogAdapter } = require("@timebridge/graylog");
const { LokiAdapter } = require("@timebridge/loki");

class SLOMonitor {
  constructor() {
    this.executor = new TimeQLExecutor({
      timeWindow: 300000, // 5 minute correlation window
      maxEvents: 50000,
    });

    this.setupAdapters();
    this.sloDefinitions = this.defineSLOs();
    this.violations = [];
  }

  setupAdapters() {
    // Production Prometheus
    this.executor.addAdapter(
      "prometheus-prod",
      new PrometheusAdapter({
        url: process.env.PROMETHEUS_PROD_URL || "http://prometheus-prod:9090",
        apiToken: process.env.PROMETHEUS_TOKEN,
      })
    );

    // Production InfluxDB for custom metrics
    this.executor.addAdapter(
      "influxdb-prod",
      new InfluxDBAdapter({
        url: process.env.INFLUXDB_URL || "http://influxdb:8086",
        database: "production_metrics",
        version: "1.x",
      })
    );

    // Production logs
    this.executor.addAdapter(
      "graylog-prod",
      new GraylogAdapter({
        url: process.env.GRAYLOG_URL || "http://graylog:9000",
        apiToken: process.env.GRAYLOG_TOKEN,
        streamName: "production",
      })
    );

    this.executor.addAdapter(
      "loki-prod",
      new LokiAdapter({
        url: process.env.LOKI_URL || "http://loki:3100",
      })
    );
  }

  defineSLOs() {
    return {
      availability: {
        target: 99.9, // 99.9% availability
        metric: "availability_percentage",
        description: "Service availability should be >= 99.9%",
      },
      latency: {
        target: 200, // 200ms p99 latency
        metric: "latency_p99_ms",
        description: "99th percentile latency should be <= 200ms",
      },
      errorRate: {
        target: 0.1, // 0.1% error rate
        metric: "error_rate_percentage",
        description: "Error rate should be <= 0.1%",
      },
      throughput: {
        target: 1000, // 1000 requests per second minimum
        metric: "requests_per_second",
        description: "Throughput should be >= 1000 req/s",
      },
    };
  }

  async monitorSLOs() {
    console.log("🎯 Starting SLO Monitoring Dashboard\n");
    console.log("=".repeat(60));

    // Monitor each SLO
    await this.checkAvailabilitySLO();
    await this.checkLatencySLO();
    await this.checkErrorRateSLO();
    await this.checkThroughputSLO();

    // Report summary
    this.reportSummary();

    // Start continuous monitoring
    await this.continuousMonitoring();
  }

  async checkAvailabilitySLO() {
    console.log("\n📊 Checking Availability SLO...");

    const query = `
      prometheus-prod(avg_over_time(up{job="api"}[5m]) * 100)[10m]
        unless on(instance)
      graylog-prod(level:error AND message:"service unavailable")[10m]
    `;

    try {
      const results = [];
      for await (const event of this.executor.execute(query)) {
        results.push(event);
        if (results.length >= 10) break; // Sample first 10
      }

      if (results.length > 0) {
        const avgAvailability = this.calculateAverage(results, "__value__");
        const sloStatus =
          avgAvailability >= this.sloDefinitions.availability.target;

        console.log(`  Current: ${avgAvailability.toFixed(2)}%`);
        console.log(`  Target: ${this.sloDefinitions.availability.target}%`);
        console.log(`  Status: ${sloStatus ? "✅ PASSING" : "❌ VIOLATION"}`);

        if (!sloStatus) {
          await this.investigateAvailabilityIssue();
        }
      }
    } catch (error) {
      console.error("  Error checking availability SLO:", error.message);
    }
  }

  async checkLatencySLO() {
    console.log("\n⏱️  Checking Latency SLO...");

    const query = `
      prometheus-prod(histogram_quantile(0.99, http_request_duration_seconds_bucket)[5m])
        and on(endpoint)
      influxdb-prod(SELECT percentile(response_time, 99) FROM api_requests)[5m]
    `;

    try {
      let maxLatency = 0;
      let violationCount = 0;

      for await (const correlation of this.executor.execute(query)) {
        const prometheusEvent = correlation.events.find(
          (e) => e.source === "prometheus-prod"
        );
        const influxEvent = correlation.events.find(
          (e) => e.source === "influxdb-prod"
        );

        if (prometheusEvent) {
          const latencyMs = parseFloat(prometheusEvent.labels.__value__) * 1000;
          maxLatency = Math.max(maxLatency, latencyMs);

          if (latencyMs > this.sloDefinitions.latency.target) {
            violationCount++;
            console.log(
              `  ⚠️ High latency on ${
                prometheusEvent.labels.endpoint
              }: ${latencyMs.toFixed(0)}ms`
            );
          }
        }
      }

      const sloStatus = maxLatency <= this.sloDefinitions.latency.target;
      console.log(`  P99 Latency: ${maxLatency.toFixed(0)}ms`);
      console.log(`  Target: ${this.sloDefinitions.latency.target}ms`);
      console.log(`  Status: ${sloStatus ? "✅ PASSING" : "❌ VIOLATION"}`);

      if (violationCount > 0) {
        console.log(
          `  Violations: ${violationCount} endpoints exceeding target`
        );
        await this.investigateLatencyIssue();
      }
    } catch (error) {
      console.error("  Error checking latency SLO:", error.message);
    }
  }

  async checkErrorRateSLO() {
    console.log("\n❗ Checking Error Rate SLO...");

    const query = `
      prometheus-prod(rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100)[10m]
        and on(service)
      loki-prod({level="error"})[10m]
    `;

    try {
      let totalErrorRate = 0;
      let sampleCount = 0;
      const errorsByService = new Map();

      for await (const correlation of this.executor.execute(query)) {
        const metricEvent = correlation.events.find(
          (e) => e.source === "prometheus-prod"
        );
        const logEvents = correlation.events.filter(
          (e) => e.source === "loki-prod"
        );

        if (metricEvent) {
          const errorRate = parseFloat(metricEvent.labels.__value__);
          totalErrorRate += errorRate;
          sampleCount++;

          if (errorRate > this.sloDefinitions.errorRate.target) {
            const service = correlation.joinValue;
            errorsByService.set(service, {
              rate: errorRate,
              logCount: logEvents.length,
              sampleLog: logEvents[0]?.message,
            });
          }
        }
      }

      const avgErrorRate = sampleCount > 0 ? totalErrorRate / sampleCount : 0;
      const sloStatus = avgErrorRate <= this.sloDefinitions.errorRate.target;

      console.log(`  Current: ${avgErrorRate.toFixed(3)}%`);
      console.log(`  Target: ${this.sloDefinitions.errorRate.target}%`);
      console.log(`  Status: ${sloStatus ? "✅ PASSING" : "❌ VIOLATION"}`);

      if (errorsByService.size > 0) {
        console.log("\n  Services with high error rates:");
        for (const [service, data] of errorsByService) {
          console.log(
            `    - ${service}: ${data.rate.toFixed(3)}% (${
              data.logCount
            } error logs)`
          );
          if (data.sampleLog) {
            console.log(
              `      Sample: "${data.sampleLog.substring(0, 80)}..."`
            );
          }
        }
      }
    } catch (error) {
      console.error("  Error checking error rate SLO:", error.message);
    }
  }

  async checkThroughputSLO() {
    console.log("\n📈 Checking Throughput SLO...");

    const query = `
      prometheus-prod(sum(rate(http_requests_total[1m])))[5m]
        or on(service)
      influxdb-prod(SELECT sum(request_count) FROM api_metrics GROUP BY time(1m))[5m]
    `;

    try {
      let minThroughput = Infinity;
      let avgThroughput = 0;
      let sampleCount = 0;

      for await (const event of this.executor.execute(query)) {
        if (event.labels && event.labels.__value__) {
          const throughput = parseFloat(event.labels.__value__);
          minThroughput = Math.min(minThroughput, throughput);
          avgThroughput += throughput;
          sampleCount++;
        }
      }

      avgThroughput = sampleCount > 0 ? avgThroughput / sampleCount : 0;
      const sloStatus = minThroughput >= this.sloDefinitions.throughput.target;

      console.log(`  Current Average: ${avgThroughput.toFixed(0)} req/s`);
      console.log(
        `  Current Minimum: ${
          minThroughput === Infinity ? 0 : minThroughput.toFixed(0)
        } req/s`
      );
      console.log(`  Target: ${this.sloDefinitions.throughput.target} req/s`);
      console.log(`  Status: ${sloStatus ? "✅ PASSING" : "❌ VIOLATION"}`);

      if (!sloStatus) {
        await this.investigateThroughputIssue();
      }
    } catch (error) {
      console.error("  Error checking throughput SLO:", error.message);
    }
  }

  async investigateAvailabilityIssue() {
    console.log("\n  🔍 Investigating availability issue...");

    const query = `
      graylog-prod(level:error AND (message:"connection refused" OR message:"timeout"))[10m]
        and on(host)
      influxdb-prod(SELECT * FROM system_metrics WHERE cpu > 90 OR memory > 90)[10m]
    `;

    try {
      for await (const correlation of this.executor.execute(query)) {
        console.log(`    Found correlation on host: ${correlation.joinValue}`);
        const logEvent = correlation.events.find(
          (e) => e.source === "graylog-prod"
        );
        const metricEvent = correlation.events.find(
          (e) => e.source === "influxdb-prod"
        );

        if (logEvent && metricEvent) {
          console.log(`      Error: ${logEvent.message}`);
          console.log(
            `      Resources: CPU=${metricEvent.labels.cpu}%, Memory=${metricEvent.labels.memory}%`
          );
        }
        break; // Just show first correlation
      }
    } catch (error) {
      console.error("    Investigation failed:", error.message);
    }
  }

  async investigateLatencyIssue() {
    console.log("\n  🔍 Investigating latency issue...");

    const query = `
      influxdb-prod(SELECT * FROM db_queries WHERE duration > 500)[10m]
        and on(trace_id)
      loki-prod({job="api"} |~ "slow|timeout|latency")[10m]
    `;

    try {
      let slowQueryCount = 0;
      for await (const correlation of this.executor.execute(query)) {
        slowQueryCount++;
        if (slowQueryCount === 1) {
          console.log(
            `    Found ${correlation.events.length} slow database queries correlated with API logs`
          );
          const dbEvent = correlation.events.find(
            (e) => e.source === "influxdb-prod"
          );
          if (dbEvent) {
            console.log(
              `      Slow query: ${dbEvent.labels.query_type} took ${dbEvent.labels.duration}ms`
            );
          }
        }
      }
      if (slowQueryCount > 0) {
        console.log(`    Total slow query correlations: ${slowQueryCount}`);
      }
    } catch (error) {
      console.error("    Investigation failed:", error.message);
    }
  }

  async investigateThroughputIssue() {
    console.log("\n  🔍 Investigating throughput issue...");

    const query = `
      prometheus-prod(up{job="api"})[5m]
        and on(instance)
      graylog-prod(level:warn AND message:"rate limit")[5m]
    `;

    try {
      for await (const correlation of this.executor.execute(query)) {
        console.log(
          `    Instance ${correlation.joinValue} may be rate limited`
        );
        const logEvents = correlation.events.filter(
          (e) => e.source === "graylog-prod"
        );
        console.log(`      Found ${logEvents.length} rate limit warnings`);
        break;
      }
    } catch (error) {
      console.error("    Investigation failed:", error.message);
    }
  }

  async continuousMonitoring() {
    console.log(
      "\n🔄 Starting continuous SLO monitoring (press Ctrl+C to stop)...\n"
    );

    // In production, this would run continuously
    setInterval(async () => {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`\n[${timestamp}] Running SLO checks...`);

      // Quick status check for each SLO
      await this.quickStatusCheck();
    }, 60000); // Check every minute
  }

  async quickStatusCheck() {
    // Simplified status check for continuous monitoring
    const statuses = {
      availability: "✅",
      latency: "✅",
      errorRate: "⚠️",
      throughput: "✅",
    };

    console.log(
      `  Availability: ${statuses.availability}  Latency: ${statuses.latency}  Errors: ${statuses.errorRate}  Throughput: ${statuses.throughput}`
    );
  }

  calculateAverage(events, field) {
    const values = events
      .map((e) => parseFloat(e.labels?.[field] || 0))
      .filter((v) => !isNaN(v));

    return values.length > 0
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;
  }

  reportSummary() {
    console.log("\n" + "=".repeat(60));
    console.log("📊 SLO MONITORING SUMMARY");
    console.log("=".repeat(60));

    console.log("\nSLO Definitions:");
    for (const [name, slo] of Object.entries(this.sloDefinitions)) {
      console.log(`  ${name}: ${slo.description}`);
    }

    console.log("\n💡 Key Insights:");
    console.log("  • Correlating metrics with logs provides deeper insights");
    console.log(
      "  • Multi-source correlation helps identify root causes faster"
    );
    console.log("  • Real-time monitoring enables proactive incident response");

    console.log("\n🚀 Next Steps:");
    console.log("  • Set up automated alerting based on SLO violations");
    console.log("  • Create dashboards visualizing correlated data");
    console.log("  • Implement automated remediation for common issues");
  }
}

// Run the SLO monitoring example
async function main() {
  const monitor = new SLOMonitor();
  await monitor.monitorSLOs();
}

main().catch(console.error);
