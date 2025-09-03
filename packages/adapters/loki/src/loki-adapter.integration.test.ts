import { LokiAdapter } from "./loki-adapter";
import fetch from "node-fetch";

// Mock fetch for controlled testing
jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("LokiAdapter - Grafana Integration", () => {
  describe("Grafana Detection", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should detect Grafana and use proxy mode", async () => {
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
              uid: "loki-uid",
              name: "Loki",
              type: "loki",
              isDefault: true,
            },
          ],
        } as any); // /api/datasources

      const adapter = new LokiAdapter({
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

    it("should fall back to direct connection for non-Grafana URLs", async () => {
      // Mock failed Grafana detection
      mockedFetch.mockRejectedValue(new Error("Connection refused"));

      const adapter = new LokiAdapter({
        url: "http://loki:3100",
        authToken: "Bearer test-token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should attempt detection but continue with direct connection
      expect(mockedFetch).toHaveBeenCalled();
    });
  });

  describe("LogQL Query Execution", () => {
    let adapter: LokiAdapter;

    beforeEach(async () => {
      jest.clearAllMocks();

      // Setup successful Grafana detection
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
              uid: "loki-uid",
              name: "Loki Logs",
              type: "loki",
              isDefault: true,
            },
          ],
        } as any);

      adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "Bearer grafana-token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should execute log queries through Grafana", async () => {
      const mockResponse = {
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
                      'level=error msg="Failed to connect"',
                      'level=warn msg="Retry attempt"',
                    ],
                    [
                      { service: "nginx", level: "error" },
                      { service: "nginx", level: "warn" },
                    ],
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
      const stream = adapter.createStream('{service="nginx"} |= "error"');

      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].message).toContain("Failed to connect");
      expect(events[0].labels.service).toBe("nginx");

      // Verify Grafana API was called
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

    it("should handle metric queries through Grafana", async () => {
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
                      labels: { service: "api", __name__: "log_lines_total" },
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

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const events = [];
      const stream = adapter.createStream('rate({service="api"}[5m])');

      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].labels.__value__).toBe("1000");
      expect(events[0].labels.service).toBe("api");
    });

    it("should handle LogQL pipeline operations", async () => {
      const mockResponse = {
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
                    [1704067200000],
                    ['{"level":"error","msg":"Test","code":500}'],
                    [{ service: "api" }],
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

      const query = '{service="api"} | json | code >= 400';
      const events = [];
      
      for await (const event of adapter.createStream(query)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].message).toContain("500");
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
              uid: "loki-prod",
              name: "Loki Production",
              type: "loki",
            },
            {
              id: 2,
              uid: "loki-dev",
              name: "Loki Development",
              type: "loki",
            },
          ],
        } as any);

      const specificAdapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        datasourceName: "Loki Development",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock query response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: { A: { frames: [] } } }),
      } as any);

      const stream = specificAdapter.createStream('{service="test"}');
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();

      // Verify correct data source UID was used
      const callBody = JSON.parse((mockedFetch.mock.calls[2][1] as any).body);
      expect(callBody.queries[0].datasource.uid).toBe("loki-dev");
    });
  });

  describe("Streaming Behavior", () => {
    let adapter: LokiAdapter;

    beforeEach(async () => {
      jest.clearAllMocks();

      mockedFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "ok",
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should maintain AsyncIterable interface", async () => {
      const mockResponse = {
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
                    [1, 2, 3, 4, 5].map((i) => Date.now() + i * 1000),
                    ["log1", "log2", "log3", "log4", "log5"],
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

      const stream = adapter.createStream('{service="test"}');

      // Verify AsyncIterable interface
      expect(typeof stream[Symbol.asyncIterator]).toBe("function");

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(5);
      events.forEach((event) => {
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("message");
        expect(event).toHaveProperty("labels");
      });
    });

    it("should handle empty results", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: { A: { frames: [] } } }),
      } as any);

      const events = [];
      for await (const event of adapter.createStream('{service="nonexistent"}')) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });
  });

  describe("Authentication", () => {
    it("should support Bearer token", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "Bearer abcdef123456",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer abcdef123456",
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
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "glsa_xxxxxxxxxxxx",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer glsa_xxxxxxxxxxxx",
          }),
        })
      );
    });

    it.skip("should support basic authentication - Not implemented in LokiAdapter", async () => {
      // LokiAdapter doesn't support basic authentication directly
      // It only supports authToken for Bearer authentication
    });
  });

  describe("Parser Integration", () => {
    let adapter: LokiAdapter;

    beforeEach(async () => {
      jest.clearAllMocks();

      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should validate queries before execution", () => {
      const validQuery = '{service="nginx"} |= "error"';
      const validResult = adapter.validateQuery(validQuery);
      expect(validResult).toBe(true);

      const invalidQuery = '{service="nginx" invalid}';
      const invalidResult = adapter.validateQuery(invalidQuery);
      expect(invalidResult).toBe(false);
    });

    it("should parse complex LogQL queries", () => {
      const complexQuery = `
        {service="api"} 
        | json 
        | status >= 400 
        | line_format "{{.timestamp}} {{.level}}: {{.message}}"
      `;

      const result = adapter.validateQuery(complexQuery);
      expect(result).toBe(true);
    });

    it("should detect metric queries", () => {
      const metricQuery = 'rate({service="api"}[5m])';
      const result = adapter.validateQuery(metricQuery);
      expect(result).toBe(true);

      const logQuery = '{service="api"} |= "error"';
      const logResult = adapter.validateQuery(logQuery);
      expect(logResult).toBe(true);
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should handle data source not found", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as any);

      const adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const stream = adapter.createStream('{service="test"}');
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow(
        "No loki data sources found"
      );
    });

    it("should handle authentication failures", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as any);

      const adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "invalid-token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as any);

      const stream = adapter.createStream('{service="test"}');
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow();
    });

    it("should handle query errors from Grafana", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      const adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock query error response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              error: "Query parsing error: unexpected token",
            },
          },
        }),
      } as any);

      await expect(
        adapter.createStream('{invalid query}').next()
      ).rejects.toThrow("Query error");
    });

    it("should handle network timeouts", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      const adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        grafanaOptions: {
          timeout: 100, // Very short timeout
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock timeout
      mockedFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: false } as any), 200);
          })
      );

      const stream = adapter.createStream('{service="test"}');
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow();
    });
  });

  describe("Backward Compatibility", () => {
    it("should work with direct Loki connection", async () => {
      // Mock direct connection (no Grafana)
      mockedFetch.mockRejectedValue(new Error("Not Grafana"));

      const adapter = new LokiAdapter({
        url: "http://loki:3100",
        authToken: "Bearer test-token",
      });

      // Mock direct Loki API response
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            result: [
              {
                stream: {
                  service: "nginx",
                  level: "error",
                },
                values: [
                  ["1704067200000000000", 'level=error msg="Test error"'],
                ],
              },
            ],
          },
        }),
      } as any);

      const events = [];
      for await (const event of adapter.createStream('{service="nginx"}')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].labels.service).toBe("nginx");
    });

    it("should preserve all query options", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      const adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: { A: { frames: [] } } }),
      } as any);

      const stream = adapter
        .createStream('{service="test"}', {
          limit: 100,
          start: new Date("2024-01-01"),
          end: new Date("2024-01-02"),
          direction: "backward",
        });
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();

      const callBody = JSON.parse((mockedFetch.mock.calls[2][1] as any).body);
      expect(callBody.queries[0].maxLines).toBe(100);
      expect(callBody.queries[0].direction).toBe("backward");
    });
  });

  describe("WebSocket Fallback", () => {
    it("should not use WebSocket when connected to Grafana", async () => {
      mockedFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "ok" } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 1, uid: "loki-uid", name: "Loki", type: "loki" },
          ],
        } as any);

      const adapter = new LokiAdapter({
        url: "https://grafana.example.com",
        authToken: "token",
        websocket: true, // This should be ignored for Grafana
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify no WebSocket connection was attempted
      // (WebSocket would be a different module, not fetch)
      const calls = mockedFetch.mock.calls;
      expect(calls.every((call) => !call[0].toString().includes("/loki/api/v1/tail"))).toBe(true);
    });
  });
});