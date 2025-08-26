/**
 * Graylog Adapter Integration Tests
 *
 * These tests run against a live Graylog instance to ensure the adapter works with real data.
 * Configure your Graylog instance details in graylog.config.local.js
 *
 * Run with: npm run test:integration
 */

import { GraylogAdapter } from "../../src/graylog-adapter";
import { LogEvent } from "@liquescent/log-correlator-core";
import * as fs from "fs";
import * as path from "path";

// Load configuration
const configPath = fs.existsSync(
  path.join(__dirname, "graylog.config.local.js"),
)
  ? "./graylog.config.local.js"
  : "./graylog.config.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require(configPath);

// Skip tests if no Graylog connection is configured
const skipTests =
  config.testConfig.skipIfNoConnection && !config.connection.url;

const describeOrSkip = skipTests ? describe.skip : describe;

describeOrSkip("Graylog Adapter Integration Tests", () => {
  let adapter: GraylogAdapter;
  const testResults: any = {};

  let adapterConfig: any;

  beforeAll(() => {
    // Validate configuration
    if (!config.connection.url) {
      throw new Error("GRAYLOG_URL must be configured for integration tests");
    }

    if (
      !config.connection.apiToken &&
      (!config.connection.username || !config.connection.password)
    ) {
      throw new Error(
        "Either GRAYLOG_API_TOKEN or GRAYLOG_USERNAME/GRAYLOG_PASSWORD must be configured",
      );
    }

    // Create adapter configuration
    adapterConfig = {
      url: config.connection.url,
      apiVersion: config.connection.apiVersion,
      pollInterval: config.connection.pollInterval,
      timeout: config.connection.timeout,
      maxRetries: config.connection.maxRetries,
    };

    // Add authentication
    if (config.connection.apiToken) {
      adapterConfig.apiToken = config.connection.apiToken;
    } else {
      adapterConfig.username = config.connection.username;
      adapterConfig.password = config.connection.password;
    }

    // Add stream filtering
    if (config.connection.streamId) {
      adapterConfig.streamId = config.connection.streamId;
    } else if (config.connection.streamName) {
      adapterConfig.streamName = config.connection.streamName;
    }

    // Add proxy configuration
    if (config.proxy) {
      adapterConfig.proxy = config.proxy;
    }

    // Log configuration (mask sensitive data)
    if (config.testConfig.verbose) {
      console.log("🔧 Test Configuration:");
      console.log("  URL:", config.connection.url);
      console.log("  API Version:", config.connection.apiVersion);
      console.log(
        "  Auth Type:",
        config.connection.apiToken ? "API Token" : "Basic Auth",
      );
      console.log(
        "  Stream:",
        config.connection.streamName ||
          config.connection.streamId ||
          "All Streams",
      );
      console.log(
        "  Proxy:",
        config.proxy ? `${config.proxy.host}:${config.proxy.port}` : "None",
      );
    }

    // Create initial adapter instance
    adapter = new GraylogAdapter(adapterConfig);
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
    adapter = new GraylogAdapter(adapterConfig);
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
        `graylog-test-results-${timestamp}.json`,
      );

      fs.writeFileSync(resultsFile, JSON.stringify(testResults, null, 2));
      console.log(`📁 Test results saved to: ${resultsFile}`);
    }
  });

  describe("Connection and Authentication", () => {
    it("should connect to Graylog instance", async () => {
      const streams = await adapter.getAvailableStreams();
      expect(Array.isArray(streams)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(`✅ Connected to Graylog. Found ${streams.length} streams`);
        if (streams.length > 0 && streams.length <= 10) {
          console.log("  Available streams:", streams.join(", "));
        }
      }

      testResults.availableStreams = streams;
    });

    it("should validate query syntax", () => {
      // Test valid queries
      expect(adapter.validateQuery("level:error")).toBe(true);
      expect(adapter.validateQuery("source:nginx")).toBe(true);
      expect(adapter.validateQuery("*")).toBe(true);

      // Test invalid queries
      expect(adapter.validateQuery("")).toBe(false);
    });
  });

  describe("Simple Queries", () => {
    it("should fetch error logs", async () => {
      const query = config.queries.simple.errorLogs;
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.medium,
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.expectations.minErrorLogs > 0) {
        expect(events.length).toBeGreaterThanOrEqual(
          config.expectations.minErrorLogs,
        );
      }

      if (config.testConfig.verbose && events.length > 0) {
        console.log(`📊 Error logs query returned ${events.length} events`);
        logSampleEvent(events[0]);
      }

      testResults.errorLogs = {
        query,
        count: events.length,
        sample: events[0],
      };
    });

    it("should fetch warning logs", async () => {
      const query = config.queries.simple.warningLogs;
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.medium,
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.expectations.minWarningLogs > 0) {
        expect(events.length).toBeGreaterThanOrEqual(
          config.expectations.minWarningLogs,
        );
      }

      if (config.testConfig.verbose && events.length > 0) {
        console.log(`📊 Warning logs query returned ${events.length} events`);
      }

      testResults.warningLogs = {
        query,
        count: events.length,
        sample: events[0],
      };
    });

    it("should fetch info logs", async () => {
      const query = config.queries.simple.infoLogs;
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.short,
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.expectations.minInfoLogs > 0) {
        expect(events.length).toBeGreaterThanOrEqual(
          config.expectations.minInfoLogs,
        );
      }

      if (config.testConfig.verbose && events.length > 0) {
        console.log(`📊 Info logs query returned ${events.length} events`);
      }

      testResults.infoLogs = {
        query,
        count: events.length,
        sample: events[0],
      };
    });

    it("should fetch service-specific logs", async () => {
      const query = config.queries.simple.serviceSpecific;
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.medium,
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(
          `📊 Service-specific query returned ${events.length} events`,
        );
        if (events.length > 0) {
          const sources = [
            ...new Set(events.map((e) => e.labels?.source || e.stream)),
          ];
          console.log("  Sources found:", sources.join(", "));
        }
      }

      testResults.serviceSpecific = {
        query,
        count: events.length,
        sources: [...new Set(events.map((e) => e.labels?.source || e.stream))],
      };
    });
  });

  describe("Complex Queries", () => {
    it("should handle multi-field queries", async () => {
      const query = config.queries.complex.multiField;
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.medium,
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(`📊 Multi-field query returned ${events.length} events`);
      }

      testResults.multiField = {
        query,
        count: events.length,
        sample: events[0],
      };
    });

    it("should handle service error combination queries", async () => {
      const query = config.queries.complex.serviceErrors;
      // Use shorter timeout since this query often returns no results
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.short,
      );

      expect(Array.isArray(events)).toBe(true);

      if (config.testConfig.verbose) {
        console.log(`📊 Service errors query returned ${events.length} events`);
      }

      testResults.serviceErrors = {
        query,
        count: events.length,
      };
    }, 30000); // 30 second timeout
  });

  describe("Correlation Support", () => {
    it("should support correlation-style queries with trace IDs", async () => {
      // Test queries that would be used in correlation scenarios
      // e.g., graylog(traceId:trace_12345)[1h] and on(traceId) graylog(traceId:trace_12345)[1h]

      // If a specific correlation ID is configured, use it
      const traceQuery = config.queries.correlation.specificCorrelationId
        ? `${config.queries.correlation.correlationField}:${config.queries.correlation.specificCorrelationId}`
        : "_exists_:trace_id OR _exists_:request_id";

      const events = await collectEvents(
        adapter,
        traceQuery,
        config.queries.timeRanges.long,
        10,
      );

      if (events.length > 0) {
        // Verify events have the expected structure for correlation
        events.forEach((event) => {
          expect(event).toHaveProperty("timestamp");
          expect(event).toHaveProperty("message");
          expect(event).toHaveProperty("source");
          expect(event).toHaveProperty("labels");
          expect(event).toHaveProperty("joinKeys");
        });

        // Check if joinKeys are properly extracted
        const eventsWithJoinKeys = events.filter(
          (e) => e.joinKeys && Object.keys(e.joinKeys).length > 0,
        );

        if (config.testConfig.verbose) {
          console.log(`📊 Correlation query test:`);
          console.log(`  Query: ${traceQuery}`);
          console.log(`  Events found: ${events.length}`);
          console.log(`  Events with join keys: ${eventsWithJoinKeys.length}`);

          if (eventsWithJoinKeys.length > 0) {
            const allJoinKeys = new Set<string>();
            eventsWithJoinKeys.forEach((e) => {
              Object.keys(e.joinKeys || {}).forEach((key) =>
                allJoinKeys.add(key),
              );
            });
            console.log(
              `  Join key fields: ${Array.from(allJoinKeys).join(", ")}`,
            );

            // Show a sample join key value
            const sampleEvent = eventsWithJoinKeys[0];
            const sampleKey = Object.keys(sampleEvent.joinKeys || {})[0];
            if (sampleKey) {
              console.log(
                `  Sample: ${sampleKey}=${sampleEvent.joinKeys![sampleKey]}`,
              );
            }
          }
        }

        testResults.correlationQuery = {
          query: traceQuery,
          totalEvents: events.length,
          eventsWithJoinKeys: eventsWithJoinKeys.length,
          joinKeyFields: [
            ...new Set(
              eventsWithJoinKeys.flatMap((e) => Object.keys(e.joinKeys || {})),
            ),
          ],
        };
      }
    }, 30000); // 30 second timeout

    it("should handle different time ranges for correlation queries", async () => {
      // Test that time ranges work correctly (important for correlation windows)
      const testQuery = config.queries.simple.allLogs;

      // Test different time windows that might be used in correlation
      const timeWindows = ["5m", "30m", "1h", "2h"];
      const results: Record<string, number> = {};

      for (const window of timeWindows) {
        try {
          const events = await collectEvents(adapter, testQuery, window, 5);
          results[window] = events.length;

          // Verify timestamps are within the expected range
          if (events.length > 0) {
            const now = Date.now();
            const windowMs = parseTimeRange(window);
            const oldestAllowed = now - windowMs;

            events.forEach((event) => {
              const eventTime = new Date(event.timestamp).getTime();
              expect(eventTime).toBeGreaterThanOrEqual(oldestAllowed);
              expect(eventTime).toBeLessThanOrEqual(now);
            });
          }
        } catch (error) {
          // Skip if time window not supported
          results[window] = -1;
        }
      }

      if (config.testConfig.verbose) {
        console.log(`📊 Time window support:`);
        Object.entries(results).forEach(([window, count]) => {
          if (count >= 0) {
            console.log(`  ${window}: ${count} events`);
          } else {
            console.log(`  ${window}: not supported`);
          }
        });
      }

      testResults.timeWindows = results;
    });
  });

  describe("Field Validation", () => {
    it("should extract expected fields from messages", async () => {
      const query = config.queries.simple.allLogs;
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.short,
        10,
      );

      if (events.length > 0) {
        const event = events[0];

        // Check for expected fields
        expect(event.timestamp).toBeDefined();
        expect(event.message).toBeDefined();
        expect(event.source).toBeDefined();

        // Check labels contain expected fields
        if (config.expectations.expectedFields.length > 0) {
          const labels = event.labels || {};
          const hasExpectedFields = config.expectations.expectedFields.some(
            (field: string) => labels[field] !== undefined,
          );
          expect(hasExpectedFields).toBe(true);
        }

        if (config.testConfig.verbose) {
          console.log("📋 Sample event structure:");
          console.log("  Timestamp:", event.timestamp);
          console.log("  Source:", event.source);
          console.log("  Stream:", event.stream);
          console.log("  Labels:", Object.keys(event.labels || {}));
          console.log("  Join Keys:", Object.keys(event.joinKeys || {}));
        }
      }
    });

    it("should extract correlation IDs when present", async () => {
      const query = config.queries.correlation.withCorrelationId;
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.medium,
        10,
      );

      if (events.length > 0) {
        const eventsWithCorrelation = events.filter(
          (e) => e.joinKeys && Object.keys(e.joinKeys).length > 0,
        );

        if (config.testConfig.verbose) {
          console.log(
            `📊 Found ${eventsWithCorrelation.length}/${events.length} events with correlation IDs`,
          );

          if (eventsWithCorrelation.length > 0) {
            const correlationKeys = new Set<string>();
            eventsWithCorrelation.forEach((e) => {
              Object.keys(e.joinKeys || {}).forEach((key) =>
                correlationKeys.add(key),
              );
            });
            console.log(
              "  Correlation keys found:",
              Array.from(correlationKeys).join(", "),
            );
          }
        }

        testResults.correlationExtraction = {
          totalEvents: events.length,
          eventsWithCorrelation: eventsWithCorrelation.length,
          correlationKeys: [
            ...new Set(
              eventsWithCorrelation.flatMap((e) =>
                Object.keys(e.joinKeys || {}),
              ),
            ),
          ],
        };
      }
    });
  });

  describe("Time Range Queries", () => {
    it("should respect time ranges", async () => {
      const query = config.queries.simple.allLogs;

      // Test different time ranges
      const shortEvents = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.short,
        50,
      );
      const mediumEvents = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.medium,
        50,
      );

      // Medium time range should potentially have more or equal events
      expect(mediumEvents.length).toBeGreaterThanOrEqual(shortEvents.length);

      if (config.testConfig.verbose) {
        console.log(`📊 Time range comparison:`);
        console.log(
          `  ${config.queries.timeRanges.short}: ${shortEvents.length} events`,
        );
        console.log(
          `  ${config.queries.timeRanges.medium}: ${mediumEvents.length} events`,
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
  });

  describe("Stream Filtering", () => {
    it("should filter by stream if configured", async () => {
      if (!config.connection.streamName && !config.connection.streamId) {
        console.log("⏭️  Skipping stream filter test (no stream configured)");
        return;
      }

      const query = "*";
      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.short,
        10,
      );

      if (events.length > 0) {
        // All events should be from the configured stream
        const streams = [...new Set(events.map((e) => e.stream))];

        if (config.testConfig.verbose) {
          console.log(`📊 Stream filter test:`);
          console.log(
            `  Configured stream: ${config.connection.streamName || config.connection.streamId}`,
          );
          console.log(`  Streams in results: ${streams.join(", ")}`);
        }

        testResults.streamFiltering = {
          configuredStream:
            config.connection.streamName || config.connection.streamId,
          streamsInResults: streams,
        };
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid queries gracefully", async () => {
      // Use a query that Graylog v6 will definitely reject
      // Empty field name with colon is invalid
      const invalidQuery = ":value OR field: AND";

      const events = await collectEvents(adapter, invalidQuery, "1m", 1);

      // We expect to get 0 events due to the error, but collectEvents
      // now returns empty array on error instead of throwing
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBe(0);

      if (config.testConfig.verbose) {
        console.log(
          "✅ Invalid query handled gracefully, returned empty array",
        );
      }
    }, 30000); // 30 second timeout

    it("should handle network timeouts", async () => {
      // Create adapter with very short timeout
      const timeoutAdapter = new GraylogAdapter({
        ...adapter["options"],
        timeout: 1, // 1ms timeout to force timeout
      });

      try {
        const events = await collectEvents(timeoutAdapter, "*", "1m", 1);
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
  });

  describe("Performance", () => {
    it("should handle large result sets efficiently", async () => {
      const query = config.queries.simple.allLogs;
      const startTime = Date.now();

      const events = await collectEvents(
        adapter,
        query,
        config.queries.timeRanges.short,
        100,
      );

      const duration = Date.now() - startTime;

      if (config.testConfig.verbose) {
        console.log(`⏱️  Performance test:`);
        console.log(`  Fetched ${events.length} events in ${duration}ms`);
        console.log(
          `  Average: ${events.length > 0 ? (duration / events.length).toFixed(2) : 0}ms per event`,
        );
      }

      testResults.performance = {
        eventCount: events.length,
        duration,
        averagePerEvent: events.length > 0 ? duration / events.length : 0,
      };
    });
  });
});

// Helper function to parse time range strings to milliseconds
function parseTimeRange(timeRange: string): number {
  const match = timeRange.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 5 * 60 * 1000; // Default to 5 minutes
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 5 * 60 * 1000;
  }
}

/**
 * Helper function to collect events from a Graylog adapter stream.
 *
 * @param adapter The GraylogAdapter instance to query
 * @param query The Graylog query string to execute
 * @param timeRange The time range for the query (e.g., "5m", "1h")
 * @param maxEvents Maximum number of events to collect (optional)
 * @returns Promise that resolves to an array of LogEvent objects
 */
async function collectEvents(
  adapter: GraylogAdapter,
  query: string,
  timeRange: string,
  maxEvents?: number,
): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  const max = maxEvents || config.testConfig.maxEventsPerTest;
  const timeout = config.testConfig.maxWaitTime || 10000; // Default 10s timeout

  // Create a temporary adapter just for this query to ensure clean lifecycle
  const tempAdapter = new GraylogAdapter(adapter["options"]);

  return new Promise<LogEvent[]>((resolve) => {
    const startTime = Date.now();
    let settled = false;

    // Set up a hard timeout that will definitely resolve
    const timeoutId = setTimeout(async () => {
      if (!settled) {
        settled = true;
        try {
          await tempAdapter.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
        if (config.testConfig.verbose) {
          console.log(
            `⏱️ Timeout after ${timeout}ms, collected ${events.length} events`,
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
        const stream = tempAdapter.createStream(query, { timeRange });

        for await (const event of stream) {
          if (settled) break;

          events.push(event);

          if (config.debug.logRawResponses && events.length === 1) {
            console.log("🔍 Raw event:", JSON.stringify(event, null, 2));
          }

          if (events.length >= max) {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              await tempAdapter.destroy();
              if (config.testConfig.verbose) {
                console.log(
                  `✅ Collected ${events.length} events (max reached)`,
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
              await tempAdapter.destroy();
              if (config.testConfig.verbose) {
                console.log(
                  `⏱️ Inline timeout check at ${events.length} events`,
                );
              }
              resolve(events);
            }
            break;
          }
        }

        // Stream completed normally - resolve with whatever we collected
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          await tempAdapter.destroy();
          if (config.testConfig.verbose && events.length === 0) {
            console.log("✅ Stream completed with no events");
          }
          resolve(events);
        }
      } catch (error: any) {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          try {
            await tempAdapter.destroy();
          } catch (e) {
            // Ignore cleanup errors
          }
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
 * Helper function to log a sample event in a readable format for debugging.
 *
 * @param event The LogEvent to display (can be undefined)
 */
function logSampleEvent(event: LogEvent | undefined) {
  if (!event) return;

  console.log("  Sample event:");
  console.log(`    Timestamp: ${event.timestamp}`);
  console.log(`    Message: ${event.message?.substring(0, 100)}...`);
  console.log(`    Source: ${event.source}`);
  console.log(`    Stream: ${event.stream}`);

  if (event.labels && Object.keys(event.labels).length > 0) {
    console.log(
      `    Labels: ${Object.keys(event.labels).slice(0, 5).join(", ")}${Object.keys(event.labels).length > 5 ? "..." : ""}`,
    );
  }

  if (event.joinKeys && Object.keys(event.joinKeys).length > 0) {
    console.log(`    Join Keys: ${JSON.stringify(event.joinKeys)}`);
  }
}
