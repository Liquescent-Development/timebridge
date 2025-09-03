import { LokiGrafanaProxy } from "./loki-grafana-proxy";
import { LogEvent } from "@timebridge/core";
import fetch from "node-fetch";

jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("LokiGrafanaProxy", () => {
  let proxy: LokiGrafanaProxy;

  beforeEach(() => {
    jest.clearAllMocks();
    
    proxy = new LokiGrafanaProxy({
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
    it("should return loki", () => {
      expect(proxy.getDataSourceType()).toBe("loki");
    });
  });

  describe("transformQuery", () => {
    it("should transform LogQL query for logs", () => {
      const query = '{service="nginx"} |= "error"';
      const result = proxy.transformQuery(
        query,
        "loki-uid",
        { from: "1704067200000", to: "1704153600000" }
      );

      expect(result.queries).toHaveLength(1);
      expect(result.queries[0]).toMatchObject({
        datasource: { uid: "loki-uid" },
        expr: query,
        refId: "A",
        queryType: "range",
        maxLines: 1000,
      });
    });

    it("should detect metric queries", () => {
      const query = 'rate({service="api"}[5m])';
      const result = proxy.transformQuery(
        query,
        "loki-uid",
        { from: "1704067200000", to: "1704153600000" }
      );

      expect(result.queries[0].queryType).toBe("instant");
      expect(result.queries[0].expr).toBe(query);
    });

    it("should apply query options", () => {
      const result = proxy.transformQuery(
        '{service="test"}',
        "loki-uid",
        { from: "1704067200000", to: "1704153600000" },
        {
          maxLines: 500,
          direction: "backward",
          step: 30,
        }
      );

      expect(result.queries[0].maxLines).toBe(500);
      expect(result.queries[0].direction).toBe("backward");
      expect(result.queries[0].step).toBe(30);
    });

    it("should handle instant queries", () => {
      const result = proxy.transformQuery(
        'rate({service="test"}[5m])', // Metric query for instant
        "loki-uid",
        { from: "1704067200000", to: "1704067200000" }, // Same time = instant
        { instant: true }
      );

      expect(result.queries[0].queryType).toBe("instant");
    });
  });

  describe("parseResponse", () => {
    it("should parse log frames correctly", async () => {
      const response = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "line", type: "string" },
                    { name: "labels", type: "json" },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000],
                    [
                      'level=error msg="Connection failed"',
                      'level=warn msg="Retrying connection"',
                    ],
                    [
                      { service: "nginx", host: "server1" },
                      { service: "nginx", host: "server1" },
                    ],
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
      expect(events[0]).toMatchObject({
        source: "loki",
        message: 'level=error msg="Connection failed"',
        labels: expect.objectContaining({
          service: "nginx",
          host: "server1",
        }),
      });
      expect(events[0].timestamp).toBeDefined();
      expect(events[0].joinKeys).toEqual({
        service: "nginx",
        host: "server1",
      });
    });

    it("should parse metric frames", async () => {
      const response = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { 
                      name: "value", 
                      type: "number",
                      labels: {
                        service: "api",
                        __name__: "log_lines_total",
                      },
                    },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000],
                    [1000, 1050],
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
      expect(events[0].labels.__value__).toBe("1000");
      expect(events[0].labels.service).toBe("api");
      expect(events[0].labels.__name__).toBe("log_lines_total");
    });

    it("should handle legacy series format", async () => {
      const response = {
        results: {
          A: {
            series: [
              {
                name: "logs",
                tags: { service: "api", level: "error" },
                points: [
                  ["Error occurred", 1704067200000],
                  ["Another error", 1704067260000],
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
      expect(events[0]).toMatchObject({
        message: expect.stringContaining("Error occurred"),
        labels: expect.objectContaining({
          service: "api",
          level: "error",
        }),
      });
    });

    it("should handle table format", async () => {
      const response = {
        results: {
          A: {
            tables: [
              {
                columns: [
                  { text: "Time", type: "time" },
                  { text: "Line", type: "string" },
                  { text: "Service", type: "string" },
                ],
                rows: [
                  [1704067200000, "Log line 1", "nginx"],
                  [1704067260000, "Log line 2", "nginx"],
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
      expect(events[0].message).toBe("Log line 1");
      expect(events[0].labels.Service).toBe("nginx");
    });

    it("should skip entries without line content", async () => {
      const response = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "line", type: "string" },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000, 1704067320000],
                    ["Log 1", null, "Log 2"],
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

      expect(events).toHaveLength(2); // Should skip the null entry
      expect(events[0].message).toBe("Log 1");
      expect(events[1].message).toBe("Log 2");
    });

    it("should handle empty response", async () => {
      const response = {
        results: {
          A: {
            frames: [],
          },
        },
      };

      const events: LogEvent[] = [];
      for await (const event of proxy.parseResponse(response as any)) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });

    it("should extract and format labels correctly", async () => {
      const response = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "line", type: "string" },
                    { 
                      name: "labels",
                      type: "json",
                    },
                  ],
                },
                data: {
                  values: [
                    [1704067200000],
                    ["Test log"],
                    [{ 
                      service: "api",
                      level: "info",
                      request_id: "abc123",
                      __private__: "hidden",
                    }],
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

      expect(events).toHaveLength(1);
      expect(events[0].labels).toMatchObject({
        service: "api",
        level: "info",
        request_id: "abc123",
        __private__: "hidden",
      });
      expect(events[0].joinKeys).toEqual({
        service: "api",
        level: "info",
        request_id: "abc123",
      });
    });
  });

  describe("executeInstantQuery", () => {
    it("should execute instant queries", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, uid: "loki-uid", name: "Loki", type: "loki", isDefault: true }
        ],
      } as any);

      // Mock query response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              frames: [
                {
                  schema: {
                    refId: "A",
                    fields: [
                      { name: "time", type: "time" },
                      { name: "line", type: "string" },
                    ],
                  },
                  data: {
                    values: [[1704067200000], ["Instant result"]],
                  },
                },
              ],
            },
          },
        }),
      } as any);

      const result = await proxy.executeQuery('{service="test"}', { from: new Date(), to: new Date() }, { instant: true });
      const events = [];
      
      for await (const event of result) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].message).toBe("Instant result");

      // Verify instant query parameters
      expect(mockedFetch).toHaveBeenCalledWith(
        "http://grafana.test/api/ds/query",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"queryType":"instant"'),
        })
      );
    });

    it("should handle instant query with specific time", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, uid: "loki-uid", name: "Loki", type: "loki", isDefault: true }
        ],
      } as any);

      // Mock query response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: { A: { frames: [] } },
        }),
      } as any);

      const time = new Date("2024-01-01T12:00:00Z");
      await proxy.executeQuery('{service="test"}', { from: time, to: time }, { instant: true });

      const callBody = JSON.parse((mockedFetch.mock.calls[1][1] as any).body);
      expect(callBody.queries[0].queryType).toBe("instant");
      expect(callBody.from).toBe(callBody.to); // Same time for instant query
    });

    it("should handle instant query errors", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, uid: "loki-uid", name: "Loki", type: "loki", isDefault: true }
        ],
      } as any);

      // Mock query error
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        statusText: "Bad Request",
        text: async () => "Invalid query",
      } as any);

      await expect(
        proxy.executeQuery('{invalid}', { from: new Date(), to: new Date() }, { instant: true })
      ).rejects.toThrow("Grafana query failed");
    });
  });

  describe("getLabelNames", () => {
    it("should fetch label names", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, uid: "loki-uid", name: "Loki", type: "loki", isDefault: true }
        ],
      } as any);

      // Mock label names response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: ["service", "level", "host", "job"],
        }),
      } as any);

      const labels = await proxy.getLabels();
      
      expect(labels).toEqual(["service", "level", "host", "job"]);
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining("/resources/loki/api/v1/labels"),
        expect.any(Object)
      );
    });

    it("should handle label names request", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, uid: "loki-uid", name: "Loki", type: "loki", isDefault: true }
        ],
      } as any);

      // Mock label names response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: ["service", "level"],
        }),
      } as any);

      const labels = await proxy.getLabels();
      
      expect(labels).toEqual(["service", "level"]);
      expect(mockedFetch).toHaveBeenCalledTimes(2); // Initial discovery + label request
    });
  });

  describe("getLabelValues", () => {
    it("should fetch label values", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, uid: "loki-uid", name: "Loki", type: "loki", isDefault: true }
        ],
      } as any);

      // Mock label values response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: ["nginx", "api", "frontend"],
        }),
      } as any);

      const values = await proxy.getLabelValues("service");
      
      expect(values).toEqual(["nginx", "api", "frontend"]);
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining("/resources/loki/api/v1/label/service/values"),
        expect.any(Object)
      );
    });

    it("should handle label values request", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, uid: "loki-uid", name: "Loki", type: "loki", isDefault: true }
        ],
      } as any);

      // Mock label values response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: ["error", "warn", "info"],
        }),
      } as any);

      const values = await proxy.getLabelValues("level");
      
      expect(values).toEqual(["error", "warn", "info"]);
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining("/resources/loki/api/v1/label/level/values"),
        expect.any(Object)
      );
    });
  });


  describe("query type detection", () => {
    it("should detect log queries", () => {
      const logQueries = [
        '{service="nginx"}',
        '{job="api"} |= "error"',
        '{app="test"} | json | level="error"',
      ];

      for (const query of logQueries) {
        const result = proxy.transformQuery(query, "uid", { from: "0", to: "100" });
        expect(result.queries[0].queryType).toBe("range");
      }
    });

    it("should detect metric queries", () => {
      const metricQueries = [
        'rate({service="nginx"}[5m])',
        'sum(rate({job="api"}[1m]))',
        'count_over_time({app="test"}[10m])',
      ];

      for (const query of metricQueries) {
        const result = proxy.transformQuery(query, "uid", { from: "0", to: "100" });
        expect(result.queries[0].queryType).toBe("instant");
      }
    });
  });

  describe("formatLabels", () => {
    it("should format labels for display", () => {
      const labels = {
        service: "nginx",
        level: "error",
        host: "server1",
        __private__: "hidden",
      };

      const formatted = (proxy as any).formatLabels(labels);
      
      expect(formatted).toBe('{service="nginx",level="error",host="server1"}');
      expect(formatted).not.toContain("__private__");
    });

    it("should handle empty labels", () => {
      const formatted = (proxy as any).formatLabels({});
      expect(formatted).toBe("");
    });

    it("should escape special characters in label values", () => {
      const labels = {
        path: '/api/v1/users"test',
        message: 'Error: "failed"',
      };

      const formatted = (proxy as any).formatLabels(labels);
      
      expect(formatted).toContain('path=');
      expect(formatted).toContain('message=');
    });
  });
});