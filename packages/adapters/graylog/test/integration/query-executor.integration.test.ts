/**
 * TimeQLExecutor Integration Tests for Graylog
 *
 * These tests verify the new TimeQLExecutor functionality with real Graylog instances,
 * including named adapters, automatic query detection, and cross-instance correlation.
 */

import { TimeQLExecutor } from "@timebridge/core";
import {
  GraylogAdapter,
  GraylogAdapterOptions,
} from "../../src/graylog-adapter";
import { LogEvent, CorrelatedEvent } from "@timebridge/core";
import * as fs from "fs";
import * as path from "path";

// Load configuration
const configPath = fs.existsSync(
  path.join(__dirname, "graylog.config.local.js")
)
  ? "./graylog.config.local.js"
  : "./graylog.config.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require(configPath);

// Skip tests if no Graylog connection is configured
const skipTests =
  config.testConfig.skipIfNoConnection && !config.connection.url;

const describeOrSkip = skipTests ? describe.skip : describe;

describeOrSkip("TimeQLExecutor Integration Tests with Graylog", () => {
  let executor: TimeQLExecutor;
  let adapterConfig: GraylogAdapterOptions;

  beforeAll(() => {
    // Validate configuration
    if (!config.connection.url) {
      throw new Error("GRAYLOG_URL must be configured for integration tests");
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

    // Create TimeQLExecutor
    executor = new TimeQLExecutor({
      timeWindow: 30000,
      maxEvents: 10000,
    });

    // Log configuration
    if (config.testConfig.verbose) {
      console.log("🔧 TimeQLExecutor Test Configuration:");
      console.log("  URL:", config.connection.url);
      console.log("  API Version:", config.connection.apiVersion);
      console.log(
        "  Stream:",
        config.connection.streamName ||
          config.connection.streamId ||
          "All Streams"
      );
    }
  });

  describe("Named Adapter Registration", () => {
    beforeEach(() => {
      // Create fresh executor for each test
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
    });

    it("should register default adapter", () => {
      executor.addAdapter("graylog", new GraylogAdapter(adapterConfig), {
        isDefault: true,
      });

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe("graylog");
      expect(info[0].isDefault).toBe(true);
    });

    it("should register multiple named adapters", () => {
      // Register multiple instances with different names
      executor.addAdapter(
        "graylog-prod",
        new GraylogAdapter({
          ...adapterConfig,
          // Could use different stream for prod
        })
      );

      executor.addAdapter(
        "graylog-staging",
        new GraylogAdapter({
          ...adapterConfig,
          // Could use different stream for staging
        })
      );

      executor.addAdapter(
        "graylog-dev",
        new GraylogAdapter({
          ...adapterConfig,
          // Could use different stream for dev
        })
      );

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(3);

      const names = info.map((i) => i.name).sort();
      expect(names).toEqual(["graylog-dev", "graylog-prod", "graylog-staging"]);
    });

    it("should set first adapter as default automatically", () => {
      executor.addAdapter("graylog-first", new GraylogAdapter(adapterConfig));
      executor.addAdapter("graylog-second", new GraylogAdapter(adapterConfig));

      const info = executor.getAdapterInfo();
      expect(info.find((i) => i.name === "graylog-first")?.isDefault).toBe(
        true
      );
      expect(info.find((i) => i.name === "graylog-second")?.isDefault).toBe(
        false
      );
    });

    it("should override default when explicitly set", () => {
      executor.addAdapter("graylog-first", new GraylogAdapter(adapterConfig));
      executor.addAdapter("graylog-second", new GraylogAdapter(adapterConfig), {
        isDefault: true,
      });

      const info = executor.getAdapterInfo();
      expect(info.find((i) => i.name === "graylog-first")?.isDefault).toBe(
        false
      );
      expect(info.find((i) => i.name === "graylog-second")?.isDefault).toBe(
        true
      );
    });
  });

  describe("Query Type Detection", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("graylog", new GraylogAdapter(adapterConfig));
      executor.addAdapter("graylog-prod", new GraylogAdapter(adapterConfig));
    });

    it("should detect direct queries", () => {
      const validation = executor.validateQuery("graylog(_exists_:message)[5m]");
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["graylog"]);
    });

    it("should detect named adapter queries", () => {
      const validation = executor.validateQuery(
        "graylog-prod(level:error)[10m]"
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["graylog-prod"]);
    });

    it("should detect correlation queries", () => {
      const validation = executor.validateQuery(
        "graylog(level:error)[5m] and on(request_id) graylog(level:info)[5m]"
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual(["graylog", "graylog"]);
    });

    it("should detect cross-adapter correlation", () => {
      const validation = executor.validateQuery(
        "graylog-prod(service:api)[5m] and on(request_id) graylog(service:api)[5m]"
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual(["graylog-prod", "graylog"]);
    });

    it("should fail validation for missing adapters", () => {
      const validation = executor.validateQuery("graylog-unknown(_exists_:message)[5m]");
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Missing adapters");
    });
  });

  describe("Direct Query Execution", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("graylog", new GraylogAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter("graylog-test", new GraylogAdapter(adapterConfig));
    });

    it(
      "should execute direct query to default adapter",
      async () => {
        const query = `graylog(${config.queries.simple.allLogs})[1m]`;
        const events: LogEvent[] = [];
        const maxEvents = 5;

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {
            events.push(result.data as LogEvent);
            if (events.length >= maxEvents) break;
          }
        }

        expect(events.length).toBeGreaterThan(0);
        expect(events.length).toBeLessThanOrEqual(maxEvents);

        // Verify event structure
        const event = events[0];
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("message");
        expect(event).toHaveProperty("source");
        expect(event).toHaveProperty("labels");
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should execute direct query to named adapter",
      async () => {
        const query = `graylog-test(${config.queries.simple.allLogs})[1m]`;
        const events: LogEvent[] = [];
        const maxEvents = 5;

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {
            events.push(result.data as LogEvent);
            if (events.length >= maxEvents) break;
          }
        }

        expect(events.length).toBeGreaterThan(0);
        expect(events.length).toBeLessThanOrEqual(maxEvents);
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should return typed LogEvent objects",
      async () => {
        const query = `graylog(${config.queries.simple.allLogs})[30s]`;
        const events: LogEvent[] = [];

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {
            events.push(result.data as LogEvent);
            if (events.length >= 1) break;
          }
        }

        const event = events[0];

        // Type checking - LogEvent structure
        expect(typeof event.timestamp).toBe("string");
        expect(typeof event.message).toBe("string");
        expect(typeof event.source).toBe("string");
        expect(typeof event.labels).toBe("object");

        // Optional fields
        if (event.joinKeys) {
          expect(typeof event.joinKeys).toBe("object");
        }
        if (event.stream) {
          expect(typeof event.stream).toBe("string");
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should handle complex Graylog queries",
      async () => {
        const complexQuery =
          config.queries.complex.serviceErrors || "level:error AND source:test";
        const query = `graylog(${complexQuery})[2m]`;
        const events: LogEvent[] = [];
        const maxEvents = 10;

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {
            events.push(result.data as LogEvent);
            if (events.length >= maxEvents) break;
          }
        }

        // May or may not have results depending on data
        expect(Array.isArray(events)).toBe(true);
      },
      config.testConfig.maxWaitTime
    );
  });

  describe("Correlation Query Execution", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("graylog", new GraylogAdapter(adapterConfig));
      executor.addAdapter("graylog-prod", new GraylogAdapter(adapterConfig));
      executor.addAdapter("graylog-staging", new GraylogAdapter(adapterConfig));
    });

    it(
      "should execute correlation query with same adapter",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "request_id";
        const query = `
        graylog(${config.queries.simple.allLogs})[2m]
        and on(${correlationField})
        graylog(${config.queries.simple.allLogs})[2m]
      `
          .trim()
          .replace(/\s+/g, " ");

        const correlations: CorrelatedEvent[] = [];
        const maxCorrelations = 5;

        for await (const result of executor.execute(query)) {
          if (result.type === 'correlation') {
            correlations.push(result.data as CorrelatedEvent);
            if (correlations.length >= maxCorrelations) break;
          }
        }

        // May or may not have correlations depending on data
        if (correlations.length > 0) {
          const correlation = correlations[0];

          // Verify CorrelatedEvent structure
          expect(correlation).toHaveProperty("correlationId");
          expect(correlation).toHaveProperty("timestamp");
          expect(correlation).toHaveProperty("timeWindow");
          expect(correlation).toHaveProperty("joinKey");
          expect(correlation).toHaveProperty("joinValue");
          expect(correlation).toHaveProperty("events");
          expect(correlation).toHaveProperty("metadata");

          // Verify events array
          expect(Array.isArray(correlation.events)).toBe(true);
          expect(correlation.events.length).toBeGreaterThanOrEqual(2);

          // Verify metadata
          expect(correlation.metadata).toHaveProperty("completeness");
          expect(correlation.metadata).toHaveProperty("matchedStreams");
          expect(correlation.metadata).toHaveProperty("totalStreams");
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should execute cross-adapter correlation",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "request_id";
        const query = `
        graylog-prod(${config.queries.simple.allLogs})[2m]
        and on(${correlationField})
        graylog-staging(${config.queries.simple.allLogs})[2m]
      `
          .trim()
          .replace(/\s+/g, " ");

        const correlations: CorrelatedEvent[] = [];
        const maxCorrelations = 5;

        for await (const result of executor.execute(query)) {
          if (result.type === 'correlation') {
            correlations.push(result.data as CorrelatedEvent);
            if (correlations.length >= maxCorrelations) break;
          }
        }

        // Verify correlation if we have data
        if (correlations.length > 0) {
          const correlation = correlations[0];
          expect(correlation.metadata.totalStreams).toBe(2);
          expect(correlation.joinKey).toBe(correlationField);
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should return typed CorrelatedEvent objects",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "request_id";
        const query = `
        graylog(${config.queries.simple.allLogs})[1m]
        and on(${correlationField})
        graylog(${config.queries.simple.allLogs})[1m]
      `
          .trim()
          .replace(/\s+/g, " ");

        const correlations: CorrelatedEvent[] = [];

        for await (const result of executor.execute(query)) {
          if (result.type === 'correlation') {
            correlations.push(result.data as CorrelatedEvent);
            if (correlations.length >= 1) break;
          }
        }

        if (correlations.length > 0) {
          const correlation = correlations[0];

          // Type checking - CorrelatedEvent structure
          expect(typeof correlation.correlationId).toBe("string");
          expect(typeof correlation.timestamp).toBe("string");
          expect(typeof correlation.joinKey).toBe("string");
          expect(typeof correlation.joinValue).toBe("string");

          // TimeWindow structure
          expect(typeof correlation.timeWindow.start).toBe("string");
          expect(typeof correlation.timeWindow.end).toBe("string");

          // Events array structure
          correlation.events.forEach((event) => {
            expect(typeof event.timestamp).toBe("string");
            expect(typeof event.message).toBe("string");
            expect(typeof event.source).toBe("string");
            expect(typeof event.labels).toBe("object");
          });

          // Metadata structure
          expect(["complete", "partial"]).toContain(
            correlation.metadata.completeness
          );
          expect(Array.isArray(correlation.metadata.matchedStreams)).toBe(true);
          expect(typeof correlation.metadata.totalStreams).toBe("number");
        }
      },
      config.testConfig.maxWaitTime
    );
  });

  describe("Advanced Correlation Patterns", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });

      // Register multiple adapters for testing
      executor.addAdapter("graylog", new GraylogAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter("graylog-1", new GraylogAdapter(adapterConfig));
      executor.addAdapter("graylog-2", new GraylogAdapter(adapterConfig));
      executor.addAdapter("graylog-3", new GraylogAdapter(adapterConfig));
    });

    it(
      "should handle three-way correlation",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "request_id";
        const query = `
        graylog-1(${config.queries.simple.allLogs})[2m]
        and on(${correlationField})
        graylog-2(${config.queries.simple.allLogs})[2m]
        and on(${correlationField})
        graylog-3(${config.queries.simple.allLogs})[2m]
      `
          .trim()
          .replace(/\s+/g, " ");

        const correlations: CorrelatedEvent[] = [];
        const maxCorrelations = 3;

        for await (const result of executor.execute(query)) {
          if (result.type === 'correlation') {
            correlations.push(result.data as CorrelatedEvent);
            if (correlations.length >= maxCorrelations) break;
          }
        }

        if (correlations.length > 0) {
          const correlation = correlations[0];
          expect(correlation.metadata.totalStreams).toBe(3);
          // Should have events from all three streams if complete
          if (correlation.metadata.completeness === "complete") {
            expect(correlation.events.length).toBeGreaterThanOrEqual(3);
          }
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should handle mixed default and named adapters",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "request_id";
        const query = `
        graylog(${config.queries.simple.allLogs})[2m]
        and on(${correlationField})
        graylog-1(${config.queries.simple.allLogs})[2m]
      `
          .trim()
          .replace(/\s+/g, " ");

        const validation = executor.validateQuery(query);
        expect(validation.valid).toBe(true);
        expect(validation.type).toBe("correlation");
        expect(validation.sources).toEqual(["graylog", "graylog-1"]);

        const correlations: CorrelatedEvent[] = [];
        const maxCorrelations = 3;

        for await (const result of executor.execute(query)) {
          if (result.type === 'correlation') {
            correlations.push(result.data as CorrelatedEvent);
            if (correlations.length >= maxCorrelations) break;
          }
        }

        // Verify results if we have data
        if (correlations.length > 0) {
          expect(correlations[0].metadata.totalStreams).toBe(2);
        }
      },
      config.testConfig.maxWaitTime
    );
  });

  describe("Error Handling", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("graylog", new GraylogAdapter(adapterConfig));
    });

    it("should handle invalid query format", async () => {
      const executeInvalid = async () => {
        const results: (LogEvent | CorrelatedEvent)[] = [];
        for await (const result of executor.execute("invalid query")) {
          results.push(result.data);
        }
      };

      await expect(executeInvalid()).rejects.toThrow();
    });

    it("should handle missing adapter gracefully", () => {
      const validation = executor.validateQuery("nonexistent-adapter(_exists_:message)[5m]");
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Missing adapters");
      expect(validation.error).toContain("nonexistent-adapter");
    });

    it("should handle malformed correlation query", async () => {
      const query = "graylog(_exists_:message)[5m] and graylog(_exists_:message)[5m]"; // Missing 'on(field)'

      const executeInvalid = async () => {
        const results: (LogEvent | CorrelatedEvent)[] = [];
        for await (const result of executor.execute(query)) {
          results.push(result.data);
        }
      };

      // Should fail during parsing
      await expect(executeInvalid()).rejects.toThrow();
    });
  });

  afterAll(() => {
    // Cleanup if needed
  });
});
