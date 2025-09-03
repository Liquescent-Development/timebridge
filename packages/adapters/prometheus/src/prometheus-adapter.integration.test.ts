import { PrometheusAdapter } from "./prometheus-adapter";
import fetch from "node-fetch";

// Mock fetch for controlled testing
jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("PrometheusAdapter - Grafana Integration", () => {
  describe("Grafana Detection", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should detect Grafana instance and switch to proxy mode", async () => {
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
              uid: "prometheus-uid",
              name: "Prometheus",
              type: "prometheus",
              isDefault: true,
            },
          ],
        } as any); // /api/datasources

      const adapter = new PrometheusAdapter({
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

    it("should fall back to direct connection when not Grafana", async () => {
      // Mock failed Grafana detection
      mockedFetch.mockRejectedValue(new Error("Connection refused"));

      const adapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
        authToken: "prometheus-token",
      });

      // Allow async initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have tried detection
      expect(mockedFetch).toHaveBeenCalled();
    });
  });

  describe("Query Execution through Grafana", () => {
    let adapter: PrometheusAdapter;

    beforeEach(async () => {
      jest.clearAllMocks();

      // Setup successful Grafana detection and data source discovery
      mockedFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "ok",
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "prom-uid",
              name: "Prometheus Prod",
              type: "prometheus",
              isDefault: true,
            },
          ],
        } as any);

      adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "Bearer grafana-token",
      });

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should execute PromQL queries through Grafana API", async () => {
      const mockResponse = {
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
                      labels: { job: "prometheus", instance: "localhost:9090" },
                    },
                  ],
                },
                data: {
                  values: [
                    [1704067200000, 1704067260000],
                    [1, 1],
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

      const events = [];
      const stream = adapter.query('up{job="prometheus"}');

      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].labels.job).toBe("prometheus");
      expect(events[0].labels.__value__).toBe("1");

      // Verify API call
      expect(mockedFetch).toHaveBeenCalledWith(
        "https://grafana.example.com/api/ds/query",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer grafana-token",
          }),
        })
      );
    });

    it("should handle instant queries through Grafana", async () => {
      const mockResponse = {
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
                  values: [[1704067200000], [42]],
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

      const result = await adapter.instantQuery("up");
      const events = [];
      
      for await (const event of result) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].labels.__value__).toBe("42");
    });

    it("should use specified data source name", async () => {
      // Create adapter with specific data source
      mockedFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "ok",
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: 1,
              uid: "prom-prod",
              name: "Prometheus Production",
              type: "prometheus",
            },
            {
              id: 2,
              uid: "prom-dev",
              name: "Prometheus Development",
              type: "prometheus",
            },
          ],
        } as any);

      const specificAdapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        datasourceName: "Prometheus Development",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock query response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: { A: { frames: [] } } }),
      } as any);

      await specificAdapter.query("up").next();

      // Verify correct data source UID was used
      const callBody = JSON.parse((mockedFetch.mock.calls[2][1] as any).body);
      expect(callBody.queries[0].datasource.uid).toBe("prom-dev");
    });
  });

  describe("Authentication Methods", () => {
    it("should support Bearer token authentication", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "Bearer eyJrIjoiT0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer eyJrIjoiT0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk",
          }),
        })
      );
    });

    it("should support service account token", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "glsa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer glsa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          }),
        })
      );
    });

    it("should support basic authentication", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      new PrometheusAdapter({
        url: "https://grafana.example.com",
        basicAuth: {
          username: "admin",
          password: "password",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const expectedAuth = Buffer.from("admin:password").toString("base64");
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${expectedAuth}`,
          }),
        })
      );
    });
  });

  describe("Backward Compatibility", () => {
    it("should work unchanged with direct Prometheus connection", async () => {
      // Mock direct Prometheus connection (no Grafana)
      mockedFetch.mockRejectedValue(new Error("Not Grafana"));

      const adapter = new PrometheusAdapter({
        url: "http://prometheus:9090",
        authToken: "prometheus-token",
      });

      // Mock Prometheus query API
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              {
                metric: { __name__: "up", job: "prometheus" },
                value: [1704067200, "1"],
              },
            ],
          },
        }),
      } as any);

      const events = [];
      const stream = adapter.query("up");

      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].labels.job).toBe("prometheus");
    });

    it("should preserve parser functionality with Grafana", async () => {
      // Setup Grafana connection
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      // Parser should work regardless of connection type
      const validResult = adapter.parseQuery("rate(http_requests_total[5m])");
      expect(validResult.isValid).toBe(true);

      const invalidResult = adapter.parseQuery("invalid query {");
      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.errors).toBeDefined();
    });

    it("should preserve streaming interface", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock streaming response
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
        }),
      } as any);

      const stream = adapter.query("up");
      
      // Verify AsyncIterable interface
      expect(typeof stream[Symbol.asyncIterator]).toBe("function");

      let count = 0;
      for await (const event of stream) {
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("labels");
        count++;
      }
      expect(count).toBe(5);
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should handle data source not found error", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus Prod", type: "prometheus" },
          ],
        } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        datasourceName: "Non-existent Prometheus",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should throw when trying to query
      await expect(adapter.query("up").next()).rejects.toThrow(
        "Data source 'Non-existent Prometheus' not found"
      );
    });

    it("should handle authentication failure", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "invalid-token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock query attempt
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as any);

      await expect(adapter.query("up").next()).rejects.toThrow();
    });

    it("should handle network errors gracefully", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock network error
      mockedFetch.mockRejectedValueOnce(new Error("Network timeout"));

      await expect(adapter.query("up").next()).rejects.toThrow("Network timeout");
    });

    it("should handle malformed Grafana responses", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock malformed response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: "response" }),
      } as any);

      const stream = adapter.query("up");
      const events = [];
      
      // Should handle gracefully without throwing
      for await (const event of stream) {
        events.push(event);
      }
      
      expect(events).toHaveLength(0);
    });
  });

  describe("Performance", () => {
    it("should cache data source information", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock multiple queries
      for (let i = 0; i < 5; i++) {
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: { A: { frames: [] } } }),
        } as any);

        await adapter.query("up").next();
      }

      // Should only fetch data sources once (plus health check)
      const datasourceCalls = mockedFetch.mock.calls.filter((call) =>
        call[0].toString().includes("/api/datasources")
      );
      expect(datasourceCalls).toHaveLength(1);
    });

    it("should handle concurrent queries efficiently", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "uid", name: "Prometheus", type: "prometheus" },
          ],
        } as any);

      const adapter = new PrometheusAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock concurrent query responses
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
                data: { values: [[Date.now()], [1]] },
              },
            ],
          },
        },
      };

      for (let i = 0; i < 10; i++) {
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockResponse,
        } as any);
      }

      // Execute queries concurrently
      const queries = Array.from({ length: 10 }, (_, i) =>
        adapter.query(`up{instance="${i}"}`).next()
      );

      const results = await Promise.all(queries);
      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.value).toBeDefined();
      });
    });
  });
});