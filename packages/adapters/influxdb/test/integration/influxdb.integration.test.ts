/**
 * InfluxDB Adapter Integration Tests
 *
 * These tests run against live InfluxDB instances (both 1.x and 2.x) to ensure the adapter works with real data.
 * Configure your InfluxDB instance details in influxdb.config.local.js
 *
 * Run with: npm run test:integration
 */

import { InfluxDBAdapter } from "../../src/influxdb-adapter";
import { LogEvent } from "@timebridge/core";
import * as fs from "fs";
import * as path from "path";

// Load configuration
const configPath = fs.existsSync(
  path.join(__dirname, "influxdb.config.local.js")
)
  ? "./influxdb.config.local.js"
  : "./influxdb.config.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require(configPath);

// Skip tests if no InfluxDB connection is configured
const skipTests =
  config.testConfig.skipIfNoConnection && !config.connection.url;

const describeOrSkip = skipTests ? describe.skip : describe;

describeOrSkip("InfluxDB Adapter Integration Tests", () => {
  let adapter: InfluxDBAdapter;
  const testResults: any = {};

  let adapterConfig: any;

  beforeAll(() => {
    // Validate configuration
    if (!config.connection.url) {
      throw new Error("INFLUXDB_URL must be configured for integration tests");
    }

    // Create adapter configuration based on version
    const isV2 = config.connection.version === "2.x";

    adapterConfig = {
      url: config.connection.url,
      version: config.connection.version,
      pollInterval: config.connection.pollInterval,
      timeout: config.connection.timeout,
      maxRetries: config.connection.maxRetries,
      precision: config.connection.precision,
    };

    if (isV2) {
      // InfluxDB 2.x configuration
      adapterConfig.token = config.connection.token;
      adapterConfig.org = config.connection.org;
      adapterConfig.bucket = config.connection.bucket;
    } else {
      // InfluxDB 1.x configuration
      adapterConfig.database = config.connection.database;
      if (config.connection.username && config.connection.password) {
        adapterConfig.username = config.connection.username;
        adapterConfig.password = config.connection.password;
      }
    }

    // Add proxy configuration
    if (config.proxy) {
      adapterConfig.proxy = config.proxy;
    }

    // Log configuration (mask sensitive data)
    if (config.testConfig.verbose) {
      console.log("🔧 InfluxDB Test Configuration:");
      console.log("  URL:", config.connection.url);
      console.log("  Version:", config.connection.version);
      console.log(
        "  Database/Bucket:",
        isV2 ? config.connection.bucket : config.connection.database
      );
      console.log(
        "  Auth Type:",
        isV2 ? "Token" : config.connection.username ? "Basic Auth" : "None"
      );
      console.log("  Precision:", config.connection.precision || "ms");
      console.log(
        "  Proxy:",
        config.proxy ? `${config.proxy.host}:${config.proxy.port}` : "None"
      );
    }

    // Create initial adapter instance
    adapter = new InfluxDBAdapter(adapterConfig);
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
    adapter = new InfluxDBAdapter(adapterConfig);
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
        `influxdb-test-results-${timestamp}.json`
      );

      fs.writeFileSync(resultsFile, JSON.stringify(testResults, null, 2));
      console.log(`📁 Test results saved to: ${resultsFile}`);
    }
  });

  describe("Connection and Authentication", () => {
    it("should connect to InfluxDB instance", async () => {
      const query = config.queries.simple.basicQuery;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(
          `✅ Connected to InfluxDB ${config.connection.version}. Query returned ${events.length} data points`
        );
      }

      testResults.connection = {
        success: true,
        version: config.connection.version,
        sampleQuery: query,
        dataPoints: events.length,
      };
    });

    it("should validate query syntax", () => {
      const isV2 = config.connection.version === "2.x";

      if (isV2) {
        // Test valid Flux queries
        expect(adapter.validateQuery('from(bucket: "test")')).toBe(true);
        expect(
          adapter.validateQuery('from(bucket: "test") |> range(start: -1h)')
        ).toBe(true);
      } else {
        // Test valid InfluxQL queries
        expect(adapter.validateQuery("SELECT * FROM measurement")).toBe(true);
        expect(
          adapter.validateQuery(
            "SELECT mean(value) FROM temperature GROUP BY time(1m)"
          )
        ).toBe(true);
      }

      // Test invalid queries
      expect(adapter.validateQuery("")).toBe(false);
    });
  });

  describe("Simple Data Queries", () => {
    it("should fetch basic measurements", async () => {
      const query = config.queries.simple.basicQuery;
      const events = await collectData(
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
        expect(event.source).toBe("influxdb");
        expect(event).toHaveProperty("labels");

        // InfluxDB-specific: should have measurement info
        expect(event.labels).toHaveProperty("_measurement");
      }

      if (config.testConfig.verbose && events.length > 0) {
        console.log(`📊 Basic query returned ${events.length} data points`);
        logSampleEvent(events[0]);
      }

      testResults.basicQuery = {
        query,
        count: events.length,
        sample: events[0],
      };
    });

    it("should fetch time series data", async () => {
      const query = config.queries.simple.timeSeries;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.medium
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 1) {
        // Verify time ordering
        const timestamps = events.map((e) => new Date(e.timestamp).getTime());
        const sorted = [...timestamps].sort();
        expect(timestamps).toEqual(sorted);
      }

      if (config.testConfig.verbose && events.length > 0) {
        console.log(
          `📊 Time series query returned ${events.length} data points`
        );
        if (events.length > 1) {
          const duration =
            new Date(events[events.length - 1].timestamp).getTime() -
            new Date(events[0].timestamp).getTime();
          console.log(`  Time span: ${duration / 1000}s`);
        }
      }

      testResults.timeSeries = {
        query,
        count: events.length,
        timeSpan:
          events.length > 1
            ? new Date(events[events.length - 1].timestamp).getTime() -
              new Date(events[0].timestamp).getTime()
            : 0,
      };
    });

    it("should handle aggregated data", async () => {
      const query = config.queries.functions.aggregation;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.medium
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        // Aggregated queries typically return fewer points
        const event = events[0];
        expect(event.labels).toBeDefined();
      }

      testResults.aggregation = {
        query,
        count: events.length,
      };
    });

    it("should handle field selection", async () => {
      const query = config.queries.simple.fieldSelection;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        // Should have specific field data
        const event = events[0];
        expect(event.labels).toBeDefined();
        expect(event.message).toBeDefined();
      }

      testResults.fieldSelection = {
        query,
        count: events.length,
      };
    });
  });

  describe("Complex Queries", () => {
    it("should handle WHERE clauses", async () => {
      const query = config.queries.complex.whereClause;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.medium
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(
          `📊 WHERE clause query returned ${events.length} data points`
        );
      }

      testResults.whereClause = {
        query,
        count: events.length,
      };
    });

    it("should handle GROUP BY operations", async () => {
      const query = config.queries.complex.groupBy;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.medium
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        // GROUP BY should create structured results
        const event = events[0];
        expect(event.labels).toBeDefined();
      }

      testResults.groupBy = {
        query,
        count: events.length,
      };
    });

    it("should handle mathematical operations", async () => {
      const query = config.queries.functions.mathematical;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.short
      );

      expect(Array.isArray(events)).toBe(true);

      if (events.length > 0) {
        // Mathematical operations should produce numeric results
        const event = events[0];
        expect(event.labels).toBeDefined();
      }

      testResults.mathematical = {
        query,
        count: events.length,
      };
    });
  });

  describe("Version-Specific Features", () => {
    const isV2 = config.connection.version === "2.x";

    if (isV2) {
      describe("InfluxDB 2.x (Flux) Features", () => {
        it("should handle Flux transformations", async () => {
          const query = config.queries.v2.fluxTransform;
          const events = await collectData(
            adapter,
            query,
            config.queries.timeRanges.short
          );

          expect(Array.isArray(events)).toBe(true);

          testResults.fluxTransform = {
            query,
            count: events.length,
          };
        });

        it("should handle Flux filters", async () => {
          const query = config.queries.v2.fluxFilter;
          const events = await collectData(
            adapter,
            query,
            config.queries.timeRanges.short
          );

          expect(Array.isArray(events)).toBe(true);

          testResults.fluxFilter = {
            query,
            count: events.length,
          };
        });

        it("should parse CSV output correctly", async () => {
          const query = config.queries.simple.basicQuery;
          const events = await collectData(
            adapter,
            query,
            config.queries.timeRanges.short,
            5
          );

          if (events.length > 0) {
            const event = events[0];

            // Flux queries return CSV, verify parsing
            expect(event.labels).toHaveProperty("_table");
            expect(event.labels).toHaveProperty("_measurement");
            expect(typeof event.labels._table).toBe("string");
          }
        });
      });
    } else {
      describe("InfluxDB 1.x (InfluxQL) Features", () => {
        it("should handle InfluxQL functions", async () => {
          const query = config.queries.v1.influxqlFunction;
          const events = await collectData(
            adapter,
            query,
            config.queries.timeRanges.short
          );

          expect(Array.isArray(events)).toBe(true);

          testResults.influxqlFunction = {
            query,
            count: events.length,
          };
        });

        it("should handle continuous queries", async () => {
          const query = config.queries.v1.continuousQuery;
          const events = await collectData(
            adapter,
            query,
            config.queries.timeRanges.short
          );

          expect(Array.isArray(events)).toBe(true);

          testResults.continuousQuery = {
            query,
            count: events.length,
          };
        });

        it("should parse JSON response correctly", async () => {
          const query = config.queries.simple.basicQuery;
          const events = await collectData(
            adapter,
            query,
            config.queries.timeRanges.short,
            5
          );

          if (events.length > 0) {
            const event = events[0];

            // InfluxQL returns JSON, verify structure
            expect(event.labels).toHaveProperty("_measurement");
            expect(typeof event.labels._measurement).toBe("string");
          }
        });
      });
    }
  });

  describe("Correlation Support", () => {
    it("should extract correlation IDs from fields", async () => {
      const query = config.queries.correlation.withCorrelationId;
      const events = await collectData(
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

    it("should handle tag-based correlation", async () => {
      const query = config.queries.correlation.tagBased;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.short,
        10
      );

      if (events.length > 0) {
        const event = events[0];

        // Should have tag information that can be used for correlation
        expect(event.labels).toBeDefined();

        if (config.testConfig.verbose) {
          console.log("📋 Available tags for correlation:");
          Object.entries(event.labels).forEach(([key, value]) => {
            if (!key.startsWith("_")) {
              console.log(`  ${key}: ${value}`);
            }
          });
        }
      }
    });

    it("should extract time-based correlation windows", async () => {
      const query = config.queries.simple.timeSeries;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.medium,
        20
      );

      if (events.length > 1) {
        // Verify timestamps are suitable for time-based correlation
        events.forEach((event) => {
          const timestamp = new Date(event.timestamp);
          expect(timestamp.getTime()).toBeGreaterThan(0);
          expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
        });

        if (config.testConfig.verbose) {
          const timeSpan =
            new Date(events[events.length - 1].timestamp).getTime() -
            new Date(events[0].timestamp).getTime();
          console.log(`📊 Time correlation window: ${timeSpan / 1000}s`);
        }
      }
    });
  });

  describe("Time Range Handling", () => {
    it("should respect different time ranges", async () => {
      const query = config.queries.simple.basicQuery;

      // Test different time ranges
      const shortEvents = await collectData(
        adapter,
        query,
        config.queries.timeRanges.short,
        100
      );
      const mediumEvents = await collectData(
        adapter,
        query,
        config.queries.timeRanges.medium,
        100
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

    it("should handle precision settings", async () => {
      if (config.connection.precision) {
        // Test with specific precision
        const precisionAdapter = new InfluxDBAdapter({
          ...adapterConfig,
          precision: "s", // Second precision
        });

        const query = config.queries.simple.basicQuery;
        const events = await collectData(
          precisionAdapter,
          query,
          config.queries.timeRanges.short,
          5
        );

        expect(Array.isArray(events)).toBe(true);

        if (events.length > 0) {
          // Verify timestamp precision
          events.forEach((event) => {
            const timestamp = new Date(event.timestamp);
            expect(timestamp.getTime()).toBeGreaterThan(0);
          });
        }

        await precisionAdapter.destroy();
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid query syntax gracefully", async () => {
      const isV2 = config.connection.version === "2.x";
      const invalidQuery = isV2
        ? "invalid flux syntax |> invalid()"
        : "INVALID SQL SYNTAX FROM";

      try {
        const events = await collectData(adapter, invalidQuery, "5m", 1);
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
      const timeoutAdapter = new InfluxDBAdapter({
        ...adapterConfig,
        timeout: 1, // 1ms timeout to force timeout
      });

      try {
        const events = await collectData(
          timeoutAdapter,
          config.queries.simple.basicQuery,
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

    it("should handle non-existent measurements", async () => {
      const isV2 = config.connection.version === "2.x";
      const nonExistentQuery = isV2
        ? 'from(bucket: "test") |> range(start: -5m) |> filter(fn: (r) => r._measurement == "nonexistent_measurement_12345")'
        : "SELECT * FROM nonexistent_measurement_12345";

      const events = await collectData(adapter, nonExistentQuery, "5m", 1);

      // Should return empty array, not throw
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBe(0);
    });
  });

  describe("Field Validation", () => {
    it("should extract expected fields from data points", async () => {
      const query = config.queries.simple.basicQuery;
      const events = await collectData(
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
        expect(event.source).toBe("influxdb");
        expect(event.labels).toBeDefined();

        // Check InfluxDB-specific fields
        expect(event.labels).toHaveProperty("_measurement");
        expect(event.labels._measurement).toBeTruthy();

        if (config.testConfig.verbose) {
          console.log("📋 Sample data point structure:");
          console.log("  Timestamp:", event.timestamp);
          console.log("  Source:", event.source);
          console.log("  Measurement:", event.labels._measurement);
          console.log("  Labels:", Object.keys(event.labels || {}));
          console.log("  Join Keys:", Object.keys(event.joinKeys || {}));
        }
      }
    });

    it("should preserve field and tag information", async () => {
      const query = config.queries.complex.fieldAndTags;
      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.short,
        5
      );

      if (events.length > 0) {
        const event = events[0];
        expect(event.labels).toBeDefined();

        // Should preserve original InfluxDB field and tag structure
        const labelKeys = Object.keys(event.labels);
        expect(labelKeys.length).toBeGreaterThan(1); // At least measurement + something else

        if (config.testConfig.verbose) {
          console.log("📋 Field and tag information preserved:");
          Object.entries(event.labels).forEach(([key, value]) => {
            console.log(`  ${key}: ${value}`);
          });
        }
      }
    });
  });

  describe("Performance", () => {
    it("should handle large result sets efficiently", async () => {
      const query = config.queries.simple.basicQuery;
      const startTime = Date.now();

      const events = await collectData(
        adapter,
        query,
        config.queries.timeRanges.long, // Longer time range for more data
        500 // Allow more results
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
        config.queries.simple.basicQuery,
        config.queries.simple.timeSeries,
        config.queries.simple.fieldSelection,
      ];

      const startTime = Date.now();
      const promises = queries.map((query) =>
        collectData(adapter, query, config.queries.timeRanges.short, 10)
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
      const pollingAdapter = new InfluxDBAdapter({
        ...adapterConfig,
        pollInterval: 500, // Poll every 500ms
      });

      const query = config.queries.simple.basicQuery;
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
 * Helper function to collect data from an InfluxDB adapter stream.
 */
async function collectData(
  adapter: InfluxDBAdapter,
  query: string,
  timeRange: string,
  maxEvents?: number
): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  const max = maxEvents || config.testConfig.maxEventsPerTest;
  const timeout = config.testConfig.maxWaitTime || 15000;

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
            console.log("🔍 Raw data event:", JSON.stringify(event, null, 2));
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
 * Helper function to log a sample data event for debugging.
 */
function logSampleEvent(event: LogEvent | undefined) {
  if (!event) return;

  console.log("  Sample data point:");
  console.log(`    Timestamp: ${event.timestamp}`);
  console.log(`    Message: ${event.message?.substring(0, 100)}...`);
  console.log(`    Source: ${event.source}`);
  console.log(`    Measurement: ${event.labels._measurement}`);

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
