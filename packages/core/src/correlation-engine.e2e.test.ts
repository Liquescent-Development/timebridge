import { TimeBridgeEngine } from "./correlation-engine";
import {
  DataSourceAdapter,
  LogEvent,
  CorrelatedEvent,
  StreamOptions,
} from "./types";

/**
 * Mock adapter that simulates Loki with realistic event patterns
 */
class MockLokiAdapter implements DataSourceAdapter {
  constructor(private events: LogEvent[] = []) {}

  async *createStream(
    selector: string,
    _options?: StreamOptions
  ): AsyncIterable<LogEvent> {
    // Simulate realistic delay
    await new Promise((resolve) => setTimeout(resolve, 10));

    const filters = this.parseSelector(selector);
    const filteredEvents = this.events.filter((event) =>
      this.matchesFilters(event, filters)
    );

    for (const event of filteredEvents) {
      yield { ...event, source: "loki" };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private parseSelector(selector: string): Record<string, string> {
    const filters: Record<string, string> = {};
    const matches = selector.match(/(\w+)=["']?([^"',}]+)["']?/g);
    if (matches) {
      for (const match of matches) {
        const [key, value] = match.split("=");
        filters[key] = value.replace(/["']/g, "");
      }
    }
    return filters;
  }

  private matchesFilters(
    event: LogEvent,
    filters: Record<string, string>
  ): boolean {
    return Object.entries(filters).every(
      ([key, value]) => event.labels[key] === value
    );
  }

  validateQuery(): boolean {
    return true;
  }
  getName(): string {
    return "loki";
  }
  async destroy(): Promise<void> {}
}

/**
 * Mock adapter that simulates Graylog with structured logs
 */
class MockGraylogAdapter implements DataSourceAdapter {
  constructor(private events: LogEvent[] = []) {}

  async *createStream(
    query: string,
    _options?: StreamOptions
  ): AsyncIterable<LogEvent> {
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Simple query parsing for Graylog-style queries
    const filteredEvents = this.events.filter((event) => {
      if (query.includes("service:")) {
        const serviceMatch = query.match(/service:(\w+)/);
        return serviceMatch && event.labels.service === serviceMatch[1];
      }
      return true;
    });

    for (const event of filteredEvents) {
      yield { ...event, source: "graylog" };
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  validateQuery(): boolean {
    return true;
  }
  getName(): string {
    return "graylog";
  }
  async destroy(): Promise<void> {}
}

/**
 * Mock adapter that simulates PromQL metrics
 */
class MockPromQLAdapter implements DataSourceAdapter {
  constructor(private metrics: LogEvent[] = []) {}

  async *createStream(
    query: string,
    _options?: StreamOptions
  ): AsyncIterable<LogEvent> {
    await new Promise((resolve) => setTimeout(resolve, 20));

    const filteredMetrics = this.metrics.filter((metric) => {
      // Simple metric name matching
      const metricNameMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
      return metricNameMatch && metric.labels.__name__ === metricNameMatch[1];
    });

    for (const metric of filteredMetrics) {
      yield { ...metric, source: "promql" };
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  }

  validateQuery(): boolean {
    return true;
  }
  getName(): string {
    return "promql";
  }
  async destroy(): Promise<void> {}
}

describe("Log Correlator End-to-End Tests", () => {
  let engine: TimeBridgeEngine;
  const testTimeout = 30000;

  beforeEach(() => {
    engine = new TimeBridgeEngine({
      timeWindow: 10000, // 10 seconds
      maxEvents: 1000,
      lateTolerance: 2000,
    });
  });

  afterEach(async () => {
    await engine.destroy();
  });

  describe("Complete Query Parsing and Execution", () => {
    it(
      "should parse and execute complex multi-feature queries",
      async () => {
        const frontendLogs: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "User login request received",
            labels: {
              service: "frontend",
              level: "info",
              instance: "frontend-1",
              user_id: "user123",
            },
          },
          {
            timestamp: new Date(Date.now() + 500).toISOString(),
            source: "loki",
            message: "Authentication successful",
            labels: {
              service: "frontend",
              level: "info",
              instance: "frontend-1",
              user_id: "user123",
              session_id: "sess456",
            },
          },
        ];

        const authLogs: LogEvent[] = [
          {
            timestamp: new Date(Date.now() + 200).toISOString(),
            source: "graylog",
            message: "Validating user credentials",
            labels: {
              service: "auth",
              level: "info",
              instance: "auth-2",
              user_id: "user123",
            },
          },
          {
            timestamp: new Date(Date.now() + 300).toISOString(),
            source: "graylog",
            message: "User authenticated successfully",
            labels: {
              service: "auth",
              level: "info",
              instance: "auth-2",
              user_id: "user123",
            },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(frontendLogs));
        engine.addAdapter("graylog", new MockGraylogAdapter(authLogs));

        // Complex query with temporal constraint and grouping
        const query = `loki({service="frontend",level="info"})[10s] and on(user_id) within(2s) group_left(session_id) graylog(service:auth)[10s]`;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(2); // Two frontend events match with auth events
        results.forEach((result) => {
          expect(result.joinKey).toBe("user_id");
          expect(result.joinValue).toBe("user123");
          expect(result.events.length).toBeGreaterThanOrEqual(2);
        });
      },
      testTimeout
    );

    it(
      "should handle label mappings correctly",
      async () => {
        const sessionLogs: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Session created",
            labels: {
              service: "session",
              session_id: "abc123",
              user_type: "premium",
            },
          },
        ];

        const traceLogs: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "graylog",
            message: "Trace started",
            labels: {
              service: "trace",
              trace_id: "abc123", // Same value but different key
              operation: "login",
            },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(sessionLogs));
        engine.addAdapter("graylog", new MockGraylogAdapter(traceLogs));

        const query = `loki({service="session"})[5m] and on(session_id=trace_id) graylog(service:trace)[5m]`;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(1);
        expect(results[0].joinValue).toBe("abc123");
        expect(results[0].events).toHaveLength(2);
      },
      testTimeout
    );

    it(
      "should execute anti-join (unless) queries correctly",
      async () => {
        const allRequests: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Request 1",
            labels: { service: "api", request_id: "req1" },
          },
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Request 2",
            labels: { service: "api", request_id: "req2" },
          },
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Request 3",
            labels: { service: "api", request_id: "req3" },
          },
        ];

        const errorLogs: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "graylog",
            message: "Request failed",
            labels: { service: "api", request_id: "req2", level: "error" },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(allRequests));
        engine.addAdapter("graylog", new MockGraylogAdapter(errorLogs));

        // Find successful requests (those without errors)
        const query = `loki({service="api"})[5m] unless on(request_id) graylog(service:api)[5m]`;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(2); // req1 and req3 (no errors)
        expect(results.map((r) => r.joinValue).sort()).toEqual([
          "req1",
          "req3",
        ]);
      },
      testTimeout
    );

    it(
      "should support post-correlation filtering",
      async () => {
        const apiLogs: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "API request",
            labels: { service: "api", request_id: "req1", status: "200" },
          },
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "API request",
            labels: { service: "api", request_id: "req2", status: "404" },
          },
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "API request",
            labels: { service: "api", request_id: "req3", status: "500" },
          },
        ];

        const dbLogs: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "graylog",
            message: "DB query",
            labels: { service: "database", request_id: "req1" },
          },
          {
            timestamp: new Date().toISOString(),
            source: "graylog",
            message: "DB query",
            labels: { service: "database", request_id: "req2" },
          },
          {
            timestamp: new Date().toISOString(),
            source: "graylog",
            message: "DB query",
            labels: { service: "database", request_id: "req3" },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(apiLogs));
        engine.addAdapter("graylog", new MockGraylogAdapter(dbLogs));

        // Find correlations where status matches 4xx or 5xx errors
        const query = `loki({service="api"})[5m] and on(request_id) graylog(service:database)[5m] {status=~"4..|5.."}`;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(2); // req2 (404) and req3 (500)
        expect(results.map((r) => r.joinValue).sort()).toEqual([
          "req2",
          "req3",
        ]);
      },
      testTimeout
    );
  });

  describe("Real-World Scenarios", () => {
    it(
      "should handle microservices distributed tracing",
      async () => {
        const traceId = "trace-12345";
        const timestamp = new Date().toISOString();

        // Frontend service
        const frontendLogs: LogEvent[] = [
          {
            timestamp,
            source: "loki",
            message: `Incoming request trace_id=${traceId}`,
            labels: {
              service: "frontend",
              trace_id: traceId,
              span_id: "span-1",
              operation: "handleRequest",
            },
          },
        ];

        // Authentication service
        const authLogs: LogEvent[] = [
          {
            timestamp: new Date(Date.now() + 100).toISOString(),
            source: "graylog",
            message: `Authentication request for trace_id=${traceId}`,
            labels: {
              service: "auth",
              trace_id: traceId,
              span_id: "span-2",
              operation: "authenticate",
            },
          },
        ];

        // Database service
        const dbLogs: LogEvent[] = [
          {
            timestamp: new Date(Date.now() + 200).toISOString(),
            source: "loki",
            message: `Database query trace_id=${traceId}`,
            labels: {
              service: "database",
              trace_id: traceId,
              span_id: "span-3",
              operation: "userQuery",
            },
          },
        ];

        engine.addAdapter(
          "loki",
          new MockLokiAdapter([...frontendLogs, ...dbLogs])
        );
        engine.addAdapter("graylog", new MockGraylogAdapter(authLogs));

        // Multi-stream correlation across all services
        const query = `
        loki({service="frontend"})[5m] 
        and on(trace_id) within(5s) 
        graylog(service:auth)[5m]
        and on(trace_id) within(5s)
        loki({service="database"})[5m]
      `;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(1);
        expect(results[0].joinValue).toBe(traceId);
        expect(results[0].events).toHaveLength(3); // All three services
        expect(results[0].metadata.matchedStreams).toEqual([
          "loki",
          "graylog",
          "loki",
        ]);
      },
      testTimeout
    );

    it(
      "should correlate errors across infrastructure components",
      async () => {
        const errorTime = new Date().toISOString();
        const instanceId = "i-1234567890abcdef0";

        // Application errors
        const appErrors: LogEvent[] = [
          {
            timestamp: errorTime,
            source: "loki",
            message: "Application error: Database connection failed",
            labels: {
              service: "app",
              level: "error",
              instance_id: instanceId,
              error_type: "database_connection",
            },
          },
        ];

        // Infrastructure metrics
        const infraMetrics: LogEvent[] = [
          {
            timestamp: new Date(Date.now() - 1000).toISOString(), // 1 second before
            source: "promql",
            message: "cpu_usage=95.5",
            labels: {
              __name__: "cpu_usage",
              instance: instanceId,
              __value__: "95.5",
            },
          },
        ];

        // System logs
        const sysLogs: LogEvent[] = [
          {
            timestamp: new Date(Date.now() - 500).toISOString(), // 500ms before
            source: "graylog",
            message: "High memory pressure detected",
            labels: {
              service: "system",
              level: "warning",
              instance_id: instanceId,
              alert_type: "memory_pressure",
            },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(appErrors));
        engine.addAdapter("promql", new MockPromQLAdapter(infraMetrics));
        engine.addAdapter("graylog", new MockGraylogAdapter(sysLogs));

        // Correlate application errors with infrastructure issues
        const query = `loki({service="app",level="error"})[1m] and on(instance_id=instance) within(2s) promql(cpu_usage)[1m] and on(instance_id) within(2s) graylog(service:system)[1m]`;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(1);
        expect(results[0].events).toHaveLength(3);
        expect(results[0].events.some((e) => e.source === "loki")).toBe(true);
        expect(results[0].events.some((e) => e.source === "promql")).toBe(true);
        expect(results[0].events.some((e) => e.source === "graylog")).toBe(
          true
        );
      },
      testTimeout
    );

    it(
      "should handle performance monitoring with grouped aggregations",
      async () => {
        const requestId = "perf-test-123";

        // Multiple performance measurements
        const perfLogs: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Request processing started",
            labels: {
              service: "api",
              request_id: requestId,
              endpoint: "/users",
              method: "GET",
            },
          },
          {
            timestamp: new Date(Date.now() + 50).toISOString(),
            source: "loki",
            message: "Database query executed",
            labels: {
              service: "api",
              request_id: requestId,
              endpoint: "/users",
              component: "database",
            },
          },
        ];

        // Response time metrics
        const metricsLogs: LogEvent[] = [
          {
            timestamp: new Date(Date.now() + 100).toISOString(),
            source: "promql",
            message: "http_request_duration_seconds=0.157",
            labels: {
              __name__: "http_request_duration_seconds",
              request_id: requestId,
              endpoint: "/users",
              status: "200",
              __value__: "0.157",
            },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(perfLogs));
        engine.addAdapter("promql", new MockPromQLAdapter(metricsLogs));

        // Group by endpoint to aggregate performance data
        const query = `loki({service="api"})[1m] and on(request_id) within(1s) group_left(endpoint,method) promql(http_request_duration_seconds)[1m]`;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(2); // Two API log events grouped with metrics
        results.forEach((result) => {
          expect(result.events.some((e) => e.source === "loki")).toBe(true);
          expect(result.events.some((e) => e.source === "promql")).toBe(true);
          expect(
            result.events.some((e) => e.labels.endpoint === "/users")
          ).toBe(true);
        });
      },
      testTimeout
    );
  });

  describe("Edge Cases and Error Handling", () => {
    it(
      "should handle invalid query syntax gracefully",
      async () => {
        const invalidQueries = [
          "this is not a valid query",
          'loki({service="test"})[5m] invalid_operator other_source',
          'loki({service="test"})[5m] and', // Incomplete query
          'loki({service="test"})[5m] and on() other({service="test"})[5m]', // Empty join keys
          '({service="test"})[5m] and on(id) other({service="test"})[5m]', // Missing source
        ];

        for (const query of invalidQueries) {
          expect(engine.validateQuery(query)).toBe(false);

          await expect(async () => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _ of engine.correlate(query)) {
              // Should not yield any results
            }
          }).rejects.toThrow();
        }
      },
      testTimeout
    );

    it(
      "should handle empty result sets correctly",
      async () => {
        // Setup adapters with non-matching data
        const leftEvents: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Left event",
            labels: { service: "left", id: "left-only" },
          },
        ];

        const rightEvents: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "graylog",
            message: "Right event",
            labels: { service: "right", id: "right-only" },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(leftEvents));
        engine.addAdapter("graylog", new MockGraylogAdapter(rightEvents));

        const query = `loki({service="left"})[5m] and on(id) graylog(service:right)[5m]`;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(0);
      },
      testTimeout
    );

    it(
      "should handle large-scale correlations efficiently",
      async () => {
        // Generate large datasets
        const leftEvents: LogEvent[] = Array.from({ length: 100 }, (_, i) => ({
          timestamp: new Date(Date.now() + i * 10).toISOString(),
          source: "loki",
          message: `Event ${i}`,
          labels: {
            service: "bulk",
            batch_id: `batch-${Math.floor(i / 10)}`,
            item_id: `item-${i}`,
          },
        }));

        const rightEvents: LogEvent[] = Array.from({ length: 50 }, (_, i) => ({
          timestamp: new Date(Date.now() + i * 20).toISOString(),
          source: "graylog",
          message: `Processing batch-${i % 10}`,
          labels: {
            service: "processor",
            batch_id: `batch-${i % 10}`,
          },
        }));

        engine.addAdapter("loki", new MockLokiAdapter(leftEvents));
        engine.addAdapter("graylog", new MockGraylogAdapter(rightEvents));

        const startTime = Date.now();
        const query = `loki({service="bulk"})[5m] and on(batch_id) graylog(service:processor)[5m]`;

        let correlationCount = 0;
        for await (const correlation of engine.correlate(query)) {
          correlationCount++;
          expect(correlation.joinKey).toBe("batch_id");
          if (correlationCount >= 50) break; // Limit for test performance
        }

        const duration = Date.now() - startTime;

        expect(correlationCount).toBeGreaterThan(0);
        expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
      },
      testTimeout
    );

    it(
      "should handle complex label mappings with multiple fields",
      async () => {
        const orderEvents: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Order placed",
            labels: {
              service: "orders",
              order_id: "ord123",
              customer_id: "cust456",
              session_token: "sess789",
            },
          },
        ];

        const paymentEvents: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "graylog",
            message: "Payment processed",
            labels: {
              service: "payments",
              transaction_id: "ord123", // Maps to order_id
              user_id: "cust456", // Maps to customer_id
              session_key: "sess789", // Maps to session_token
            },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(orderEvents));
        engine.addAdapter("graylog", new MockGraylogAdapter(paymentEvents));

        // Complex label mapping with multiple field correlations
        const query = `
        loki({service="orders"})[5m] 
        and on(order_id=transaction_id,customer_id=user_id,session_token=session_key) 
        graylog(service:payments)[5m]
      `;

        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        expect(results).toHaveLength(1);
        expect(results[0].events).toHaveLength(2);
      },
      testTimeout
    );

    it(
      "should handle adapter failures gracefully",
      async () => {
        // Test with non-existent adapter
        const query = `nonexistent({service="test"})[5m] and on(id) nonexistent({service="test"})[5m]`;

        await expect(async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of engine.correlate(query)) {
            // Should not reach here
          }
        }).rejects.toThrow("Required data source adapter not found");
      },
      testTimeout
    );
  });

  describe("Integration Between Components", () => {
    it(
      "should integrate parser → engine → joiner → results seamlessly",
      async () => {
        // Test the full pipeline with a complex query
        const complexEvents: LogEvent[] = [
          {
            timestamp: new Date().toISOString(),
            source: "loki",
            message: "Complex event 1",
            labels: {
              service: "frontend",
              request_id: "req123",
              user_id: "user456",
              status: "started",
            },
          },
          {
            timestamp: new Date(Date.now() + 100).toISOString(),
            source: "graylog",
            message: "Complex event 2",
            labels: {
              service: "backend",
              request_id: "req123",
              operation: "processing",
              status: "success",
            },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter([complexEvents[0]]));
        engine.addAdapter(
          "graylog",
          new MockGraylogAdapter([complexEvents[1]])
        );

        // Complex query with multiple modifiers
        const query = `loki({service="frontend",status="started"})[2m] and on(request_id) within(1s) group_left(user_id) ignoring(status) graylog(service:backend)[2m] {status="success"}`;

        // Verify parsing
        expect(engine.validateQuery(query)).toBe(true);

        // Execute full pipeline
        const results: CorrelatedEvent[] = [];
        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);
        }

        // Verify results - with group_left, we get one correlation per left event
        expect(results).toHaveLength(1);
        expect(results[0].joinKey).toBe("request_id");
        expect(results[0].joinValue).toBe("req123");
        // Post-filter {status="success"} filters to only events with that status
        // The loki event has status="started", so it gets filtered out
        expect(results[0].events).toHaveLength(1);
        expect(results[0].events[0].source).toBe("graylog");
        expect(results[0].events[0].labels.status).toBe("success");
      },
      testTimeout
    );

    it(
      "should handle real-time vs batch processing modes",
      async () => {
        const batchEvents: LogEvent[] = Array.from({ length: 10 }, (_, i) => ({
          timestamp: new Date(Date.now() + i * 100).toISOString(),
          source: "loki",
          message: `Batch event ${i}`,
          labels: {
            service: "batch",
            job_id: "job123",
            batch_num: String(i),
          },
        }));

        const processingEvents: LogEvent[] = [
          {
            timestamp: new Date(Date.now() + 500).toISOString(),
            source: "graylog",
            message: "Job completed",
            labels: {
              service: "processor",
              job_id: "job123",
              status: "completed",
            },
          },
        ];

        engine.addAdapter("loki", new MockLokiAdapter(batchEvents));
        engine.addAdapter("graylog", new MockGraylogAdapter(processingEvents));

        const query = `
        loki({service="batch"})[1m] 
        and on(job_id) 
        group_left(batch_num)
        graylog(service:processor)[1m]
      `;

        // Test streaming results
        const results: CorrelatedEvent[] = [];
        const startTime = Date.now();

        for await (const correlation of engine.correlate(query)) {
          results.push(correlation);

          // Verify streaming behavior - results arrive over time
          const elapsedTime = Date.now() - startTime;
          expect(elapsedTime).toBeGreaterThan(0);

          if (results.length >= 5) break; // Limit for test
        }

        expect(results.length).toBeGreaterThan(0);
        results.forEach((result) => {
          expect(result.joinValue).toBe("job123");
          expect(result.events.length).toBeGreaterThanOrEqual(2);
        });
      },
      testTimeout
    );

    it(
      "should maintain performance metrics throughout pipeline",
      async () => {
        const testEvents: LogEvent[] = Array.from({ length: 50 }, (_, i) => ({
          timestamp: new Date(Date.now() + i).toISOString(),
          source: "loki",
          message: `Performance test ${i}`,
          labels: {
            service: "perf",
            test_id: "test123",
          },
        }));

        engine.addAdapter("loki", new MockLokiAdapter(testEvents));
        engine.addAdapter(
          "graylog",
          new MockGraylogAdapter(testEvents.slice(0, 25))
        );

        let metricsReceived = false;
        const metricsPromise = new Promise<void>((resolve) => {
          engine.on("performanceMetrics", (metrics) => {
            expect(metrics).toHaveProperty("eventsProcessed");
            expect(metrics).toHaveProperty("throughput");
            expect(metrics).toHaveProperty("memoryUsage");
            expect(metrics.eventsProcessed).toBeGreaterThan(0);
            metricsReceived = true;
            resolve();
          });
        });

        const query = `loki({service="perf"})[1m] and on(test_id) graylog(service:perf)[1m]`;

        let correlationCount = 0;
        for await (const correlation of engine.correlate(query)) {
          correlationCount++;
          expect(correlation.joinValue).toBe("test123");
          if (correlationCount >= 10) break;
        }

        await metricsPromise;
        expect(metricsReceived).toBe(true);
      },
      testTimeout
    );
  });
});
