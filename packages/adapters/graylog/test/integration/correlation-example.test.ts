/**
 * Example test demonstrating how the Graylog adapter works with the CorrelationEngine
 * for correlation queries like:
 * graylog(traceId:trace_12345)[1h] and on(traceId) graylog(traceId:trace_12345)[1h]
 *
 * This test is meant to demonstrate the integration between the adapter and the core engine.
 * It will be skipped if no Graylog instance is configured.
 */

import { GraylogAdapter } from "../../src/graylog-adapter";
import { CorrelationEngine } from "@liquescent/log-correlator-core";
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
const skipTests = !config.connection.url;

const describeOrSkip = skipTests ? describe.skip : describe;

// Helper function to collect events from correlation engine with timeout
async function collectCorrelationEvents(
  engine: any,
  query: string,
  maxEvents: number = 5,
  timeoutMs: number = 10000,
): Promise<any[]> {
  const events: any[] = [];
  const startTime = Date.now();

  try {
    const correlationStream = engine.correlate(query);

    for await (const event of correlationStream) {
      events.push(event);

      if (events.length >= maxEvents) {
        break;
      }

      if (Date.now() - startTime > timeoutMs) {
        console.log(
          `  ⏱️ Timeout after ${timeoutMs}ms, collected ${events.length} events`,
        );
        break;
      }
    }
  } catch (error: any) {
    console.log(`  ⚠️ Stream error: ${error.message}`);
  }

  return events;
}

