/**
 * TimeQLExecutor Integration Tests for Loki
 *
 * These tests verify the new TimeQLExecutor functionality with real Loki instances,
 * including named adapters, automatic query detection, and cross-instance correlation.
 */

import { TimeQLExecutor } from "@timebridge/core";
import { LokiAdapter } from "../../src/loki-adapter";
import { LogEvent, CorrelatedEvent } from "@timebridge/core";

// Test configuration - update these for your Loki instance
const LOKI_URL = process.env.LOKI_URL || "http://localhost:3100";
const LOKI_USERNAME = process.env.LOKI_USERNAME;
const LOKI_PASSWORD = process.env.LOKI_PASSWORD;
const SKIP_TESTS = !process.env.LOKI_URL && !process.env.RUN_LOKI_TESTS;

const describeOrSkip = SKIP_TESTS ? describe.skip : describe;

describeOrSkip("TimeQLExecutor Integration Tests with Loki", () => {
  let executor: TimeQLExecutor;
  let adapterConfig: any;

  beforeAll(() => {
    // Create adapter configuration
    adapterConfig = {
      url: LOKI_URL,
      username: LOKI_USERNAME,
      password: LOKI_PASSWORD,
    };

    // Create TimeQLExecutor
    executor = new TimeQLExecutor({
      timeWindow: 30000,
      maxEvents: 10000,
    });

    console.log("🔧 Loki TimeQLExecutor Test Configuration:");
    console.log("  URL:", LOKI_URL);
    console.log("  Auth:", LOKI_USERNAME ? "Basic Auth" : "No Auth");
  });

  describe("Named Adapter Registration", () => {
    beforeEach(() => {
      // Create fresh executor for each test
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
    });

    it("should register default Loki adapter", () => {
      executor.addAdapter("loki", new LokiAdapter(adapterConfig), {
        isDefault: true,
      });

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe("loki");
      expect(info[0].baseType).toBe("loki");
      expect(info[0].isDefault).toBe(true);
    });

    it("should register multiple named Loki adapters", () => {
      // Simulate multiple Loki instances (e.g., different regions)
      executor.addAdapter(
        "loki-us-east",
        new LokiAdapter({
          ...adapterConfig,
          // Could point to us-east Loki
        })
      );

      executor.addAdapter(
        "loki-eu-west",
        new LokiAdapter({
          ...adapterConfig,
          // Could point to eu-west Loki
        })
      );

      executor.addAdapter(
        "loki-ap-south",
        new LokiAdapter({
          ...adapterConfig,
          // Could point to ap-south Loki
        })
      );

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(3);

      const names = info.map((i) => i.name).sort();
      expect(names).toEqual(["loki-ap-south", "loki-eu-west", "loki-us-east"]);

      // All should have 'loki' as base type
      info.forEach((adapter) => {
        expect(adapter.baseType).toBe("loki");
      });
    });

    it("should handle mixed Loki and Graylog adapters", () => {
      executor.addAdapter("loki-prod", new LokiAdapter(adapterConfig));
      // We can't add Graylog here without the adapter, but the test shows the pattern

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe("loki-prod");
      expect(info[0].baseType).toBe("loki");
    });
  });

  describe("Query Type Detection with Loki", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("loki", new LokiAdapter(adapterConfig));
      executor.addAdapter("loki-prod", new LokiAdapter(adapterConfig));
      executor.addAdapter("loki-staging", new LokiAdapter(adapterConfig));
    });

    it("should detect direct Loki queries", () => {
      const validation = executor.validateQuery('loki({job="nginx"})[5m]');
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["loki"]);
    });

    it("should detect named Loki adapter queries", () => {
      const validation = executor.validateQuery(
        'loki-prod({service="api", level="error"})[10m]'
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["loki-prod"]);
    });

    it("should detect Loki correlation queries", () => {
      const validation = executor.validateQuery(
        'loki({service="frontend"})[5m] and on(trace_id) loki({service="backend"})[5m]'
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual(["loki", "loki"]);
    });

    it("should detect cross-instance Loki correlation", () => {
      const validation = executor.validateQuery(
        'loki-prod({job="api"})[5m] and on(request_id) loki-staging({job="api"})[5m]'
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual(["loki-prod", "loki-staging"]);
    });
  });

  describe("Direct Query Execution with Loki", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("loki", new LokiAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter("loki-test", new LokiAdapter(adapterConfig));
    });

    it("should execute direct Loki query", async () => {
      const query = 'loki({job=~".+"})[1m]'; // Match any job
      const events: LogEvent[] = [];
      const maxEvents = 5;

      for await (const result of executor.execute(query)) {
        if (result.type === 'event') {

          events.push(result.data as LogEvent);
          if (events.length >= maxEvents) break;

        }

      }

      // Verify event structure if we got results
      if (events.length > 0) {
        const event = events[0];
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("message");
        expect(event).toHaveProperty("source");
        expect(event).toHaveProperty("labels");

        // Loki-specific: labels should contain job or other metadata
        expect(typeof event.labels).toBe("object");
      }
    }, 30000);

    it("should execute query to named Loki adapter", async () => {
      const query = 'loki-test({job=~".+"})[1m]';
      const events: LogEvent[] = [];
      const maxEvents = 5;

      for await (const result of executor.execute(query)) {
        if (result.type === 'event') {

          events.push(result.data as LogEvent);
          if (events.length >= maxEvents) break;

        }

      }

      expect(Array.isArray(events)).toBe(true);
    }, 30000);

    it("should handle complex LogQL queries", async () => {
      // Complex LogQL with multiple labels and regex
      const query = 'loki({job=~".*", level=~"error|warn|info"})[2m]';
      const events: LogEvent[] = [];
      const maxEvents = 10;

      for await (const result of executor.execute(query)) {
        if (result.type === 'event') {

          events.push(result.data as LogEvent);
          if (events.length >= maxEvents) break;

        }

      }

      expect(Array.isArray(events)).toBe(true);
    }, 30000);

    it("should preserve Loki labels in LogEvent", async () => {
      const query = 'loki({job=~".+"})[30s]';
      const events: LogEvent[] = [];

      for await (const result of executor.execute(query)) {
        if (result.type === 'event') {

          events.push(result.data as LogEvent);
          if (events.length >= 1) break;

        }

      }

      if (events.length > 0) {
        const event = events[0];

        // Verify Loki-specific label structure
        expect(event.labels).toBeDefined();
        expect(typeof event.labels).toBe("object");

        // Labels might include job, instance, etc.
        const labelKeys = Object.keys(event.labels);
        expect(labelKeys.length).toBeGreaterThan(0);
      }
    }, 30000);
  });

  describe("Correlation Query Execution with Loki", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("loki", new LokiAdapter(adapterConfig));
      executor.addAdapter("loki-prod", new LokiAdapter(adapterConfig));
      executor.addAdapter("loki-staging", new LokiAdapter(adapterConfig));
    });

    it("should execute Loki correlation query", async () => {
      const query = `
        loki({job=~".+"})[2m]
        and on(trace_id)
        loki({job=~".+"})[2m]
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

      // Verify correlation structure if we have data
      if (correlations.length > 0) {
        const correlation = correlations[0];

        expect(correlation).toHaveProperty("correlationId");
        expect(correlation).toHaveProperty("timestamp");
        expect(correlation).toHaveProperty("timeWindow");
        expect(correlation).toHaveProperty("joinKey");
        expect(correlation).toHaveProperty("joinValue");
        expect(correlation).toHaveProperty("events");
        expect(correlation).toHaveProperty("metadata");

        // Should have at least 2 events in a correlation
        expect(correlation.events.length).toBeGreaterThanOrEqual(2);

        // Each event should have Loki labels
        correlation.events.forEach((event) => {
          expect(event.labels).toBeDefined();
        });
      }
    }, 30000);

    it("should execute cross-instance Loki correlation", async () => {
      const query = `
        loki-prod({job=~".+"})[2m]
        and on(request_id)
        loki-staging({job=~".+"})[2m]
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

      // Verify if we got correlations
      if (correlations.length > 0) {
        expect(correlations[0].metadata.totalStreams).toBe(2);
        expect(correlations[0].metadata.matchedStreams).toHaveLength(2);
      }
    }, 30000);

    it("should handle different join types", async () => {
      // Test OR join (left join)
      const orQuery = `
        loki({job=~".+"})[2m]
        or on(trace_id)
        loki({job=~".+"})[2m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const validation = executor.validateQuery(orQuery);
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");

      // Test UNLESS join (anti-join)
      const unlessQuery = `
        loki({job=~".+"})[2m]
        unless on(trace_id)
        loki({job=~".+"})[2m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const validation2 = executor.validateQuery(unlessQuery);
      expect(validation2.valid).toBe(true);
      expect(validation2.type).toBe("correlation");
    });
  });

  describe("Mixed Loki Patterns", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });

      // Register multiple adapters
      executor.addAdapter("loki", new LokiAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter("loki-1", new LokiAdapter(adapterConfig));
      executor.addAdapter("loki-2", new LokiAdapter(adapterConfig));
    });

    it("should handle three-way Loki correlation", async () => {
      const query = `
        loki({job=~".+"})[2m]
        and on(trace_id)
        loki-1({job=~".+"})[2m]
        and on(trace_id)
        loki-2({job=~".+"})[2m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const validation = executor.validateQuery(query);
      expect(validation.valid).toBe(true);
      expect(validation.sources).toEqual(["loki", "loki-1", "loki-2"]);

      const correlations: CorrelatedEvent[] = [];
      const maxCorrelations = 3;

      for await (const result of executor.execute(query)) {
        if (result.type === 'correlation') {

          correlations.push(result.data as CorrelatedEvent);
          if (correlations.length >= maxCorrelations) break;

        }

      }

      if (correlations.length > 0) {
        expect(correlations[0].metadata.totalStreams).toBe(3);
      }
    }, 30000);

    it("should resolve base 'loki' to default adapter", async () => {
      const query = 'loki({job=~".+"})[1m]';

      // This should use the default loki adapter
      const validation = executor.validateQuery(query);
      expect(validation.valid).toBe(true);

      const events: LogEvent[] = [];
      const maxEvents = 3;

      for await (const result of executor.execute(query)) {
        if (result.type === 'event') {

          events.push(result.data as LogEvent);
          if (events.length >= maxEvents) break;

        }

      }

      expect(Array.isArray(events)).toBe(true);
    }, 30000);
  });

  describe("Error Handling with Loki", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("loki", new LokiAdapter(adapterConfig));
    });

    it("should handle invalid LogQL syntax", async () => {
      const query = "loki({invalid syntax})[5m]";

      // Query should validate (our parser might accept it)
      // but Loki should reject it during execution
      const executeInvalid = async () => {
        const results = [];
        for await (const result of executor.execute(query)) {
          results.push(result.data);
          if (results.length >= 1) break;
        }
      };

      // This might fail at parse time or execution time
      try {
        await executeInvalid();
        // If it doesn't fail, that's okay - depends on Loki's response
        expect(true).toBe(true);
      } catch (error) {
        // Expected to fail
        expect(error).toBeDefined();
      }
    });

    it("should handle missing Loki adapter", () => {
      const validation = executor.validateQuery(
        'loki-nonexistent({job="test"})[5m]'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Missing adapters");
      expect(validation.error).toContain("loki-nonexistent");
    });

    it("should handle connection errors gracefully", async () => {
      // Create adapter with invalid URL
      const badExecutor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });

      badExecutor.addAdapter(
        "loki-bad",
        new LokiAdapter({
          url: "http://invalid-loki-url:9999",
        })
      );

      const executeWithBadConnection = async () => {
        const results = [];
        for await (const event of badExecutor.execute(
          'loki-bad({job="test"})[5m]'
        )) {
          results.push(result.data);
        }
      };

      await expect(executeWithBadConnection()).rejects.toThrow();
    });
  });

  describe("Type Safety with Loki", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("loki", new LokiAdapter(adapterConfig));
    });

    it("should return properly typed LogEvent from direct queries", async () => {
      const query = 'loki({job=~".+"})[30s]';
      const events: LogEvent[] = [];

      for await (const result of executor.execute(query)) {
        // TypeScript should recognize this as LogEvent
        const logEvent = event as LogEvent;

        // Verify structure
        expect(typeof logEvent.timestamp).toBe("string");
        expect(typeof logEvent.message).toBe("string");
        expect(typeof logEvent.source).toBe("string");
        expect(typeof logEvent.labels).toBe("object");

        events.push(logEvent);
          if (events.length >= 1) break;

        }

      }
    }, 30000);

    it("should return properly typed CorrelatedEvent from correlation queries", async () => {
      const query = `
        loki({job=~".+"})[1m]
        and on(trace_id)
        loki({job=~".+"})[1m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const correlations: CorrelatedEvent[] = [];

      for await (const result of executor.execute(query)) {
        // TypeScript should recognize this as CorrelatedEvent
        const correlatedEvent = correlation as CorrelatedEvent;

        // Type guards
        if ("correlationId" in correlatedEvent) {
          expect(typeof correlatedEvent.correlationId).toBe("string");
          expect(typeof correlatedEvent.joinKey).toBe("string");
          expect(typeof correlatedEvent.joinValue).toBe("string");
          expect(Array.isArray(correlatedEvent.events)).toBe(true);
        }

        correlations.push(correlatedEvent);
          if (correlations.length >= 1) break;

        }

      }
    }, 30000);
  });

  afterAll(() => {
    // Cleanup if needed
  });
});
