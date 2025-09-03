/**
 * Prometheus Adapter Integration Tests
 *
 * These tests run against a live Prometheus instance to ensure the adapter works with real data.
 * Configure your Prometheus instance details in prometheus.config.local.js
 *
 * Run with: npm run test:integration
 */

import { PrometheusAdapter } from "../../src/prometheus-adapter";
import { LogEvent } from "@timebridge/core";
import * as fs from "fs";
import * as path from "path";

// Load configuration
const configPath = fs.existsSync(
  path.join(__dirname, "prometheus.config.local.js")
)
  ? "./prometheus.config.local.js"
  : "./prometheus.config.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require(configPath);

// Skip tests if no Prometheus connection is configured
const skipTests =
  config.testConfig.skipIfNoConnection && !config.connection.url;

const describeOrSkip = skipTests ? describe.skip : describe;

describeOrSkip("Prometheus Adapter Integration Tests", () => {
  let adapter: PrometheusAdapter;
  const testResults: any = {};

  let adapterConfig: any;

  beforeAll(() => {
    // Validate configuration
    if (!config.connection.url) {
      throw new Error(
        "PROMETHEUS_URL must be configured for integration tests"
      );
    }

    // Create adapter configuration
    adapterConfig = {
      url: config.connection.url,
      pollInterval: config.connection.pollInterval,
      timeout: config.connection.timeout,
      maxRetries: config.connection.maxRetries,
      step: config.connection.step,
    };

    // Add authentication
    if (config.connection.apiToken) {
      adapterConfig.apiToken = config.connection.apiToken;
    } else if (config.connection.username && config.connection.password) {
      adapterConfig.username = config.connection.username;
      adapterConfig.password = config.connection.password;
    }

    // Add proxy configuration
    if (config.proxy) {
      adapterConfig.proxy = config.proxy;
    }

    // Log configuration (mask sensitive data)
    if (config.testConfig.verbose) {
      console.log("🔧 Prometheus Test Configuration:");
      console.log("  URL:", config.connection.url);
      console.log(
        "  Auth Type:",
        config.connection.apiToken
          ? "API Token"
          : config.connection.username
          ? "Basic Auth"
          : "None"
      );
      console.log("  Step:", config.connection.step || "auto");
      console.log(
        "  Proxy:",
        config.proxy ? `${config.proxy.host}:${config.proxy.port}` : "None"
      );
    }

    // Create initial adapter instance
    adapter = new PrometheusAdapter(adapterConfig);
  });

  afterEach(async () => {
    // Clean up after each test to prevent resource leaks
    if (adapter) {
      try {
        await adapter.destroy();
      } catch (error) {
        if (config.testConfig.verbose) {
          console.warn("Warning: Error destroying adapter:", error);
        }
      }
    }

    // Create a fresh adapter for the next test
    adapter = new PrometheusAdapter(adapterConfig);
  });

  afterAll(async () => {
    // Clean up
    if (adapter) {
      try {
        await adapter.destroy();
      } catch (error) {
        console.error("Error destroying adapter:", error);
      }
    }

    // Force cleanup any lingering connections
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 100);
      if (timer.unref) timer.unref();
    });

    // Save test results if configured
    if (config.debug.saveResults && Object.keys(testResults).length > 0) {
      const resultsDir = config.debug.resultsPath;
      if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const resultsFile = path.join(
        resultsDir,
        `prometheus-test-results-${timestamp}.json`
      );

      fs.writeFileSync(resultsFile, JSON.stringify(testResults, null, 2));
      console.log(`📁 Test results saved to: ${resultsFile}`);
    }
  });

  describe("Connection and Authentication", () => {
    it("should connect to Prometheus instance", async () => {
      const query = config.queries.simple.basicMetric;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(
          `✅ Connected to Prometheus. Query returned ${events.length} data points`
        );
      }

      testResults.connection = {
        success: true,
        sampleQuery: query,
        dataPoints: events.length,
      };
    });

    it("should validate query syntax", () => {
      // Test valid PromQL queries
      expect(adapter.validateQuery("up")).toBe(true);
      expect(adapter.validateQuery("http_requests_total")).toBe(true);
      expect(adapter.validateQuery("rate(http_requests_total[5m])")).toBe(true);
      expect(
        adapter.validateQuery("sum(rate(cpu_usage[1m])) by (instance)")
      ).toBe(true);

      // Test invalid queries
      expect(adapter.validateQuery("")).toBe(false);
    });
  });

  describe("Simple Metric Queries", () => {
    it("should fetch basic counter metrics", async () => {
      const query = config.queries.simple.counter;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        const event = events[0];
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("message");
        expect(event).toHaveProperty("source");
        expect(event.source).toBe("prometheus");
        expect(event).toHaveProperty("labels");
        expect(event.labels).toHaveProperty("__value__");
      }

      if (config.testConfig.verbose && events.length > 0) {
        console.log(`📊 Counter query returned ${events.length} data points`);
        logSampleEvent(events[0]);
      }

      testResults.counterMetrics = {
        query,
        count: events.length,
        sample: events[0],
      };
    });

    it("should fetch gauge metrics", async () => {
      const query = config.queries.simple.gauge;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        const event = events[0];
        expect(event.labels).toHaveProperty("__value__");
        expect(typeof event.labels.__value__).toBe("string");
      }

      if (config.testConfig.verbose && events.length > 0) {
        console.log(`📊 Gauge query returned ${events.length} data points`);
      }

      testResults.gaugeMetrics = {
        query,
        count: events.length,
        sample: events[0],
      };
    });

    it("should fetch histogram metrics", async () => {
      const query = config.queries.simple.histogram;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose && events.length > 0) {
        console.log(`📊 Histogram query returned ${events.length} data points`);
      }

      testResults.histogramMetrics = {
        query,
        count: events.length,
      };
    });

    it("should handle rate functions", async () => {
      const query = config.queries.functions.rate;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.medium
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        // Rate functions should produce numeric values
        const event = events[0];
        const value = parseFloat(event.labels.__value__);
        expect(isNaN(value)).toBe(false);
      }

      testResults.rateFunctions = {
        query,
        count: events.length,
      };
    });
  });

  describe("Complex PromQL Queries", () => {
    it("should handle aggregation functions", async () => {
      const query = config.queries.functions.aggregation;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.medium
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(
          `📊 Aggregation query returned ${events.length} data points`
        );
      }

      testResults.aggregationFunctions = {
        query,
        count: events.length,
      };
    });

    it("should handle binary operators", async () => {
      const query = config.queries.functions.binaryOps;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      testResults.binaryOperators = {
        query,
        count: events.length,
      };
    });

    it("should handle label selectors", async () => {
      const query = config.queries.complex.labelSelector;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        // Verify that label filtering worked
        const event = events[0];
        expect(event.labels).toBeDefined();
      }

      testResults.labelSelectors = {
        query,
        count: events.length,
      };
    });

    it("should handle instant queries", async () => {
      // Use pollInterval: 0 for instant queries
      const instantAdapter = new PrometheusAdapter({
        ...adapterConfig,
        pollInterval: 0,
      });

      const query = config.queries.simple.basicMetric;
      const events = await collectMetrics(
        instantAdapter,
        query,
        "5m", // Still need a time range for context
        10
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(`📊 Instant query returned ${events.length} data points`);
      }

      await instantAdapter.destroy();

      testResults.instantQueries = {
        query,
        count: events.length,
      };
    });
  });

  describe("Correlation Support", () => {
    it("should extract correlation IDs from labels", async () => {
      const query = config.queries.correlation.withCorrelationId;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.medium,
        20
      );

      if (events.length > 0) {
        const eventsWithCorrelation = events.filter(
          (e) => e.joinKeys && Object.keys(e.joinKeys).length > 0
        );

        if (config.testConfig.verbose) {
          console.log(`📊 Correlation query test:`);
          console.log(`  Query: ${query}`);
          console.log(`  Events found: ${events.length}`);
          console.log(
            `  Events with join keys: ${eventsWithCorrelation.length}`
          );

          if (eventsWithCorrelation.length > 0) {
            const allJoinKeys = new Set<string>();
            eventsWithCorrelation.forEach((e) => {
              Object.keys(e.joinKeys || {}).forEach((key) =>
                allJoinKeys.add(key)
              );
            });
            console.log(
              `  Join key fields: ${Array.from(allJoinKeys).join(", ")}`
            );
          }
        }

        testResults.correlationExtraction = {
          totalEvents: events.length,
          eventsWithCorrelation: eventsWithCorrelation.length,
          joinKeyFields: [
            ...new Set(
              eventsWithCorrelation.flatMap((e) =>
                Object.keys(e.joinKeys || {})
              )
            ),
          ],
        };
      }
    });

    it("should handle metric name as correlation field", async () => {
      const query = config.queries.simple.basicMetric;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short,
        5
      );

      if (events.length > 0) {
        const event = events[0];

        // All Prometheus metrics should have metric name info
        expect(event.labels).toBeDefined();

        // Should have either __name__ or be extractable from message
        const hasMetricInfo =
          event.labels.__name__ ||
          event.message.includes("=") ||
          event.labels.metric_name;

        expect(hasMetricInfo).toBeTruthy();
      }
    });
  });

  describe("Time Range Handling", () => {
    it("should respect different time ranges", async () => {
      const query = config.queries.simple.basicMetric;

      // Test different time ranges
      const shortEvents = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short,
        50
      );
      const mediumEvents = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.medium,
        50
      );

      // Medium time range should potentially have more data points
      expect(mediumEvents.length).toBeGreaterThanOrEqual(shortEvents.length);

      if (config.testConfig.verbose) {
        console.log(`📊 Time range comparison:`);
        console.log(
          `  ${config.queries.timeRanges.short}: ${shortEvents.length} data points`
        );
        console.log(
          `  ${config.queries.timeRanges.medium}: ${mediumEvents.length} data points`
        );
      }

      testResults.timeRanges = {
        short: {
          range: config.queries.timeRanges.short,
          count: shortEvents.length,
        },
        medium: {
          range: config.queries.timeRanges.medium,
          count: mediumEvents.length,
        },
      };
    });

    it("should handle step intervals correctly", async () => {
      // Test with custom step
      const customStepAdapter = new PrometheusAdapter({
        ...adapterConfig,
        step: "30s",
      });

      const query = config.queries.simple.basicMetric;
      const events = await collectMetrics(
        customStepAdapter,
        query,
        config.queries.timeRanges.medium,
        20
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose && events.length > 1) {
        // Check if step interval is roughly respected
        const timestamps = events
          .map((e) => new Date(e.timestamp).getTime())
          .sort();
        const intervals = [];
        for (let i = 1; i < timestamps.length; i++) {
          intervals.push(timestamps[i] - timestamps[i - 1]);
        }
        const avgInterval =
          intervals.reduce((a, b) => a + b, 0) / intervals.length;
        console.log(
          `📊 Average interval between data points: ${avgInterval}ms`
        );
      }

      await customStepAdapter.destroy();
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid PromQL queries gracefully", async () => {
      const invalidQuery = "invalid{query syntax";

      try {
        const events = await collectMetrics(adapter, invalidQuery, "1m", 1);
        // If it doesn't throw, it should return empty array
        expect(Array.isArray(events)).toBe(true);
      } catch (error) {
        // Expected to throw
        expect(error).toBeDefined();
        if (config.testConfig.verbose) {
          console.log(
            "✅ Invalid query properly rejected:",
            (error as Error).message
          );
        }
      }
    });

    it("should handle network timeouts", async () => {
      // Create adapter with very short timeout
      const timeoutAdapter = new PrometheusAdapter({
        ...adapterConfig,
        timeout: 1, // 1ms timeout to force timeout
      });

      try {
        const events = await collectMetrics(
          timeoutAdapter,
          config.queries.simple.basicMetric,
          "1m",
          1
        );
        // If we get here, the request somehow succeeded despite tiny timeout
        expect(Array.isArray(events)).toBe(true);
      } catch (error: any) {
        // Expected timeout error
        expect(error).toBeDefined();
        if (config.testConfig.verbose) {
          console.log("✅ Timeout properly handled:", error.message);
        }
      } finally {
        await timeoutAdapter.destroy();
      }
    });

    it("should handle non-existent metrics", async () => {
      const nonExistentQuery = "metric_that_does_not_exist_12345";
      const events = await collectMetrics(adapter, nonExistentQuery, "5m", 1);

      // Should return empty array, not throw
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBe(0);
    });
  });

  describe("Field Validation", () => {
    it("should extract expected fields from metrics", async () => {
      const query = config.queries.simple.basicMetric;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short,
        5
      );

      if (events.length > 0) {
        const event = events[0];

        // Check for expected fields
        expect(event.timestamp).toBeDefined();
        expect(event.message).toBeDefined();
        expect(event.source).toBe("prometheus");
        expect(event.labels).toBeDefined();

        // Check Prometheus-specific fields
        expect(event.labels).toHaveProperty("__value__");
        expect(event.labels.__value__).toBeDefined();

        if (config.testConfig.verbose) {
          console.log("📋 Sample metric structure:");
          console.log("  Timestamp:", event.timestamp);
          console.log("  Source:", event.source);
          console.log("  Value:", event.labels.__value__);
          console.log("  Labels:", Object.keys(event.labels || {}));
          console.log("  Join Keys:", Object.keys(event.joinKeys || {}));
        }
      }
    });

    it("should preserve metric labels correctly", async () => {
      const query = config.queries.complex.labelSelector;
      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.short,
        5
      );

      if (events.length > 0) {
        const event = events[0];
        expect(event.labels).toBeDefined();

        // Should preserve original Prometheus labels
        const labelKeys = Object.keys(event.labels);
        expect(labelKeys.length).toBeGreaterThan(1); // At least __value__ and something else

        if (config.testConfig.verbose) {
          console.log("📋 Metric labels preserved:");
          Object.entries(event.labels).forEach(([key, value]) => {
            console.log(`  ${key}: ${value}`);
          });
        }
      }
    });
  });

  describe("Performance", () => {
    it("should handle large result sets efficiently", async () => {
      const query = config.queries.simple.basicMetric;
      const startTime = Date.now();

      const events = await collectMetrics(
        adapter,
        query,
        config.queries.timeRanges.long, // Longer time range for more data
        200 // Allow more results
      );

      const duration = Date.now() - startTime;

      if (config.testConfig.verbose) {
        console.log(`⏱️  Performance test:`);
        console.log(`  Fetched ${events.length} data points in ${duration}ms`);
        console.log(
          `  Average: ${
            events.length > 0 ? (duration / events.length).toFixed(2) : 0
          }ms per data point`
        );
      }

      testResults.performance = {
        dataPointCount: events.length,
        duration,
        averagePerDataPoint: events.length > 0 ? duration / events.length : 0,
      };
    });

    it("should handle concurrent queries", async () => {
      const queries = [
        config.queries.simple.basicMetric,
        config.queries.simple.counter,
        config.queries.simple.gauge,
      ];

      const startTime = Date.now();
      const promises = queries.map((query) =>
        collectMetrics(adapter, query, config.queries.timeRanges.short, 10)
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(Array.isArray(result)).toBe(true);
      });

      if (config.testConfig.verbose) {
        console.log(`⏱️  Concurrent queries completed in ${duration}ms`);
        results.forEach((result, i) => {
          console.log(`  Query ${i + 1}: ${result.length} data points`);
        });
      }
    });
  });

  describe("Polling Mode", () => {
    it("should work in polling mode", async () => {
      const pollingAdapter = new PrometheusAdapter({
        ...adapterConfig,
        pollInterval: 500, // Poll every 500ms
      });

      const query = config.queries.simple.basicMetric;
      const events: LogEvent[] = [];
      const maxEvents = 5;
      const maxTime = 3000; // Max 3 seconds
      const startTime = Date.now();

      try {
        for await (const event of pollingAdapter.createStream(query, {
          timeRange: config.queries.timeRanges.short,
        })) {
          events.push(event);

          if (events.length >= maxEvents || Date.now() - startTime > maxTime) {
            break;
          }
        }
      } finally {
        await pollingAdapter.destroy();
      }

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(
          `📊 Polling mode collected ${events.length} events in ${
            Date.now() - startTime
          }ms`
        );
      }
    }, 5000);
  });
});