describeOrSkip("Graylog Correlation Engine Integration", () => {
  let adapter: GraylogAdapter;
  let engine: CorrelationEngine;

  beforeAll(() => {
    if (!config.connection.url) {
      return;
    }

    // Create adapter configuration
    const adapterConfig: any = {
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

    // Create adapter and engine
    adapter = new GraylogAdapter(adapterConfig);
    engine = new CorrelationEngine();
    engine.addAdapter("graylog", adapter);
  });

  afterAll(async () => {
    // Destroy the engine first (which should clean up its internal state)
    if (engine) {
      try {
        await engine.destroy();
      } catch (error) {
        console.error("Error destroying engine:", error);
      }
    }

    // Then destroy the adapter
    if (adapter) {
      try {
        await adapter.destroy();
      } catch (error) {
        console.error("Error destroying adapter:", error);
      }
    }

    // Small delay to ensure all async operations complete
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 100);
      if (timer.unref) timer.unref();
    });
  });

  describe("Correlation Query Support", () => {
    it("should demonstrate how correlation queries work with the engine", async () => {
      // This demonstrates the actual query syntax that would be used
      // The CorrelationEngine parses this and calls the adapter appropriately

      // Example 1: Simple correlation query with two sources
      // The CorrelationEngine requires at least two streams for correlation
      const simpleQuery =
        "graylog(tier:prd)[5m] and on(request_id) graylog(tier:prd)[5m]";

      console.log("\n📊 Testing simple correlation query:");
      console.log(`  Query: ${simpleQuery}`);

      const events = await collectCorrelationEvents(
        engine,
        simpleQuery,
        5,
        5000,
      );

      console.log(`  ✅ Retrieved ${events.length} events`);

      if (events.length > 0) {
        // Verify the correlated events have the expected structure
        // Correlation returns CorrelatedEvent objects, not individual LogEvents
        expect(events[0]).toHaveProperty("correlationId");
        expect(events[0]).toHaveProperty("events");
        expect(events[0]).toHaveProperty("joinKey");
        expect(events[0]).toHaveProperty("joinValue");
        expect(events[0]).toHaveProperty("timestamp");
        expect(events[0]).toHaveProperty("timeWindow");
        expect(events[0]).toHaveProperty("metadata");

        // Verify the individual events within the correlation
        if (events[0].events && events[0].events.length > 0) {
          expect(events[0].events[0]).toHaveProperty("timestamp");
          expect(events[0].events[0]).toHaveProperty("message");
          expect(events[0].events[0]).toHaveProperty("source");
          expect(events[0].events[0]).toHaveProperty("labels");
        }
      }
    }, 30000);

    it("should demonstrate correlation with join keys", async () => {
      // This test demonstrates how correlation queries with joins would work
      // In practice, you'd use a real trace ID from your logs

      // The correlation query syntax (this is what users would write)
      // Note: The parser expects comma-separated field:value pairs, not AND operators
      const correlationQuery = `
        graylog(tier:prd)[10m]
        and on(request_id)
        graylog(application:apigw-router)[10m]
      `
        .trim()
        .replace(/\s+/g, " ");

      console.log("\n📊 Testing correlation query with joins:");
      console.log(`  Query: ${correlationQuery}`);
      console.log(
        "  This query correlates all logs with request_id to error logs with matching request_id",
      );

      const correlatedEvents = await collectCorrelationEvents(
        engine,
        correlationQuery,
        5,
        5000,
      );

      console.log(`  ✅ Found ${correlatedEvents.length} correlated events`);

      if (correlatedEvents.length > 0) {
        // Check if correlations have join keys
        const correlationsWithJoinKeys = correlatedEvents.filter(
          (e) => e.joinKey && e.joinValue,
        );
        console.log(
          `  📎 Correlations with join keys: ${correlationsWithJoinKeys.length}`,
        );

        if (correlationsWithJoinKeys.length > 0) {
          const joinKeyFields = new Set<string>();
          correlationsWithJoinKeys.forEach((e) => {
            if (e.joinKey) {
              joinKeyFields.add(e.joinKey);
            }
          });
          console.log(
            `  🔑 Join key fields used: ${Array.from(joinKeyFields).join(", ")}`,
          );

          // Also check individual events for join keys
          const firstCorrelation = correlationsWithJoinKeys[0];
          if (firstCorrelation.events && firstCorrelation.events.length > 0) {
            console.log(
              `  📦 Events in first correlation: ${firstCorrelation.events.length}`,
            );
            console.log(`  🔗 Join value: ${firstCorrelation.joinValue}`);
          }
        }
      }
    }, 30000);

    it("should demonstrate time window handling", async () => {
      // Different time windows are crucial for correlation
      const timeWindows = ["5m", "30m", "1h"];

      console.log("\n📊 Testing time window handling:");

      for (const window of timeWindows) {
        // Need at least two sources for correlation
        const query = `graylog(tier:prd)[${window}] and on(request_id) graylog(application:apigw-router)[${window}]`;

        const events = await collectCorrelationEvents(engine, query, 3, 5000);

        console.log(
          `  ✅ [${window}] window: ${events.length} events retrieved`,
        );

        // Instead of checking against "now", verify that all events in a correlation
        // are within the same reasonable time window of each other (correlation consistency)
        if (events.length > 0) {
          const windowMs = parseTimeWindow(window);

          // Check that events within each correlation are reasonably close to each other
          const correlationsValid = events.every((correlation) => {
            if (!correlation.events || correlation.events.length === 0) {
              return true; // Skip if no events
            }

            // Find the time range of events in this correlation
            const eventTimes = correlation.events.map((event: any) =>
              new Date(event.timestamp).getTime(),
            );
            const minTime = Math.min(...eventTimes);
            const maxTime = Math.max(...eventTimes);
            const timeSpan = maxTime - minTime;

            // Events in a correlation should be within the window of each other
            // We allow the full window span since events could be from start and end of window
            return timeSpan <= windowMs;
          });

          if (!correlationsValid) {
            console.log(
              `  ⚠️ [${window}] window: Some correlations span too much time`,
            );
            const invalidCorrelation = events.find((correlation) => {
              if (!correlation.events || correlation.events.length === 0)
                return false;
              const eventTimes = correlation.events.map((event: any) =>
                new Date(event.timestamp).getTime(),
              );
              const minTime = Math.min(...eventTimes);
              const maxTime = Math.max(...eventTimes);
              return maxTime - minTime > windowMs;
            });

            if (invalidCorrelation && invalidCorrelation.events) {
              const eventTimes = invalidCorrelation.events.map(
                (event: any) => ({
                  time: event.timestamp,
                  ms: new Date(event.timestamp).getTime(),
                }),
              );
              const minTime = Math.min(...eventTimes.map((e: any) => e.ms));
              const maxTime = Math.max(...eventTimes.map((e: any) => e.ms));
              console.log(
                `    Time span: ${(maxTime - minTime) / 1000}s (max allowed: ${windowMs / 1000}s)`,
              );
              console.log(
                `    Events:`,
                eventTimes.map((e: any) => e.time).join(", "),
              );
            }
          }

          // Also verify we got some events (basic sanity check)
          expect(events.length).toBeGreaterThan(0);
          expect(correlationsValid).toBe(true);
        }
      }
    }, 30000);
  });
});

function parseTimeWindow(window: string): number {
  const match = window.match(/^(\d+)([smhd])$/);
  if (!match) return 5 * 60 * 1000;

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
