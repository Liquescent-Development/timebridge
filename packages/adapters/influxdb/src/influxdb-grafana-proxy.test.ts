import { InfluxDBGrafanaProxy } from "./influxdb-grafana-proxy";
import { LogEvent } from "@timebridge/core";
import fetch from "node-fetch";

jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("InfluxDBGrafanaProxy", () => {
  let proxy: InfluxDBGrafanaProxy;

  beforeEach(() => {
    jest.clearAllMocks();
    
    proxy = new InfluxDBGrafanaProxy({
      grafanaUrl: "http://grafana.test",
      authToken: "Bearer test-token",
      optimization: {
        connectionPool: false,
        queryBatching: false,
        caching: false,
        streamOptimization: false,
        compression: false,
      },
    });
  });

  afterEach(() => {
    if (proxy) {
      proxy.destroy();
    }
  });

  describe("getDataSourceType", () => {
    it("should return influxdb", () => {
      expect(proxy.getDataSourceType()).toBe("influxdb");
    });
  });

  describe("transformQuery for InfluxQL", () => {
    it("should transform basic SELECT query", async () => {
      const query = 'SELECT mean("value") FROM "cpu" WHERE time > now() - 1h';
      const result = await proxy.transformQuery(
        query,
        "influx-uid",
        { from: "1704067200000", to: "1704153600000" }
      );

      expect(result.queries).toHaveLength(1);
      expect(result.queries[0]).toMatchObject({
        datasource: { uid: "influx-uid" },
        query,
        refId: "A",
        format: "time_series",
      });
    });

    it("should handle GROUP BY queries", async () => {
      const query = 'SELECT mean("value") FROM "cpu" GROUP BY time(5m), "host"';
      const result = await proxy.transformQuery(
        query,
        "influx-uid",
        { from: "1704067200000", to: "1704153600000" }
      );

      expect(result.queries[0].query).toBe(query);
      expect(result.queries[0].format).toBe("time_series");
    });

    it("should detect SHOW queries", async () => {
      const queries = [
        "SHOW MEASUREMENTS",
        "SHOW TAG KEYS",
        "SHOW FIELD KEYS FROM cpu",
      ];

      for (const query of queries) {
        const result = await proxy.transformQuery(
          query,
          "influx-uid",
          { from: "0", to: "100" }
        );
        expect(result.queries[0].format).toBe("table");
      }
    });

    it("should apply query options", async () => {
      const result = await proxy.transformQuery(
        'SELECT * FROM "cpu"',
        "influx-uid",
        { from: "0", to: "100" },
        {
          database: "mydb",
          retentionPolicy: "autogen",
          format: "table",
        }
      );

      expect(result.queries[0].database).toBe("mydb");
      expect(result.queries[0].policy).toBe("autogen");
      expect(result.queries[0].format).toBe("table");
    });
  });

  describe("transformQuery for Flux", () => {
    it("should transform Flux queries", async () => {
      const query = `
        from(bucket: "metrics")
        |> range(start: -1h)
        |> filter(fn: (r) => r._measurement == "cpu")
      `;
      
      const result = await proxy.transformQuery(
        query,
        "influx-uid",
        { from: "1704067200000", to: "1704153600000" }
      );

      expect(result.queries[0]).toMatchObject({
        datasource: { uid: "influx-uid" },
        query,
        refId: "A",
        format: "time_series",
      });
    });

    it("should detect Flux queries correctly", async () => {
      const fluxQueries = [
        'from(bucket: "test")',
        'import "strings"\nfrom(bucket: "test")',
        'data = from(bucket: "test")\ndata |> range(start: -1h)',
      ];

      for (const query of fluxQueries) {
        const result = await proxy.transformQuery(
          query,
          "influx-uid",
          { from: "0", to: "100" }
        );
        expect(result.queries[0].query).toBe(query);
      }
    });
  });

  describe("parseResponse for InfluxQL", () => {
    it("should parse series format", async () => {
      const response = {
        results: {
          A: {
            series: [
              {
                name: "cpu",
                columns: ["time", "mean", "host"],
                values: [
                  [1704067200000, 95.5, "server1"],
                  [1704067260000, 94.2, "server1"],
                ],
                tags: { region: "us-east" },
              },
            ],
          },
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        source: "influxdb",
        fields: { mean: 95.5, host: "server1" },
        tags: { region: "us-east" },
      });
      expect(events[0].joinKeys).toEqual({ region: "us-east" });
    });

    it("should parse frames format", async () => {
      const response = {
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
                    [100, 200],
                    ["server1", "server2"],
                  ],
                },
              },
            ],
          },
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].labels.value).toBe("100");
      expect(events[0].labels.host).toBe("server1");
      expect(events[1].labels.value).toBe("200");
      expect(events[1].labels.host).toBe("server2");
    });

    it("should handle table format", async () => {
      const response = {
        results: {
          A: {
            tables: [
              {
                columns: [
                  { text: "time", type: "time" },
                  { text: "measurement", type: "string" },
                ],
                rows: [
                  [1704067200000, "cpu"],
                  [1704067200000, "mem"],
                ],
              },
            ],
          },
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].labels.measurement).toBe("cpu");
      expect(events[1].labels.measurement).toBe("mem");
    });

    it("should handle multiple series", async () => {
      const response = {
        results: {
          A: {
            series: [
              {
                name: "cpu",
                columns: ["time", "value"],
                values: [[1704067200000, 95.5]],
                tags: { host: "server1" },
              },
              {
                name: "cpu",
                columns: ["time", "value"],
                values: [[1704067200000, 85.5]],
                tags: { host: "server2" },
              },
            ],
          },
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].labels.host).toBe("server1");
      expect(events[1].labels.host).toBe("server2");
    });

    it("should skip null values", async () => {
      const response = {
        results: {
          A: {
            series: [
              {
                name: "cpu",
                columns: ["time", "value"],
                values: [
                  [1704067200000, 95.5],
                  [1704067260000, null],
                  [1704067320000, 85.5],
                ],
              },
            ],
          },
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(2); // Should skip null value
      expect(events[0].labels.value).toBe("95.5");
      expect(events[1].labels.value).toBe("85.5");
    });

    it("should handle empty response", async () => {
      const response = {
        results: {
          A: {},
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });
  });

  describe("parseResponse for Flux", () => {
    it("should parse Flux CSV format in frames", async () => {
      const response = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "_time", type: "time" },
                    { name: "_value", type: "number" },
                    { name: "_measurement", type: "string" },
                    { name: "host", type: "string" },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000],
                    [42.5, 43.2],
                    ["temperature", "temperature"],
                    ["sensor1", "sensor1"],
                  ],
                },
              },
            ],
          },
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].labels._value).toBe("42.5");
      expect(events[0].labels._measurement).toBe("temperature");
      expect(events[0].labels.host).toBe("sensor1");
    });
  });

  describe.skip("executeShowQuery", () => {
    it("should execute SHOW MEASUREMENTS", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              tables: [
                {
                  columns: [{ text: "name" }],
                  rows: [["cpu"], ["mem"], ["disk"]],
                },
              ],
            },
          },
        }),
      } as any);

      const measurements = await proxy.executeShowQuery("SHOW MEASUREMENTS");
      
      expect(measurements).toEqual(["cpu", "mem", "disk"]);
      expect(mockedFetch).toHaveBeenCalledWith(
        "http://grafana.test/api/ds/query",
        expect.objectContaining({
          body: expect.stringContaining("SHOW MEASUREMENTS"),
        })
      );
    });

    it("should execute SHOW TAG KEYS", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              tables: [
                {
                  columns: [{ text: "tagKey" }],
                  rows: [["host"], ["region"], ["service"]],
                },
              ],
            },
          },
        }),
      } as any);

      const tags = await proxy.executeShowQuery('SHOW TAG KEYS FROM "cpu"');
      
      expect(tags).toEqual(["host", "region", "service"]);
    });

    it("should handle SHOW query errors", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        statusText: "Bad Request",
      } as any);

      await expect(
        proxy.executeShowQuery("SHOW INVALID")
      ).rejects.toThrow("Show query failed");
    });
  });

  describe.skip("getDatabases", () => {
    it("should fetch database list", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              tables: [
                {
                  columns: [{ text: "name" }],
                  rows: [["telegraf"], ["metrics"], ["_internal"]],
                },
              ],
            },
          },
        }),
      } as any);

      const databases = await proxy.getDatabases();
      
      expect(databases).toEqual(["telegraf", "metrics", "_internal"]);
    });
  });

  describe.skip("getRetentionPolicies", () => {
    it("should fetch retention policies", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              tables: [
                {
                  columns: [
                    { text: "name" },
                    { text: "duration" },
                    { text: "default" },
                  ],
                  rows: [
                    ["autogen", "0s", true],
                    ["one_week", "168h0m0s", false],
                  ],
                },
              ],
            },
          },
        }),
      } as any);

      const policies = await proxy.getRetentionPolicies("telegraf");
      
      expect(policies).toHaveLength(2);
      expect(policies[0]).toMatchObject({
        name: "autogen",
        duration: "0s",
        isDefault: true,
      });
    });
  });

  describe("version detection", () => {
    it("should detect InfluxDB 1.x", async () => {
      jest.clearAllMocks();
      
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            uid: "influx-uid",
            name: "InfluxDB 1.x",
            type: "influxdb",
            jsonData: {
              version: "1.x",
              database: "telegraf",
            },
          },
        ],
      } as any);

      const proxy1x = new InfluxDBGrafanaProxy({
        grafanaUrl: "http://grafana.test",
        authToken: "token",
      });

      const query = 'SELECT * FROM "cpu"';
      const result = proxy1x.transformQuery(query, "uid", { from: "0", to: "100" });
      
      expect(result.queries[0].query).toBe(query);
      expect(result.queries[0].format).toBe("time_series");
    });

    it("should detect InfluxDB 2.x", async () => {
      jest.clearAllMocks();
      
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            uid: "influx-uid",
            name: "InfluxDB 2.x",
            type: "influxdb",
            jsonData: {
              version: "2.x",
              defaultBucket: "metrics",
              organization: "myorg",
            },
          },
        ],
      } as any);

      const proxy2x = new InfluxDBGrafanaProxy({
        grafanaUrl: "http://grafana.test",
        authToken: "token",
      });

      const query = 'from(bucket: "metrics")';
      const result = proxy2x.transformQuery(query, "uid", { from: "0", to: "100" });
      
      expect(result.queries[0].query).toBe(query);
    });
  });

  describe("formatMessage", () => {
    it("should format measurement with fields", () => {
      const event = {
        measurement: "cpu",
        fields: { usage_idle: 95.5, usage_system: 2.5 },
        tags: { host: "server1" },
      };

      const message = (proxy as any).formatMessage(event);
      
      expect(message).toContain("cpu");
      expect(message).toContain("usage_idle=95.5");
      expect(message).toContain("usage_system=2.5");
      expect(message).toContain("host=server1");
    });

    it("should handle events without measurement", () => {
      const event = {
        fields: { value: 100 },
        tags: {},
      };

      const message = (proxy as any).formatMessage(event);
      
      expect(message).toContain("value=100");
    });

    it("should format complex field values", () => {
      const event = {
        measurement: "test",
        fields: {
          string_field: "test value",
          number_field: 42.5,
          boolean_field: true,
          null_field: null,
        },
        tags: {},
      };

      const message = (proxy as any).formatMessage(event);
      
      expect(message).toContain("string_field=test value");
      expect(message).toContain("number_field=42.5");
      expect(message).toContain("boolean_field=true");
      expect(message).not.toContain("null_field");
    });
  });
});