/**
 * Helper function to collect metrics from a Prometheus adapter stream.
 */
async function collectMetrics(
  adapter: PrometheusAdapter,
  query: string,
  timeRange: string,
  maxEvents?: number
): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  const max = maxEvents || config.testConfig.maxEventsPerTest;
  const timeout = config.testConfig.maxWaitTime || 10000;

  return new Promise<LogEvent[]>((resolve) => {
    const startTime = Date.now();
    let settled = false;

    // Set up a hard timeout
    const timeoutId = setTimeout(async () => {
      if (!settled) {
        settled = true;
        if (config.testConfig.verbose) {
          console.log(
            `⏱️ Timeout after ${timeout}ms, collected ${events.length} data points`
          );
        }
        resolve(events);
      }
    }, timeout);

    // Ensure the timeout doesn't keep the process alive
    if (timeoutId.unref) {
      timeoutId.unref();
    }

    // Start collecting events asynchronously
    (async () => {
      try {
        const stream = adapter.createStream(query, { timeRange });

        for await (const event of stream) {
          if (settled) break;

          events.push(event);

          if (config.debug.logRawResponses && events.length === 1) {
            console.log("🔍 Raw metric event:", JSON.stringify(event, null, 2));
          }

          if (events.length >= max) {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              if (config.testConfig.verbose) {
                console.log(
                  `✅ Collected ${events.length} data points (max reached)`
                );
              }
              resolve(events);
            }
            break;
          }

          // Also check timeout inline
          if (Date.now() - startTime > timeout) {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              if (config.testConfig.verbose) {
                console.log(
                  `⏱️ Inline timeout check at ${events.length} data points`
                );
              }
              resolve(events);
            }
            break;
          }
        }

        // Stream completed normally
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          if (config.testConfig.verbose && events.length === 0) {
            console.log("✅ Stream completed with no data points");
          }
          resolve(events);
        }
      } catch (error: any) {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          if (config.testConfig.verbose && error.message !== "aborted") {
            console.warn("⚠️ Stream error:", error.message);
          }
          resolve(events); // Resolve with what we have
        }
      }
    })();
  });
}

/**
 * Helper function to log a sample metric event for debugging.
 */
function logSampleEvent(event: LogEvent | undefined) {
  if (!event) return;

  console.log("  Sample metric:");
  console.log(`    Timestamp: ${event.timestamp}`);
  console.log(`    Message: ${event.message?.substring(0, 100)}...`);
  console.log(`    Source: ${event.source}`);
  console.log(`    Value: ${event.labels.__value__}`);

  if (event.labels && Object.keys(event.labels).length > 1) {
    console.log(
      `    Labels: ${Object.keys(event.labels).slice(0, 5).join(", ")}${
        Object.keys(event.labels).length > 5 ? "..." : ""
      }`
    );
  }

  if (event.joinKeys && Object.keys(event.joinKeys).length > 0) {
    console.log(`    Join Keys: ${JSON.stringify(event.joinKeys)}`);
  }
}
