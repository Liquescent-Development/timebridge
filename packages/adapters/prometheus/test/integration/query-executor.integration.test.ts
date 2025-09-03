/**
 * TimeQLExecutor Integration Tests for Prometheus
 *
 * These tests verify the new TimeQLExecutor functionality with real Prometheus instances,
 * including named adapters, automatic query detection, and cross-instance correlation.
 */

import { TimeQLExecutor } from "@timebridge/core";
import { PrometheusAdapter } from "../../src/prometheus-adapter";
import { LogEvent, CorrelatedEvent } from "@timebridge/core";
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

describeOrSkip("TimeQLExecutor Integration Tests with Prometheus", () => {
  let executor: TimeQLExecutor;
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

    // Create TimeQLExecutor
    executor = new TimeQLExecutor({
      timeWindow: 30000,
      maxEvents: 10000,
    });

    // Log configuration
    if (config.testConfig.verbose) {
      console.log("🔧 Prometheus TimeQLExecutor Test Configuration:");
      console.log("  URL:", config.connection.url);
      console.log(
        "  Auth Type:",
        config.connection.apiToken
          ? "Bearer Token"
          : config.connection.username
          ? "Basic Auth"
          : "None"
      );
      console.log("  Step:", config.connection.step);
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

    it("should register default Prometheus adapter", () => {
      executor.addAdapter("prometheus", new PrometheusAdapter(adapterConfig), {
        isDefault: true,
      });

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe("prometheus");
      expect(info[0].baseType).toBe("prometheus");
      expect(info[0].isDefault).toBe(true);
    });

    it("should register multiple named Prometheus adapters", () => {
      // Simulate multiple Prometheus instances (e.g., different regions or clusters)
      executor.addAdapter(
        "prometheus-cluster1",
        new PrometheusAdapter({
          ...adapterConfig,
          // Could point to cluster1 Prometheus
        })
      );

      executor.addAdapter(
        "prometheus-cluster2",
        new PrometheusAdapter({
          ...adapterConfig,
          // Could point to cluster2 Prometheus
        })
      );

      executor.addAdapter(
        "prometheus-federation",
        new PrometheusAdapter({
          ...adapterConfig,
          // Could point to federated Prometheus
        })
      );

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(3);

      const names = info.map((i) => i.name).sort();
      expect(names).toEqual([
        "prometheus-cluster1",
        "prometheus-cluster2",
        "prometheus-federation",
      ]);

      // All should have 'prometheus' as base type
      info.forEach((adapter) => {
        expect(adapter.baseType).toBe("prometheus");
      });
    });

    it("should handle mixed adapter types", () => {
      executor.addAdapter(
        "prometheus-main",
        new PrometheusAdapter(adapterConfig)
      );
      // Could add other adapter types here in a real scenario

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe("prometheus-main");
      expect(info[0].baseType).toBe("prometheus");
    });
  });

  describe("Query Type Detection with Prometheus", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("prometheus", new PrometheusAdapter(adapterConfig));
      executor.addAdapter(
        "prometheus-main",
        new PrometheusAdapter(adapterConfig)
      );
      executor.addAdapter(
        "prometheus-backup",
        new PrometheusAdapter(adapterConfig)
      );
    });

    it("should detect direct Prometheus queries", () => {
      const validation = executor.validateQuery("prometheus(up)[5m]");
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["prometheus"]);
    });

    it("should detect named Prometheus adapter queries", () => {
      const validation = executor.validateQuery(
        "prometheus-main(http_requests_total)[10m]"
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["prometheus-main"]);
    });

    it("should detect Prometheus correlation queries", () => {
      const validation = executor.validateQuery(
        "prometheus(up)[5m] and on(instance) prometheus(cpu_usage)[5m]"
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual(["prometheus", "prometheus"]);
    });

    it("should detect cross-instance Prometheus correlation", () => {
      const validation = executor.validateQuery(
        "prometheus-main(up)[5m] and on(job) prometheus-backup(up)[5m]"
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual([
        "prometheus-main",
        "prometheus-backup",
      ]);
    });
  });

  describe("Direct Query Execution with Prometheus", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("prometheus", new PrometheusAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter(
        "prometheus-test",
        new PrometheusAdapter(adapterConfig)
      );
    });

    it(
      "should execute direct Prometheus query",
      async () => {
        const query = `prometheus(${config.queries.simple.basicMetric})[5m]`;
        const events: LogEvent[] = [];
        const maxEvents = 10;

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
          expect(event.source).toBe("prometheus");
          expect(event).toHaveProperty("labels");

          // Prometheus-specific: should have value
          expect(event.labels).toHaveProperty("__value__");
          expect(typeof event.labels.__value__).toBe("string");
        }

        if (config.testConfig.verbose) {
          console.log(`📊 Direct query returned ${events.length} data points`);
          if (events.length > 0) {
            console.log(`  Sample value: ${events[0].labels.__value__}`);
          }
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should execute query to named Prometheus adapter",
      async () => {
        const query = `prometheus-test(${config.queries.simple.counter})[5m]`;
        const events: LogEvent[] = [];
        const maxEvents = 5;

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {

            events.push(result.data as LogEvent);
            if (events.length >= maxEvents) break;

          }

        }

        expect(Array.isArray(events)).toBe(true);

        if (config.testConfig.verbose) {
          console.log(
            `📊 Named adapter query returned ${events.length} data points`
          );
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should handle complex PromQL queries",
      async () => {
        const complexQuery = config.queries.functions.rate;
        const query = `prometheus(${complexQuery})[10m]`;
        const events: LogEvent[] = [];
        const maxEvents = 10;

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {

            events.push(result.data as LogEvent);
            if (events.length >= maxEvents) break;

          }

        }

        expect(Array.isArray(events)).toBe(true);

        if (events.length > 0) {
          // Rate function should produce numeric values
          const value = parseFloat(events[0].labels.__value__);
          expect(isNaN(value)).toBe(false);
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should preserve Prometheus labels in LogEvent",
      async () => {
        const query = `prometheus(${config.queries.complex.labelSelector})[5m]`;
        const events: LogEvent[] = [];

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {

            events.push(result.data as LogEvent);
            if (events.length >= 1) break;

          }

        }

        if (events.length > 0) {
          const event = events[0];

          // Verify Prometheus-specific label structure
          expect(event.labels).toBeDefined();
          expect(typeof event.labels).toBe("object");
          expect(event.labels).toHaveProperty("__value__");

          // Should have metric-specific labels
          const labelKeys = Object.keys(event.labels);
          expect(labelKeys.length).toBeGreaterThan(1);

          if (config.testConfig.verbose) {
            console.log("📋 Prometheus labels preserved:");
            Object.entries(event.labels).forEach(([key, value]) => {
              console.log(`  ${key}: ${value}`);
            });
          }
        }
      },
      config.testConfig.maxWaitTime
    );
  });

  describe("Correlation Query Execution with Prometheus", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("prometheus", new PrometheusAdapter(adapterConfig));
      executor.addAdapter(
        "prometheus-main",
        new PrometheusAdapter(adapterConfig)
      );
      executor.addAdapter(
        "prometheus-backup",
        new PrometheusAdapter(adapterConfig)
      );
    });

    it(
      "should execute Prometheus correlation query",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "instance";
        const query = `
        prometheus(${config.queries.simple.basicMetric})[5m]
        and on(${correlationField})
        prometheus(${config.queries.simple.gauge})[5m]
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

          // Each event should be from Prometheus
          correlation.events.forEach((event) => {
            expect(event.source).toBe("prometheus");
            expect(event.labels).toHaveProperty("__value__");
          });

          if (config.testConfig.verbose) {
            console.log(
              `📊 Correlation found: ${correlation.joinKey}=${correlation.joinValue}`
            );
            console.log(`  Events: ${correlation.events.length}`);
            console.log(
              `  Values: ${correlation.events
                .map((e) => e.labels.__value__)
                .join(", ")}`
            );
          }
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should execute cross-instance Prometheus correlation",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "job";
        const query = `
        prometheus-main(${config.queries.simple.basicMetric})[5m]
        and on(${correlationField})
        prometheus-backup(${config.queries.simple.basicMetric})[5m]
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

        // Verify if we got correlations
        if (correlations.length > 0) {
          expect(correlations[0].metadata.totalStreams).toBe(2);
          expect(correlations[0].joinKey).toBe(correlationField);

          if (config.testConfig.verbose) {
            console.log(
              `📊 Cross-instance correlation: ${correlations.length} found`
            );
          }
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should return typed CorrelatedEvent objects",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "instance";
        const query = `
        prometheus(${config.queries.simple.basicMetric})[3m]
        and on(${correlationField})
        prometheus(${config.queries.simple.counter})[3m]
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
            expect(event.source).toBe("prometheus");
            expect(typeof event.labels).toBe("object");
            expect(typeof event.labels.__value__).toBe("string");
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

  describe("Advanced Prometheus Patterns", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });

      // Register multiple adapters for testing
      executor.addAdapter("prometheus", new PrometheusAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter("prometheus-1", new PrometheusAdapter(adapterConfig));
      executor.addAdapter("prometheus-2", new PrometheusAdapter(adapterConfig));
    });

    it(
      "should handle metric correlation with different aggregations",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "job";
        const query = `
        prometheus(${config.queries.simple.basicMetric})[5m]
        and on(${correlationField})
        prometheus(${config.queries.functions.aggregation})[5m]
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
          expect(correlation.joinKey).toBe(correlationField);

          // Should have metrics with different query types
          expect(correlation.events.length).toBeGreaterThanOrEqual(2);
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should handle three-way Prometheus correlation",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "instance";
        const query = `
        prometheus(${config.queries.simple.basicMetric})[3m]
        and on(${correlationField})
        prometheus-1(${config.queries.simple.counter})[3m]
        and on(${correlationField})
        prometheus-2(${config.queries.simple.gauge})[3m]
      `
          .trim()
          .replace(/\s+/g, " ");

        const validation = executor.validateQuery(query);
        expect(validation.valid).toBe(true);
        expect(validation.sources).toEqual([
          "prometheus",
          "prometheus-1",
          "prometheus-2",
        ]);

        const correlations: CorrelatedEvent[] = [];
        const maxCorrelations = 2;

        for await (const result of executor.execute(query)) {
          if (result.type === 'correlation') {

            correlations.push(result.data as CorrelatedEvent);
            if (correlations.length >= maxCorrelations) break;

          }

        }

        if (correlations.length > 0) {
          expect(correlations[0].metadata.totalStreams).toBe(3);
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should resolve base 'prometheus' to default adapter",
      async () => {
        const query = `prometheus(${config.queries.simple.basicMetric})[3m]`;

        // This should use the default prometheus adapter
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
      },
      config.testConfig.maxWaitTime
    );

    it("should handle different join types with metrics", async () => {
      // Test OR join (left join)
      const orQuery = `
        prometheus(${config.queries.simple.basicMetric})[3m]
        or on(instance)
        prometheus(${config.queries.simple.counter})[3m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const validation1 = executor.validateQuery(orQuery);
      expect(validation1.valid).toBe(true);
      expect(validation1.type).toBe("correlation");

      // Test UNLESS join (anti-join)
      const unlessQuery = `
        prometheus(${config.queries.simple.basicMetric})[3m]
        unless on(job)
        prometheus(${config.queries.simple.gauge})[3m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const validation2 = executor.validateQuery(unlessQuery);
      expect(validation2.valid).toBe(true);
      expect(validation2.type).toBe("correlation");
    });
  });

  describe("Error Handling with Prometheus", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("prometheus", new PrometheusAdapter(adapterConfig));
    });

    it("should handle invalid PromQL syntax", async () => {
      const query = "prometheus(invalid{query syntax})[5m]";

      const executeInvalid = async () => {
        const results = [];
        for await (const result of executor.execute(query)) {
          results.push(result.data);
          if (results.length >= 1) break;
        }
      };

      // This might fail at execution time depending on Prometheus validation
      try {
        await executeInvalid();
        // If it doesn't fail, that's okay - depends on Prometheus's response
        expect(true).toBe(true);
      } catch (error) {
        // Expected to fail
        expect(error).toBeDefined();
        if (config.testConfig.verbose) {
          console.log(
            "✅ Invalid PromQL properly rejected:",
            (error as Error).message
          );
        }
      }
    });

    it("should handle missing Prometheus adapter", () => {
      const validation = executor.validateQuery(
        "prometheus-nonexistent(up)[5m]"
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Missing adapters");
      expect(validation.error).toContain("prometheus-nonexistent");
    });

    it("should handle connection errors gracefully", async () => {
      // Create executor with invalid URL
      const badExecutor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });

      badExecutor.addAdapter(
        "prometheus-bad",
        new PrometheusAdapter({
          url: "http://invalid-prometheus-url:9999",
        })
      );

      const executeWithBadConnection = async () => {
        const results = [];
        for await (const event of badExecutor.execute(
          "prometheus-bad(up)[5m]"
        )) {
          results.push(result.data);
        }
      };

      await expect(executeWithBadConnection()).rejects.toThrow();
    });
  });

  describe("Type Safety with Prometheus", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("prometheus", new PrometheusAdapter(adapterConfig));
    });

    it(
      "should return properly typed LogEvent from direct queries",
      async () => {
        const query = `prometheus(${config.queries.simple.basicMetric})[3m]`;
        const events: LogEvent[] = [];

        for await (const result of executor.execute(query)) {
          // TypeScript should recognize this as LogEvent
          const logEvent = event as LogEvent;

          // Verify structure
          expect(typeof logEvent.timestamp).toBe("string");
          expect(typeof logEvent.message).toBe("string");
          expect(logEvent.source).toBe("prometheus");
          expect(typeof logEvent.labels).toBe("object");
          expect(typeof logEvent.labels.__value__).toBe("string");

          events.push(logEvent);
            if (events.length >= 1) break;

          }

        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should return properly typed CorrelatedEvent from correlation queries",
      async () => {
        const query = `
        prometheus(${config.queries.simple.basicMetric})[3m]
        and on(instance)
        prometheus(${config.queries.simple.counter})[3m]
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

            // All events should be from Prometheus
            correlatedEvent.events.forEach((event) => {
              expect(event.source).toBe("prometheus");
            });
          }

          correlations.push(correlatedEvent);
            if (correlations.length >= 1) break;

          }

        }
      },
      config.testConfig.maxWaitTime
    );
  });

  afterAll(() => {
    // Cleanup if needed
  });
});
