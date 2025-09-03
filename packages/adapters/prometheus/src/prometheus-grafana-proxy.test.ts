import { PrometheusGrafanaProxy } from "./prometheus-grafana-proxy";
import { LogEvent } from "@timebridge/core";
import fetch from "node-fetch";

jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("PrometheusGrafanaProxy", () => {
  let proxy: PrometheusGrafanaProxy;

  beforeEach(() => {
    jest.clearAllMocks();
    proxy = new PrometheusGrafanaProxy({
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
    it("should return prometheus", () => {
      expect(proxy.getDataSourceType()).toBe("prometheus");
    });
  });

  describe("transformQuery", () => {
    it("should transform PromQL to Grafana query format", () => {
      const query = "rate(http_requests_total[5m])";
      const result = proxy.transformQuery(
        query,
        "prometheus-uid",
        { from: "1704067200000", to: "1704153600000" }
      );

      expect(result.queries).toHaveLength(1);
      expect(result.queries[0]).toMatchObject({
        datasource: { uid: "prometheus-uid" },
        expr: query,
        refId: "A",
        format: "time_series",
        instant: false,
        range: true,
      });
      expect(result.from).toBe("1704067200000");
      expect(result.to).toBe("1704153600000");
    });

    it("should calculate appropriate step interval", () => {
      const query = "up";
      const fromMs = Date.now() - 3600000; // 1 hour ago
      const toMs = Date.now();
      
      const result = proxy.transformQuery(
        query,
        "prometheus-uid",
        { from: fromMs.toString(), to: toMs.toString() }
      );

      // For 1 hour range, step should be at least 15 seconds (minimum)
      expect(result.queries[0].step).toBeGreaterThanOrEqual(15);
      expect(result.queries[0].step).toBeLessThanOrEqual(20);
    });

    it("should allow option overrides", () => {
      const result = proxy.transformQuery(
        "up",
        "prometheus-uid",
        { from: "1704067200000", to: "1704153600000" },
        { step: 60, maxDataPoints: 500 }
      );

      expect(result.queries[0].step).toBe(60);
      expect(result.queries[0].maxDataPoints).toBe(500);
    });
  });

  describe("parseResponse", () => {
    it("should parse data frame response", async () => {
      const response = {
        results: {
          A: {
            frames: [
              {
                schema: {
                  refId: "A",
                  fields: [
                    { name: "time", type: "time" },
                    { name: "value", type: "number", labels: { job: "api" } },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000],
                    [100, 200],
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
        source: "prometheus",
        labels: expect.objectContaining({
          job: "api",
          __value__: "100",
        }),
      });
      expect(events[1]).toMatchObject({
        source: "prometheus",
        labels: expect.objectContaining({
          __value__: "200",
        }),
      });
    });

    it("should parse legacy series format", async () => {
      const response = {
        results: {
          A: {
            series: [
              {
                name: "http_requests_total",
                tags: { method: "GET", status: "200" },
                points: [
                  [100, 1704067200000],
                  [150, 1704067260000],
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
        source: "prometheus",
        message: expect.stringContaining("http_requests_total"),
        labels: expect.objectContaining({
          method: "GET",
          status: "200",
          __name__: "http_requests_total",
          __value__: "100",
        }),
      });
    });

    it("should skip null values", async () => {
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
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000, 1704067320000],
                    [100, null, 200],
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

      expect(events).toHaveLength(2); // Should skip the null value
    });

    it("should extract join keys from labels", async () => {
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
                        job: "api",
                        instance: "server1",
                        trace_id: "abc-123",
                      },
                    },
                  ],
                },
                data: {
                  values: [[1704067200000], [100]],
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

      expect(events[0].joinKeys).toMatchObject({
        job: "api",
        instance: "server1",
        trace_id: "abc-123",
      });
    });
  });

  describe("executeInstantQuery", () => {
    it("should execute instant query", async () => {
      // Mock data source discovery for resolveDataSource
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            uid: "prometheus-uid",
            name: "Prometheus",
            type: "prometheus",
          },
        ],
      } as any);

      // Mock the actual query execution
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              frames: [],
            },
          },
        }),
      } as any);

      await proxy.executeInstantQuery("up", new Date());

      expect(mockedFetch).toHaveBeenCalledWith(
        "http://grafana.test/api/ds/query",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("instant"),
        })
      );

      const callBody = JSON.parse((mockedFetch.mock.calls[1][1] as any).body);
      expect(callBody.queries[0].instant).toBe(true);
      expect(callBody.queries[0].range).toBe(false);
    });

    it("should handle instant query errors", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            uid: "prometheus-uid",
            name: "Prometheus",
            type: "prometheus",
          },
        ],
      } as any);

      // Mock query execution failure
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        statusText: "Bad Request",
      } as any);

      await expect(proxy.executeInstantQuery("invalid")).rejects.toThrow(
        "Instant query failed: Bad Request"
      );
    });
  });

  describe("metadata methods", () => {
    it("should get metric metadata", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            uid: "prometheus-uid",
            name: "Prometheus",
            type: "prometheus",
          },
        ],
      } as any);

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            metric1: [{ type: "counter", help: "Test metric" }],
          },
        }),
      } as any);

      const metadata = await proxy.getMetadata("metric1");
      expect(metadata.data.metric1).toBeDefined();
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining("/resources/api/v1/metadata"),
        expect.any(Object)
      );
    });

    it("should get label names", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            uid: "prometheus-uid",
            name: "Prometheus",
            type: "prometheus",
          },
        ],
      } as any);

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: ["job", "instance", "method"],
        }),
      } as any);

      const labels = await proxy.getLabelNames();
      expect(labels).toEqual(["job", "instance", "method"]);
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining("/resources/api/v1/labels"),
        expect.any(Object)
      );
    });

    it("should get label values", async () => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            uid: "prometheus-uid",
            name: "Prometheus",
            type: "prometheus",
          },
        ],
      } as any);

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: ["api", "frontend", "backend"],
        }),
      } as any);

      const values = await proxy.getLabelValues("job");
      expect(values).toEqual(["api", "frontend", "backend"]);
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining("/resources/api/v1/label/job/values"),
        expect.any(Object)
      );
    });
  });

  describe("formatLabels", () => {
    it("should format labels correctly", () => {
      const labels = {
        job: "api",
        instance: "server1",
        __value__: "100",
        __name__: "metric",
      };

      const formatted = (proxy as any).formatLabels(labels);
      expect(formatted).toBe('{job="api",instance="server1"}');
      expect(formatted).not.toContain("__value__");
      expect(formatted).not.toContain("__name__");
    });

    it("should handle empty labels", () => {
      const formatted = (proxy as any).formatLabels({});
      expect(formatted).toBe("");
    });
  });
});