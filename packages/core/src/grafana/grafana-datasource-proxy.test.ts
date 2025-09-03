import { GrafanaDataSourceProxy, isGrafanaUrl } from "./grafana-datasource-proxy";
import { LogEvent } from "../types";
import fetch from "node-fetch";

// Mock fetch
jest.mock("node-fetch");
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

// Test implementation of GrafanaDataSourceProxy
class TestGrafanaProxy extends GrafanaDataSourceProxy {
  getDataSourceType(): string {
    return "test";
  }

  transformQuery(
    query: string,
    datasourceUid: string,
    timeRange: { from: string; to: string },
    options?: any
  ) {
    return {
      queries: [
        {
          datasource: { uid: datasourceUid },
          query,
          refId: "A",
          ...options,
        },
      ],
      from: timeRange.from,
      to: timeRange.to,
    };
  }

  async *parseResponse(response: any): AsyncIterable<LogEvent> {
    // Simple test implementation
    yield {
      timestamp: new Date().toISOString(),
      source: "test",
      message: "test message",
      labels: {},
    };
  }
}

describe("GrafanaDataSourceProxy", () => {
  let proxy: TestGrafanaProxy;

  beforeEach(() => {
    jest.clearAllMocks();
    proxy = new TestGrafanaProxy({
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
    // Clean up proxy resources
    if (proxy) {
      proxy.destroy();
    }
  });

  describe("detectGrafana", () => {
    it("should detect Grafana instance via /api/health", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => "ok",
      } as any);

      const result = await proxy.detectGrafana("http://grafana.test");
      expect(result).toBe(true);
      expect(mockedFetch).toHaveBeenCalledWith(
        "http://grafana.test/api/health",
        expect.any(Object)
      );
    });

    it("should detect Grafana when authentication is required", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as any);

      const result = await proxy.detectGrafana("http://grafana.test");
      expect(result).toBe(true);
    });

    it("should detect non-Grafana instances", async () => {
      // The detectGrafana method tries two endpoints, and makeRequest has retry logic
      // Each endpoint will retry up to 3 times on connection failure
      mockedFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await proxy.detectGrafana("http://prometheus.test");
      expect(result).toBe(false);
    });

    it("should cache detection results", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => "ok",
      } as any);

      await proxy.detectGrafana("http://grafana.test");
      await proxy.detectGrafana("http://grafana.test");

      // Should only call once due to caching
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("discoverDataSources", () => {
    const mockDataSources = [
      {
        id: 1,
        uid: "test-uid-1",
        name: "Test Source 1",
        type: "test",
      },
      {
        id: 2,
        uid: "test-uid-2",
        name: "Test Source 2",
        type: "test",
      },
      {
        id: 3,
        uid: "other-uid",
        name: "Other Source",
        type: "other",
      },
    ];

    it("should discover and filter data sources by type", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDataSources,
      } as any);

      const sources = await proxy.discoverDataSources();
      
      expect(sources.size).toBe(2);
      expect(sources.has("Test Source 1")).toBe(true);
      expect(sources.has("Test Source 2")).toBe(true);
      expect(sources.has("Other Source")).toBe(false);
    });

    it("should cache data sources", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDataSources,
      } as any);

      await proxy.discoverDataSources();
      await proxy.discoverDataSources();

      // Should only fetch once due to caching
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it("should force refresh when requested", async () => {
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => mockDataSources,
      } as any);

      await proxy.discoverDataSources();
      await proxy.discoverDataSources(true); // Force refresh

      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    it("should handle discovery errors", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        statusText: "Internal Server Error",
        status: 500,
      } as any);

      await expect(proxy.discoverDataSources()).rejects.toThrow(
        "Failed to discover Grafana data sources"
      );
    });
  });

  describe("resolveDataSource", () => {
    const mockDataSources = [
      {
        id: 1,
        uid: "test-uid-1",
        name: "Test Source 1",
        type: "test",
        isDefault: false,
      },
      {
        id: 2,
        uid: "test-uid-2",
        name: "Test Source 2",
        type: "test",
        isDefault: true,
      },
    ];

    beforeEach(() => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDataSources,
      } as any);
    });

    it("should resolve data source by exact name", async () => {
      const ds = await proxy.resolveDataSource("Test Source 1");
      expect(ds.name).toBe("Test Source 1");
      expect(ds.uid).toBe("test-uid-1");
    });

    it("should resolve data source by case-insensitive name", async () => {
      const ds = await proxy.resolveDataSource("test source 1");
      expect(ds.name).toBe("Test Source 1");
    });

    it("should use default data source when no name provided", async () => {
      const ds = await proxy.resolveDataSource();
      expect(ds.name).toBe("Test Source 2");
      expect(ds.isDefault).toBe(true);
    });

    it("should use first data source when no default exists", async () => {
      mockedFetch.mockReset();
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ...mockDataSources[0], isDefault: false },
        ],
      } as any);

      const ds = await proxy.resolveDataSource();
      expect(ds.name).toBe("Test Source 1");
    });

    it("should throw error for non-existent data source", async () => {
      await expect(proxy.resolveDataSource("Non-existent")).rejects.toThrow(
        "Data source 'Non-existent' not found"
      );
    });

    it("should throw error when no compatible data sources exist", async () => {
      mockedFetch.mockReset();
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as any);

      await expect(proxy.resolveDataSource()).rejects.toThrow(
        "No test data sources found"
      );
    });
  });

  describe("executeQuery", () => {
    const mockDataSource = {
      id: 1,
      uid: "test-uid",
      name: "Test Source",
      type: "test",
    };

    const mockQueryResponse = {
      results: {
        A: {
          frames: [
            {
              schema: { refId: "A", fields: [] },
              data: { values: [] },
            },
          ],
        },
      },
    };

    beforeEach(() => {
      // Mock data source discovery
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [mockDataSource],
      } as any);
    });

    it("should execute query successfully", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockQueryResponse,
      } as any);

      const events = [];
      const stream = await proxy.executeQuery(
        "test query",
        { from: new Date("2024-01-01"), to: new Date("2024-01-02") }
      );

      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(mockedFetch).toHaveBeenCalledWith(
        "http://grafana.test/api/ds/query",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          }),
        })
      );
    });

    it("should handle query errors", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        statusText: "Bad Request",
        status: 400,
        text: async () => "Invalid query",
      } as any);

      await expect(
        proxy.executeQuery(
          "invalid query",
          { from: new Date(), to: new Date() }
        )
      ).rejects.toThrow("Grafana query failed");
    });

    it("should handle query result errors", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: {
            A: {
              error: "Query execution failed",
            },
          },
        }),
      } as any);

      await expect(
        proxy.executeQuery(
          "test query",
          { from: new Date(), to: new Date() }
        )
      ).rejects.toThrow("Query error");
    });
  });

  describe("authentication", () => {
    it("should use Bearer token authentication", async () => {
      const proxyWithToken = new TestGrafanaProxy({
        grafanaUrl: "http://grafana.test",
        authToken: "test-token",
        optimization: {
          connectionPool: false,
          queryBatching: false,
          caching: false,
          streamOptimization: false,
          compression: false,
        },
      });

      try {
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as any);

        await proxyWithToken.discoverDataSources();

        expect(mockedFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer test-token",
            }),
          })
        );
      } finally {
        proxyWithToken.destroy();
      }
    });

    it("should use Basic authentication", async () => {
      const proxyWithBasic = new TestGrafanaProxy({
        grafanaUrl: "http://grafana.test",
        basicAuth: {
          username: "admin",
          password: "admin",
        },
        optimization: {
          connectionPool: false,
          queryBatching: false,
          caching: false,
          streamOptimization: false,
          compression: false,
        },
      });

      try {
        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as any);

        await proxyWithBasic.discoverDataSources();

        const expectedAuth = Buffer.from("admin:admin").toString("base64");
        expect(mockedFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: `Basic ${expectedAuth}`,
            }),
          })
        );
      } finally {
        proxyWithBasic.destroy();
      }
    });
  });

  describe("helper functions", () => {
    it("should format time correctly", () => {
      const date = new Date("2024-01-01T12:00:00Z");
      const formatted = (proxy as any).formatTime(date);
      expect(formatted).toBe(date.getTime().toString());
    });

    it("should clear cache", () => {
      proxy.clearCache();
      expect(proxy.getCurrentDataSource()).toBeUndefined();
      expect(proxy.isGrafana()).toBe(false);
    });
  });
});

describe("isGrafanaUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should detect Grafana URL via /api/health", async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
    } as any);

    const result = await isGrafanaUrl("http://grafana.test");
    expect(result).toBe(true);
  });

  it("should detect Grafana URL when auth required", async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    } as any);

    const result = await isGrafanaUrl("http://grafana.test");
    expect(result).toBe(true);
  });

  it("should detect non-Grafana URL", async () => {
    // isGrafanaUrl retries failed requests, so we need to mock all retries
    mockedFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await isGrafanaUrl("http://not-grafana.test");
    expect(result).toBe(false);
  });
});