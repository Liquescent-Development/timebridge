/**
 * Backward Compatibility Test Suite
 * 
 * Ensures that all existing code continues to work unchanged after adding
 * Grafana data source support. Tests verify that:
 * 1. Direct connections work as before
 * 2. All configuration options are preserved
 * 3. Query syntax remains unchanged
 * 4. Streaming interfaces are maintained
 * 5. Parser functionality is preserved
 */

import { PrometheusAdapter } from "../prometheus/src/prometheus-adapter";
import { LokiAdapter } from "../loki/src/loki-adapter";
import { InfluxDBAdapter } from "../influxdb/src/influxdb-adapter";
import fetch from "node-fetch";

jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("Backward Compatibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Direct Connection Mode", () => {
    describe("PrometheusAdapter", () => {
      it("should work with direct Prometheus URL", async () => {
        // Mock direct Prometheus (no Grafana)
        mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));

        const adapter = new PrometheusAdapter({
          url: "http://prometheus:9090",
          authToken: "prometheus-token",
        });

        // Mock Prometheus API response
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              resultType: "vector",
              result: [
                {
                  metric: { __name__: "up", job: "prometheus", instance: "localhost:9090" },
                  value: [1704067200, "1"],
                },
              ],
            },
          }),
        } as any);

        const events = [];
        for await (const event of adapter.query("up")) {
          events.push(event);
        }

        expect(events).toHaveLength(1);
        expect(events[0].labels.job).toBe("prometheus");
        expect(events[0].labels.__value__).toBe("1");
      });

      it("should support all original configuration options", () => {
        // This should not throw
        const adapter = new PrometheusAdapter({
          url: "http://prometheus:9090",
          authToken: "token",
          proxy: {
            host: "socks5://proxy.example.com",
            port: 1080,
            auth: { username: "user", password: "pass" },
          },
        });

        expect(adapter).toBeDefined();
      });

      it("should support instant queries", async () => {
        mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));

        const adapter = new PrometheusAdapter({
          url: "http://prometheus:9090",
          authToken: "token",
        });

        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              resultType: "vector",
              result: [
                {
                  metric: { __name__: "up" },
                  value: [1704067200, "1"],
                },
              ],
            },
          }),
        } as any);

        const result = await adapter.instantQuery("up");
        const events = [];
        for await (const event of result) {
          events.push(event);
        }

        expect(events).toHaveLength(1);
      });

      it("should support metadata queries", async () => {
        mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));

        const adapter = new PrometheusAdapter({
          url: "http://prometheus:9090",
        });

        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              http_requests_total: [
                {
                  type: "counter",
                  help: "Total number of HTTP requests",
                },
              ],
            },
          }),
        } as any);

        const metadata = await adapter.getMetadata("http_requests_total");
        expect(metadata.data.http_requests_total).toBeDefined();
      });
    });

    describe("LokiAdapter", () => {
      it("should work with direct Loki URL", async () => {
        mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));

        const adapter = new LokiAdapter({
          url: "http://loki:3100",
          basicAuth: { username: "loki", password: "password" },
        });

        // Mock Loki API response
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              result: [
                {
                  stream: { service: "nginx", level: "error" },
                  values: [["1704067200000000000", 'level=error msg="Connection refused"']],
                },
              ],
            },
          }),
        } as any);

        const events = [];
        for await (const event of adapter.query('{service="nginx"}')) {
          events.push(event);
        }

        expect(events).toHaveLength(1);
        expect(events[0].labels.service).toBe("nginx");
        expect(events[0].message).toContain("Connection refused");
      });

      it("should support WebSocket mode", () => {
        const adapter = new LokiAdapter({
          url: "ws://loki:3100",
          useWebSocket: true,
        });

        expect(adapter).toBeDefined();
        // WebSocket functionality is preserved
      });

      it("should support query options", async () => {
        mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));

        const adapter = new LokiAdapter({
          url: "http://loki:3100",
        });

        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "success",
            data: { result: [] },
          }),
        } as any);

        await adapter
          .query('{service="test"}', {
            limit: 100,
            start: new Date("2024-01-01"),
            end: new Date("2024-01-02"),
            direction: "backward",
          })
          .next();

        // Verify query parameters were sent
        const url = mockedFetch.mock.calls[1][0] as string;
        expect(url).toContain("limit=100");
        expect(url).toContain("direction=backward");
      });
    });

    describe("InfluxDBAdapter", () => {
      it("should work with direct InfluxDB 1.x URL", async () => {
        mockedFetch
          .mockRejectedValueOnce(new Error("Not Grafana"))
          .mockResolvedValueOnce({
            ok: true,
            headers: new Map([["x-influxdb-version", "1.8.10"]]),
          } as any);

        const adapter = new InfluxDBAdapter({
          url: "http://influxdb:8086",
          authToken: "influx-token",
          database: "telegraf",
        });

        // Mock InfluxDB query response
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                series: [
                  {
                    name: "cpu",
                    columns: ["time", "usage_idle", "host"],
                    values: [[1704067200000, 95.5, "server1"]],
                  },
                ],
              },
            ],
          }),
        } as any);

        const events = [];
        for await (const event of adapter.query('SELECT usage_idle FROM "cpu" LIMIT 1')) {
          events.push(event);
        }

        expect(events).toHaveLength(1);
        expect(events[0].fields.usage_idle).toBe(95.5);
        expect(events[0].tags.host).toBe("server1");
      });

      it("should work with direct InfluxDB 2.x URL", async () => {
        mockedFetch
          .mockRejectedValueOnce(new Error("Not Grafana"))
          .mockResolvedValueOnce({
            ok: true,
            headers: new Map([["x-influxdb-version", "2.7.0"]]),
          } as any);

        const adapter = new InfluxDBAdapter({
          url: "http://influxdb:8086",
          authToken: "influx-token",
          org: "my-org",
          bucket: "my-bucket",
        });

        // Mock Flux query response
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => `#group,false,false,true,true,false,false,true,true
#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string
#default,_result,,,,,,,
,result,table,_start,_stop,_time,_value,_field,_measurement
,,0,2024-01-01T00:00:00Z,2024-01-02T00:00:00Z,2024-01-01T12:00:00Z,42.5,temperature,sensor`,
        } as any);

        const fluxQuery = `
          from(bucket: "my-bucket")
          |> range(start: -1h)
          |> filter(fn: (r) => r._measurement == "sensor")
        `;

        const events = [];
        for await (const event of adapter.query(fluxQuery)) {
          events.push(event);
        }

        expect(events).toHaveLength(1);
        expect(events[0].fields._value).toBe(42.5);
      });

      it("should support all InfluxDB configuration options", () => {
        // InfluxDB 1.x config
        const adapter1x = new InfluxDBAdapter({
          url: "http://influxdb:8086",
          authToken: "token",
          database: "telegraf",
          retentionPolicy: "autogen",
        });

        // InfluxDB 2.x config
        const adapter2x = new InfluxDBAdapter({
          url: "http://influxdb:8086",
          authToken: "token",
          org: "my-org",
          bucket: "my-bucket",
        });

        expect(adapter1x).toBeDefined();
        expect(adapter2x).toBeDefined();
      });
    });
  });

  describe("Query Syntax Preservation", () => {
    it("should support all PromQL syntax unchanged", () => {
      const adapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
      });

      const queries = [
        "up",
        'up{job="prometheus"}',
        "rate(http_requests_total[5m])",
        "sum by (job) (rate(http_requests_total[5m]))",
        "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))",
        'avg_over_time(up[5m]) > bool 0.5',
      ];

      queries.forEach((query) => {
        const result = adapter.parseQuery(query);
        expect(result.isValid).toBe(true);
      });
    });

    it("should support all LogQL syntax unchanged", () => {
      const adapter = new LokiAdapter({
        url: "http://loki:3100",
      });

      const queries = [
        '{job="nginx"}',
        '{job="nginx"} |= "error"',
        '{job="nginx"} | json | status >= 400',
        'rate({job="nginx"}[5m])',
        'sum by (level) (rate({job="nginx"} | json | line_format "{{.level}}" [5m]))',
      ];

      queries.forEach((query) => {
        const result = adapter.parseQuery(query);
        expect(result.isValid).toBe(true);
      });
    });

    it("should support all InfluxQL syntax unchanged", () => {
      const adapter = new InfluxDBAdapter({
        url: "http://influxdb:8086",
        database: "telegraf",
      });

      const queries = [
        'SELECT * FROM "cpu"',
        'SELECT mean("usage_idle") FROM "cpu" WHERE time > now() - 1h',
        'SELECT mean("usage_idle") FROM "cpu" GROUP BY time(5m), "host"',
        'SELECT DERIVATIVE(mean("usage_idle"), 1s) FROM "cpu"',
        'SHOW MEASUREMENTS',
        'SHOW TAG KEYS FROM "cpu"',
      ];

      queries.forEach((query) => {
        const result = adapter.parseQuery(query);
        expect(result.isValid).toBe(true);
      });
    });
  });

  describe("Streaming Interface Preservation", () => {
    it("should maintain AsyncIterable interface for all adapters", async () => {
      // Prometheus
      const prometheusAdapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
      });
      const promStream = prometheusAdapter.query("up");
      expect(typeof promStream[Symbol.asyncIterator]).toBe("function");

      // Loki
      const lokiAdapter = new LokiAdapter({
        url: "http://loki:3100",
      });
      const lokiStream = lokiAdapter.query('{service="test"}');
      expect(typeof lokiStream[Symbol.asyncIterator]).toBe("function");

      // InfluxDB
      const influxAdapter = new InfluxDBAdapter({
        url: "http://influxdb:8086",
        database: "test",
      });
      const influxStream = influxAdapter.query('SELECT * FROM "cpu"');
      expect(typeof influxStream[Symbol.asyncIterator]).toBe("function");
    });

    it("should support for-await-of loops", async () => {
      mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));

      const adapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
      });

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              { metric: { job: "api" }, value: [1704067200, "1"] },
              { metric: { job: "frontend" }, value: [1704067200, "1"] },
              { metric: { job: "backend" }, value: [1704067200, "1"] },
            ],
          },
        }),
      } as any);

      let count = 0;
      for await (const event of adapter.query("up")) {
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("labels");
        expect(event).toHaveProperty("source");
        count++;
      }

      expect(count).toBe(3);
    });
  });

  describe("Parser Functionality", () => {
    it("should validate queries regardless of connection type", () => {
      const prometheusAdapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
      });

      // Valid query
      let result = prometheusAdapter.parseQuery("rate(http_requests_total[5m])");
      expect(result.isValid).toBe(true);
      expect(result.ast).toBeDefined();

      // Invalid query
      result = prometheusAdapter.parseQuery("rate(invalid[");
      expect(result.isValid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it("should extract metadata from parsed queries", () => {
      const lokiAdapter = new LokiAdapter({
        url: "http://loki:3100",
      });

      const result = lokiAdapter.parseQuery('{service="nginx"} |= "error" | json');
      expect(result.isValid).toBe(true);
      expect(result.queryType).toBe("log");

      const metricResult = lokiAdapter.parseQuery('rate({service="nginx"}[5m])');
      expect(metricResult.isValid).toBe(true);
      expect(metricResult.queryType).toBe("metric");
    });
  });

  describe("Authentication Methods", () => {
    it("should support all original authentication methods", () => {
      // Bearer token
      new PrometheusAdapter({
        url: "http://prometheus:9090",
        authToken: "Bearer token123",
      });

      // API token
      new PrometheusAdapter({
        url: "http://prometheus:9090",
        authToken: "token123",
      });

      // Basic auth
      new LokiAdapter({
        url: "http://loki:3100",
        basicAuth: {
          username: "user",
          password: "pass",
        },
      });

      // No auth
      new InfluxDBAdapter({
        url: "http://influxdb:8086",
        database: "test",
      });

      // All should create successfully
      expect(true).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle connection errors as before", async () => {
      mockedFetch.mockRejectedValue(new Error("Connection refused"));

      const adapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
      });

      await expect(adapter.query("up").next()).rejects.toThrow("Connection refused");
    });

    it("should handle query errors as before", async () => {
      mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));

      const adapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
      });

      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "Invalid query",
      } as any);

      await expect(adapter.query("invalid{").next()).rejects.toThrow();
    });
  });

  describe("Configuration Options", () => {
    it("should accept all original PrometheusAdapter options", () => {
      const adapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
        authToken: "token",
        proxy: {
          host: "socks5://proxy.example.com",
          port: 1080,
        },
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      });

      expect(adapter).toBeDefined();
    });

    it("should accept all original LokiAdapter options", () => {
      const adapter = new LokiAdapter({
        url: "http://loki:3100",
        basicAuth: {
          username: "user",
          password: "pass",
        },
        useWebSocket: true,
        proxy: {
          host: "socks5://proxy.example.com",
          port: 1080,
        },
      });

      expect(adapter).toBeDefined();
    });

    it("should accept all original InfluxDBAdapter options", () => {
      // InfluxDB 1.x
      new InfluxDBAdapter({
        url: "http://influxdb:8086",
        authToken: "token",
        database: "telegraf",
        retentionPolicy: "autogen",
        username: "admin",
        password: "admin",
      });

      // InfluxDB 2.x
      new InfluxDBAdapter({
        url: "http://influxdb:8086",
        authToken: "token",
        org: "my-org",
        bucket: "my-bucket",
        precision: "ns",
      });

      expect(true).toBe(true);
    });
  });

  describe("Mixed Environment", () => {
    it("should allow both direct and Grafana connections simultaneously", async () => {
      // Direct Prometheus
      mockedFetch.mockRejectedValueOnce(new Error("Not Grafana"));
      const directAdapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
      });

      // Grafana Prometheus
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "prom-uid",
              name: "Prometheus",
              type: "prometheus",
            },
          ],
        } as any);

      const grafanaAdapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "grafana-token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Both should coexist
      expect(directAdapter).toBeDefined();
      expect(grafanaAdapter).toBeDefined();
    });
  });
});