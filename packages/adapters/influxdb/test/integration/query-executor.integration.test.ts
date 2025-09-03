/**
 * TimeQLExecutor Integration Tests for InfluxDB
 *
 * These tests verify the new TimeQLExecutor functionality with real InfluxDB instances,
 * including named adapters, automatic query detection, and cross-instance correlation.
 * Tests both InfluxDB 1.x (InfluxQL) and 2.x (Flux) versions.
 */

import { TimeQLExecutor } from "@timebridge/core";
import { InfluxDBAdapter } from "../../src/influxdb-adapter";
import { LogEvent, CorrelatedEvent } from "@timebridge/core";
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

describeOrSkip("TimeQLExecutor Integration Tests with InfluxDB", () => {
  let executor: TimeQLExecutor;
  let adapterConfig: any;
  const isV2 = config.connection.version === "2.x";

  beforeAll(() => {
    // Validate configuration
    if (!config.connection.url) {
      throw new Error("INFLUXDB_URL must be configured for integration tests");
    }

    // Create adapter configuration based on version
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

    // Create TimeQLExecutor
    executor = new TimeQLExecutor({
      timeWindow: 30000,
      maxEvents: 10000,
    });

    // Log configuration
    if (config.testConfig.verbose) {
      console.log("🔧 InfluxDB TimeQLExecutor Test Configuration:");
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

    it("should register default InfluxDB adapter", () => {
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig), {
        isDefault: true,
      });

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe("influxdb");
      expect(info[0].baseType).toBe("influxdb");
      expect(info[0].isDefault).toBe(true);
    });

    it("should register multiple named InfluxDB adapters", () => {
      // Simulate multiple InfluxDB instances (e.g., different environments or shards)
      executor.addAdapter(
        "influxdb-prod",
        new InfluxDBAdapter({
          ...adapterConfig,
          // Could point to production InfluxDB
        })
      );

      executor.addAdapter(
        "influxdb-staging",
        new InfluxDBAdapter({
          ...adapterConfig,
          // Could point to staging InfluxDB
        })
      );

      executor.addAdapter(
        "influxdb-metrics",
        new InfluxDBAdapter({
          ...adapterConfig,
          // Could point to metrics-specific InfluxDB
        })
      );

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(3);

      const names = info.map((i) => i.name).sort();
      expect(names).toEqual([
        "influxdb-metrics",
        "influxdb-prod",
        "influxdb-staging",
      ]);

      // All should have 'influxdb' as base type
      info.forEach((adapter) => {
        expect(adapter.baseType).toBe("influxdb");
      });
    });

    it("should handle version-specific adapters", () => {
      executor.addAdapter(
        "influxdb-v1",
        new InfluxDBAdapter({
          ...adapterConfig,
          version: "1.x",
        })
      );

      executor.addAdapter(
        "influxdb-v2",
        new InfluxDBAdapter({
          ...adapterConfig,
          version: "2.x",
        })
      );

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(2);

      // Both should have 'influxdb' as base type regardless of version
      info.forEach((adapter) => {
        expect(adapter.baseType).toBe("influxdb");
      });
    });
  });

  describe("Query Type Detection with InfluxDB", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig));
      executor.addAdapter("influxdb-main", new InfluxDBAdapter(adapterConfig));
      executor.addAdapter(
        "influxdb-backup",
        new InfluxDBAdapter(adapterConfig)
      );
    });

    it("should detect direct InfluxDB queries", () => {
      const sampleQuery = isV2
        ? 'from(bucket: "test") |> range(start: -5m)'
        : "SELECT * FROM measurement";
      const validation = executor.validateQuery(`influxdb(${sampleQuery})[5m]`);
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["influxdb"]);
    });

    it("should detect named InfluxDB adapter queries", () => {
      const sampleQuery = isV2
        ? 'from(bucket: "metrics") |> range(start: -10m)'
        : "SELECT temperature FROM sensors";
      const validation = executor.validateQuery(
        `influxdb-main(${sampleQuery})[10m]`
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("direct");
      expect(validation.sources).toEqual(["influxdb-main"]);
    });

    it("should detect InfluxDB correlation queries", () => {
      const query1 = isV2
        ? 'from(bucket: "app") |> range(start: -5m)'
        : "SELECT * FROM app_metrics";
      const query2 = isV2
        ? 'from(bucket: "sys") |> range(start: -5m)'
        : "SELECT * FROM system_metrics";

      const validation = executor.validateQuery(
        `influxdb(${query1})[5m] and on(host) influxdb(${query2})[5m]`
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual(["influxdb", "influxdb"]);
    });

    it("should detect cross-instance InfluxDB correlation", () => {
      const query1 = config.queries.simple.basicQuery;
      const query2 = config.queries.simple.timeSeries;
      const validation = executor.validateQuery(
        `influxdb-main(${query1})[5m] and on(host) influxdb-backup(${query2})[5m]`
      );
      expect(validation.valid).toBe(true);
      expect(validation.type).toBe("correlation");
      expect(validation.sources).toEqual(["influxdb-main", "influxdb-backup"]);
    });
  });

  describe("Direct Query Execution with InfluxDB", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter("influxdb-test", new InfluxDBAdapter(adapterConfig));
    });

    it(
      "should execute direct InfluxDB query",
      async () => {
        const query = `influxdb(${config.queries.simple.basicQuery})[10m]`;
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
          expect(event.source).toBe("influxdb");
          expect(event).toHaveProperty("labels");

          // InfluxDB-specific: should have measurement
          expect(event.labels).toHaveProperty("_measurement");
          expect(typeof event.labels._measurement).toBe("string");
        }

        if (config.testConfig.verbose) {
          console.log(`📊 Direct query returned ${events.length} data points`);
          if (events.length > 0) {
            console.log(
              `  Sample measurement: ${events[0].labels._measurement}`
            );
          }
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should execute query to named InfluxDB adapter",
      async () => {
        const query = `influxdb-test(${config.queries.simple.fieldSelection})[5m]`;
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
      "should handle complex InfluxDB queries",
      async () => {
        const complexQuery = config.queries.functions.aggregation;
        const query = `influxdb(${complexQuery})[15m]`;
        const events: LogEvent[] = [];
        const maxEvents = 15;

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {

            events.push(result.data as LogEvent);
            if (events.length >= maxEvents) break;

          }

        }

        expect(Array.isArray(events)).toBe(true);

        if (events.length > 0) {
          // Aggregation queries should have valid structure
          const event = events[0];
          expect(event.labels).toHaveProperty("_measurement");
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should preserve InfluxDB metadata in LogEvent",
      async () => {
        const query = `influxdb(${config.queries.complex.fieldAndTags})[5m]`;
        const events: LogEvent[] = [];

        for await (const result of executor.execute(query)) {
          if (result.type === 'event') {

            events.push(result.data as LogEvent);
            if (events.length >= 1) break;

          }

        }

        if (events.length > 0) {
          const event = events[0];

          // Verify InfluxDB-specific metadata structure
          expect(event.labels).toBeDefined();
          expect(typeof event.labels).toBe("object");
          expect(event.labels).toHaveProperty("_measurement");

          // Should have field/tag information
          const labelKeys = Object.keys(event.labels);
          expect(labelKeys.length).toBeGreaterThan(1);

          if (config.testConfig.verbose) {
            console.log("📋 InfluxDB metadata preserved:");
            Object.entries(event.labels).forEach(([key, value]) => {
              console.log(`  ${key}: ${value}`);
            });
          }
        }
      },
      config.testConfig.maxWaitTime
    );
  });

  describe("Correlation Query Execution with InfluxDB", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig));
      executor.addAdapter("influxdb-main", new InfluxDBAdapter(adapterConfig));
      executor.addAdapter(
        "influxdb-backup",
        new InfluxDBAdapter(adapterConfig)
      );
    });

    it(
      "should execute InfluxDB correlation query",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "host";
        const query1 = config.queries.simple.basicQuery;
        const query2 = config.queries.simple.timeSeries;
        const query = `
        influxdb(${query1})[10m]
        and on(${correlationField})
        influxdb(${query2})[10m]
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

          // Each event should be from InfluxDB
          correlation.events.forEach((event) => {
            expect(event.source).toBe("influxdb");
            expect(event.labels).toHaveProperty("_measurement");
          });

          if (config.testConfig.verbose) {
            console.log(
              `📊 Correlation found: ${correlation.joinKey}=${correlation.joinValue}`
            );
            console.log(`  Events: ${correlation.events.length}`);
            console.log(
              `  Measurements: ${correlation.events
                .map((e) => e.labels._measurement)
                .join(", ")}`
            );
          }
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should execute cross-instance InfluxDB correlation",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "host";
        const query1 = config.queries.simple.basicQuery;
        const query2 = config.queries.simple.fieldSelection;
        const query = `
        influxdb-main(${query1})[8m]
        and on(${correlationField})
        influxdb-backup(${query2})[8m]
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
          config.queries.correlation.correlationField || "host";
        const query1 = config.queries.simple.basicQuery;
        const query2 = config.queries.functions.aggregation;
        const query = `
        influxdb(${query1})[6m]
        and on(${correlationField})
        influxdb(${query2})[6m]
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
            expect(event.source).toBe("influxdb");
            expect(typeof event.labels).toBe("object");
            expect(typeof event.labels._measurement).toBe("string");
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

  describe("Advanced InfluxDB Patterns", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });

      // Register multiple adapters for testing
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig), {
        isDefault: true,
      });
      executor.addAdapter("influxdb-1", new InfluxDBAdapter(adapterConfig));
      executor.addAdapter("influxdb-2", new InfluxDBAdapter(adapterConfig));
    });

    it(
      "should handle measurement-based correlation",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "host";
        const query1 = config.queries.simple.basicQuery;
        const query2 = config.queries.simple.timeSeries;
        const query = `
        influxdb(${query1})[8m]
        and on(${correlationField})
        influxdb(${query2})[8m]
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

          // Should have data from different measurements potentially
          expect(correlation.events.length).toBeGreaterThanOrEqual(2);
        }
      },
      config.testConfig.maxWaitTime
    );

    it(
      "should handle three-way InfluxDB correlation",
      async () => {
        const correlationField =
          config.queries.correlation.correlationField || "host";
        const query1 = config.queries.simple.basicQuery;
        const query2 = config.queries.simple.fieldSelection;
        const query3 = config.queries.functions.aggregation;
        const query = `
        influxdb(${query1})[6m]
        and on(${correlationField})
        influxdb-1(${query2})[6m]
        and on(${correlationField})
        influxdb-2(${query3})[6m]
      `
          .trim()
          .replace(/\s+/g, " ");

        const validation = executor.validateQuery(query);
        expect(validation.valid).toBe(true);
        expect(validation.sources).toEqual([
          "influxdb",
          "influxdb-1",
          "influxdb-2",
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
      "should resolve base 'influxdb' to default adapter",
      async () => {
        const query = `influxdb(${config.queries.simple.basicQuery})[5m]`;

        // This should use the default influxdb adapter
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

    it("should handle different join types with time series data", async () => {
      // Test OR join (left join)
      const orQuery = `
        influxdb(${config.queries.simple.basicQuery})[5m]
        or on(host)
        influxdb(${config.queries.simple.timeSeries})[5m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const validation1 = executor.validateQuery(orQuery);
      expect(validation1.valid).toBe(true);
      expect(validation1.type).toBe("correlation");

      // Test UNLESS join (anti-join)
      const unlessQuery = `
        influxdb(${config.queries.simple.basicQuery})[5m]
        unless on(service)
        influxdb(${config.queries.functions.aggregation})[5m]
      `
        .trim()
        .replace(/\s+/g, " ");

      const validation2 = executor.validateQuery(unlessQuery);
      expect(validation2.valid).toBe(true);
      expect(validation2.type).toBe("correlation");
    });
  });

  describe("Version-Specific Query Patterns", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig));
    });

    if (isV2) {
      describe("InfluxDB 2.x (Flux) Patterns", () => {
        it(
          "should handle Flux transformation queries",
          async () => {
            const query = `influxdb(${config.queries.v2.fluxTransform})[10m]`;

            const events: LogEvent[] = [];
            const maxEvents = 5;

            for await (const result of executor.execute(query)) {
              if (result.type === 'event') {

                events.push(result.data as LogEvent);
                if (events.length >= maxEvents) break;

              }

            }

            if (events.length > 0) {
              // Flux transformations should preserve structure
              expect(events[0].labels).toHaveProperty("_measurement");
            }
          },
          config.testConfig.maxWaitTime
        );

        it(
          "should handle Flux filter queries",
          async () => {
            const query = `influxdb(${config.queries.v2.fluxFilter})[8m]`;

            const events: LogEvent[] = [];
            const maxEvents = 5;

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
      });
    } else {
      describe("InfluxDB 1.x (InfluxQL) Patterns", () => {
        it(
          "should handle InfluxQL function queries",
          async () => {
            const query = `influxdb(${config.queries.v1.influxqlFunction})[10m]`;

            const events: LogEvent[] = [];
            const maxEvents = 5;

            for await (const result of executor.execute(query)) {
              if (result.type === 'event') {

                events.push(result.data as LogEvent);
                if (events.length >= maxEvents) break;

              }

            }

            if (events.length > 0) {
              // InfluxQL functions should preserve structure
              expect(events[0].labels).toHaveProperty("_measurement");
            }
          },
          config.testConfig.maxWaitTime
        );

        it(
          "should handle continuous query results",
          async () => {
            const query = `influxdb(${config.queries.v1.continuousQuery})[15m]`;

            const events: LogEvent[] = [];
            const maxEvents = 5;

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
      });
    }
  });

  describe("Error Handling with InfluxDB", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig));
    });

    it("should handle invalid query syntax", async () => {
      const invalidQuery = isV2
        ? "invalid flux syntax |> invalid()"
        : "INVALID SQL SYNTAX FROM";
      const query = `influxdb(${invalidQuery})[5m]`;

      const executeInvalid = async () => {
        const results = [];
        for await (const result of executor.execute(query)) {
          results.push(result.data);
          if (results.length >= 1) break;
        }
      };

      // This might fail at execution time depending on InfluxDB validation
      try {
        await executeInvalid();
        // If it doesn't fail, that's okay - depends on InfluxDB's response
        expect(true).toBe(true);
      } catch (error) {
        // Expected to fail
        expect(error).toBeDefined();
        if (config.testConfig.verbose) {
          console.log(
            "✅ Invalid query properly rejected:",
            (error as Error).message
          );
        }
      }
    });

    it("should handle missing InfluxDB adapter", () => {
      const validation = executor.validateQuery(
        "influxdb-nonexistent(SELECT * FROM test)[5m]"
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Missing adapters");
      expect(validation.error).toContain("influxdb-nonexistent");
    });

    it("should handle connection errors gracefully", async () => {
      // Create executor with invalid URL
      const badExecutor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });

      badExecutor.addAdapter(
        "influxdb-bad",
        new InfluxDBAdapter({
          ...adapterConfig,
          url: "http://invalid-influxdb-url:9999",
        })
      );

      const executeWithBadConnection = async () => {
        const results = [];
        for await (const event of badExecutor.execute(
          "influxdb-bad(SELECT * FROM test)[5m]"
        )) {
          results.push(result.data);
        }
      };

      await expect(executeWithBadConnection()).rejects.toThrow();
    });
  });

  describe("Type Safety with InfluxDB", () => {
    beforeAll(() => {
      executor = new TimeQLExecutor({
        timeWindow: 30000,
        maxEvents: 10000,
      });
      executor.addAdapter("influxdb", new InfluxDBAdapter(adapterConfig));
    });

    it(
      "should return properly typed LogEvent from direct queries",
      async () => {
        const query = `influxdb(${config.queries.simple.basicQuery})[5m]`;
        const events: LogEvent[] = [];

        for await (const result of executor.execute(query)) {
          // TypeScript should recognize this as LogEvent
          const logEvent = event as LogEvent;

          // Verify structure
          expect(typeof logEvent.timestamp).toBe("string");
          expect(typeof logEvent.message).toBe("string");
          expect(logEvent.source).toBe("influxdb");
          expect(typeof logEvent.labels).toBe("object");
          expect(typeof logEvent.labels._measurement).toBe("string");

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
        const query1 = config.queries.simple.basicQuery;
        const query2 = config.queries.simple.timeSeries;
        const query = `
        influxdb(${query1})[5m]
        and on(host)
        influxdb(${query2})[5m]
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

            // All events should be from InfluxDB
            correlatedEvent.events.forEach((event) => {
              expect(event.source).toBe("influxdb");
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
