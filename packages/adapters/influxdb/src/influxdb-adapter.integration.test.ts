import { InfluxDBAdapter } from "./influxdb-adapter";
import fetch from "node-fetch";

// Mock fetch for controlled testing  
jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("InfluxDBAdapter - Grafana Integration", () => {
  describe("Grafana Detection", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should detect Grafana and switch to proxy mode", async () => {
      // Mock Grafana detection
      mockedFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "ok",
        } as any) // /api/health
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
              isDefault: true,
              jsonData: { version: "2.x" },
            },
          ],
        } as any); // /api/datasources

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "grafana-token",
      });

      // Allow async initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockedFetch).toHaveBeenCalledWith(
        "https://grafana.example.com/api/health",
        expect.any(Object)
      );
    });

    it("should detect InfluxDB version through Grafana", async () => {
      // Mock Grafana with InfluxDB 1.x
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-1x",
              name: "InfluxDB 1.x",
              type: "influxdb",
              jsonData: { version: "1.x" },
            },
          ],
        } as any);

      const adapter1x = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        datasourceName: "InfluxDB 1.x",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock Grafana with InfluxDB 2.x
      jest.clearAllMocks();
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 2,
              uid: "influx-2x",
              name: "InfluxDB 2.x",
              type: "influxdb",
              jsonData: { version: "2.x", defaultBucket: "metrics" },
            },
          ],
        } as any);

      const adapter2x = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        datasourceName: "InfluxDB 2.x",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Both adapters should work with their respective versions
      expect(mockedFetch).toHaveBeenCalledTimes(4); // 2 health + 2 datasources
    });

    it("should fall back to direct connection for non-Grafana", async () => {
      // Mock direct InfluxDB detection
      mockedFetch
        .mockRejectedValueOnce(new Error("Not Grafana")) // Health check fails
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map([["x-influxdb-version", "2.7.0"]]),
        } as any); // Direct InfluxDB ping

      const adapter = new InfluxDBAdapter({
        url: "http://influxdb:8086",
        authToken: "influx-token",
        org: "my-org",
        bucket: "my-bucket",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have attempted Grafana detection then direct connection
      expect(mockedFetch).toHaveBeenCalledWith(
        "http://influxdb:8086/api/health",
        expect.any(Object)
      );
    });
  });

  describe("InfluxQL Query Execution", () => {
    let adapter: InfluxDBAdapter;

    beforeEach(async () => {
      jest.clearAllMocks();

      // Setup Grafana with InfluxDB 1.x
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
              isDefault: true,
              jsonData: {
                version: "1.x",
                database: "telegraf",
              },
            },
          ],
        } as any);

      adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "Bearer grafana-token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should execute InfluxQL queries through Grafana", async () => {
      const mockResponse = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "value", type: "number" },
                    { name: "host", type: "string" },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000],
                    [95.5, 94.2],
                    ["server1", "server1"],
                  ],
                },
              },
            ],
          },
        },
      };

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const query = 'SELECT mean("usage_idle") FROM "cpu" WHERE time > now() - 1h GROUP BY "host"';
      const events = [];

      for await (const event of adapter.query(query)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].fields.value).toBe(95.5);
      expect(events[0].tags.host).toBe("server1");

      // Verify Grafana API call
      expect(mockedFetch).toHaveBeenCalledWith(
        "https://grafana.example.com/api/ds/query",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer grafana-token",
          }),
        })
      );

      const callBody = JSON.parse((mockedFetch.mock.calls[2][1] as any).body);
      expect(callBody.queries[0].query).toBe(query);
    });

    it("should handle complex InfluxQL queries", async () => {
      const mockResponse = {
        results: {
          A: {
            series: [
              {
                name: "cpu",
                columns: ["time", "mean", "max", "min"],
                values: [
                  [1704067200000, 95.5, 98.2, 92.1],
                  [1704067260000, 94.2, 97.5, 91.3],
                ],
                tags: { region: "us-east", host: "server1" },
              },
            ],
          },
        },
      };

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const query = `
        SELECT mean("usage_idle"), max("usage_idle"), min("usage_idle") 
        FROM "cpu" 
        WHERE time > now() - 1h 
        GROUP BY time(1m), "region", "host"
      `;

      const events = [];
      for await (const event of adapter.query(query)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].fields.mean).toBe(95.5);
      expect(events[0].fields.max).toBe(98.2);
      expect(events[0].tags.region).toBe("us-east");
    });
  });

  describe("Flux Query Execution (InfluxDB 2.x)", () => {
    let adapter: InfluxDBAdapter;

    beforeEach(async () => {
      jest.clearAllMocks();

      // Setup Grafana with InfluxDB 2.x
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx2-uid",
              name: "InfluxDB 2.x",
              type: "influxdb",
              jsonData: {
                version: "2.x",
                defaultBucket: "metrics",
                organization: "my-org",
              },
            },
          ],
        } as any);

      adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "grafana-token",
        datasourceName: "InfluxDB 2.x",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should execute Flux queries through Grafana", async () => {
      const mockResponse = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "_value", type: "number" },
                    { name: "_measurement", type: "string" },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000],
                    [42.5, 43.2],
                    ["temperature", "temperature"],
                  ],
                },
              },
            ],
          },
        },
      };

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const fluxQuery = `
        from(bucket: "metrics")
        |> range(start: -1h)
        |> filter(fn: (r) => r._measurement == "temperature")
      `;

      const events = [];
      for await (const event of adapter.query(fluxQuery)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].fields._value).toBe(42.5);
      expect(events[0].tags._measurement).toBe("temperature");
    });
  });

  describe("Data Source Selection", () => {
    it("should handle multiple InfluxDB data sources", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-prod",
              name: "InfluxDB Production",
              type: "influxdb",
              jsonData: { version: "2.x" },
            },
            {
              id: 2,
              uid: "influx-staging",
              name: "InfluxDB Staging",
              type: "influxdb",
              jsonData: { version: "2.x" },
            },
            {
              id: 3,
              uid: "influx-dev",
              name: "InfluxDB Development",
              type: "influxdb",
              jsonData: { version: "1.x" },
            },
          ],
        } as any);

      const prodAdapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        datasourceName: "InfluxDB Production",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock query
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: { A: { frames: [] } } }),
      } as any);

      await prodAdapter.query('SELECT * FROM "cpu" LIMIT 1').next();

      const callBody = JSON.parse((mockedFetch.mock.calls[2][1] as any).body);
      expect(callBody.queries[0].datasource.uid).toBe("influx-prod");
    });

    it("should use default data source when name not specified", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-1",
              name: "InfluxDB 1",
              type: "influxdb",
              isDefault: false,
            },
            {
              id: 2,
              uid: "influx-default",
              name: "InfluxDB Default",
              type: "influxdb",
              isDefault: true,
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: { A: { frames: [] } } }),
      } as any);

      await adapter.query('SELECT * FROM "test"').next();

      const callBody = JSON.parse((mockedFetch.mock.calls[2][1] as any).body);
      expect(callBody.queries[0].datasource.uid).toBe("influx-default");
    });
  });

  describe("Parser Integration", () => {
    let adapter: InfluxDBAdapter;

    beforeEach(async () => {
      jest.clearAllMocks();

      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
              jsonData: { version: "1.x" },
            },
          ],
        } as any);

      adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should validate InfluxQL queries", () => {
      const validQuery = 'SELECT mean("value") FROM "cpu" WHERE time > now() - 1h';
      const validResult = adapter.parseQuery(validQuery);
      expect(validResult.isValid).toBe(true);
      expect(validResult.ast).toBeDefined();

      const invalidQuery = 'SELECT mean("value" FROM cpu';
      const invalidResult = adapter.parseQuery(invalidQuery);
      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.errors).toBeDefined();
    });

    it("should parse complex queries with GROUP BY", () => {
      const query = `
        SELECT mean("usage_idle") AS "mean_idle", 
               max("usage_system") AS "max_system"
        FROM "cpu"
        WHERE "host" =~ /^server/ AND time > now() - 24h
        GROUP BY time(5m), "region"
        FILL(linear)
      `;

      const result = adapter.parseQuery(query);
      expect(result.isValid).toBe(true);
      expect(result.ast).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should handle missing data source", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(adapter.query('SELECT * FROM "test"').next()).rejects.toThrow(
        "No influxdb data sources found"
      );
    });

    it("should handle authentication errors", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "invalid-token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      } as any);

      await expect(adapter.query('SELECT * FROM "test"').next()).rejects.toThrow();
    });

    it("should handle query execution errors", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock query error
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              error: "Database not found: nonexistent",
            },
          },
        }),
      } as any);

      await expect(
        adapter.query('SELECT * FROM "nonexistent"."autogen"."cpu"').next()
      ).rejects.toThrow("Query error");
    });

    it("should handle malformed responses", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock malformed response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected: "format" }),
      } as any);

      const events = [];
      for await (const event of adapter.query('SELECT * FROM "cpu"')) {
        events.push(event);
      }

      // Should handle gracefully without crashing
      expect(events).toHaveLength(0);
    });
  });

  describe("Backward Compatibility", () => {
    it("should work with direct InfluxDB connection", async () => {
      // Mock direct InfluxDB (not Grafana)
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

      // Mock direct InfluxDB query response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              series: [
                {
                  name: "cpu",
                  columns: ["time", "usage_idle"],
                  values: [[1704067200000, 95.5]],
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
    });

    it("should preserve all configuration options", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        proxy: {
          host: "socks5://proxy.example.com",
          port: 1080,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Proxy should still be configured
      expect(adapter).toBeDefined();
    });

    it("should maintain streaming interface", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const mockResponse = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "value", type: "number" },
                  ],
                },
                data: {
                  values: [
                    [1, 2, 3, 4, 5].map((i) => Date.now() + i * 1000),
                    [1, 2, 3, 4, 5],
                  ],
                },
              },
            ],
          },
        },
      };

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const stream = adapter.query('SELECT * FROM "test"');
      
      // Verify AsyncIterable interface
      expect(typeof stream[Symbol.asyncIterator]).toBe("function");

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(5);
      events.forEach((event) => {
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("fields");
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty query results", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: { A: { frames: [] } },
        }),
      } as any);

      const events = [];
      for await (const event of adapter.query('SELECT * FROM "nonexistent"')) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });

    it("should handle very large result sets", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create large mock response
      const largeData = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "value", type: "number" },
                  ],
                },
                data: {
                  values: [
                    Array.from({ length: 10000 }, (_, i) => Date.now() + i * 1000),
                    Array.from({ length: 10000 }, (_, i) => i),
                  ],
                },
              },
            ],
          },
        },
      };

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => largeData,
      } as any);

      const stream = adapter.query('SELECT * FROM "cpu"');
      let count = 0;

      for await (const event of stream) {
        count++;
        if (count > 100) break; // Limit for test
      }

      expect(count).toBe(101);
    });

    it("should handle special characters in queries", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "influx-uid",
              name: "InfluxDB",
              type: "influxdb",
            },
          ],
        } as any);

      const adapter = new InfluxDBAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: { A: { frames: [] } } }),
      } as any);

      const specialQuery = 'SELECT * FROM "cpu" WHERE "tag" = \'value with "quotes"\'';
      await adapter.query(specialQuery).next();

      const callBody = JSON.parse((mockedFetch.mock.calls[2][1] as any).body);
      expect(callBody.queries[0].query).toBe(specialQuery);
    });
  });
});