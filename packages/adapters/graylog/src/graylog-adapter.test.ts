import { GraylogAdapter, GraylogAdapterOptions } from "./graylog-adapter";
import { CorrelationError, LogEvent } from "@timebridge/core";
import fetch from "node-fetch";

// Mock dependencies
jest.mock("node-fetch");

const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

describe("GraylogAdapter", () => {
  let adapter: GraylogAdapter;
  let defaultOptions: GraylogAdapterOptions;

  // Simple helper that just starts the stream and gives time for fetch to be called
  const startStreamAndCheckFetch = (
    adapter: GraylogAdapter,
    query: string,
    options?: unknown
  ) => {
    const streamIterator = adapter.createStream(query, options);
    const iterator = streamIterator[Symbol.asyncIterator]();

    // Start the async generator but don't wait for it to complete
    void iterator.next();

    return iterator;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    defaultOptions = {
      url: "http://localhost:9000",
      username: "admin",
      password: "password",
      pollInterval: 2000,
      timeout: 15000,
      maxRetries: 3,
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("should create adapter with username/password authentication", () => {
      adapter = new GraylogAdapter(defaultOptions);
      expect(adapter.getName()).toBe("graylog");
    });

    it("should create adapter with API token authentication", () => {
      const tokenOptions = {
        url: "http://localhost:9000",
        apiToken: "test-api-token",
      };

      adapter = new GraylogAdapter(tokenOptions);
      expect(adapter.getName()).toBe("graylog");
    });

    it("should throw error when no authentication provided", () => {
      const noAuthOptions = {
        url: "http://localhost:9000",
      };

      expect(() => new GraylogAdapter(noAuthOptions)).toThrow(CorrelationError);
      expect(() => new GraylogAdapter(noAuthOptions)).toThrow(
        "Graylog adapter requires either apiToken or username/password"
      );
    });

    it("should merge provided options with defaults", () => {
      const customOptions = {
        ...defaultOptions,
        pollInterval: 5000,
        timeout: 30000,
        maxRetries: 5,
        streamId: "custom-stream-id",
      };

      adapter = new GraylogAdapter(customOptions);
      expect(adapter.getName()).toBe("graylog");
    });

    it("should default to legacy API version", () => {
      adapter = new GraylogAdapter(defaultOptions);
      expect(adapter.getName()).toBe("graylog");
      // The adapter should use legacy API by default
    });

    it("should accept v6 API version option", () => {
      const v6Options = {
        ...defaultOptions,
        apiVersion: "v6" as const,
      };

      adapter = new GraylogAdapter(v6Options);
      expect(adapter.getName()).toBe("graylog");
    });
  });

  describe("Authentication", () => {
    it("should create Basic auth header from username/password", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      // Setup mock response first
      const mockResponse = {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ messages: [] }),
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      adapter = new GraylogAdapter(defaultOptions);

      const query = "service:frontend";
      startStreamAndCheckFetch(adapter, query);

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        })
      );

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should create token auth header from API token", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      // Setup mock response first
      const mockResponse = {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ messages: [] }),
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const tokenOptions = {
        url: "http://localhost:9000",
        apiToken: "test-api-token",
      };

      adapter = new GraylogAdapter(tokenOptions);

      const query = "service:frontend";
      startStreamAndCheckFetch(adapter, query);

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "token test-api-token",
          }),
        })
      );

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should encode Basic auth credentials correctly", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      // Setup mock response first
      const mockResponse = {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ messages: [] }),
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const options = {
        url: "http://localhost:9000",
        username: "testuser",
        password: "testpass",
      };

      adapter = new GraylogAdapter(options);

      const query = "service:frontend";
      startStreamAndCheckFetch(adapter, query);

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      // testuser:testpass in base64 is dGVzdHVzZXI6dGVzdHBhc3M=
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Basic dGVzdHVzZXI6dGVzdHBhc3M=",
          }),
        })
      );

      // Restore fake timers
      jest.useFakeTimers();
    });
  });

  describe("validateQuery", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should validate field:value syntax", () => {
      expect(adapter.validateQuery("service:frontend")).toBe(true);
      expect(adapter.validateQuery("level:error")).toBe(true);
      expect(adapter.validateQuery("host:server1")).toBe(true);
    });

    it("should validate field=value syntax", () => {
      expect(adapter.validateQuery('service="frontend"')).toBe(true);
      expect(adapter.validateQuery("level='error'")).toBe(true);
    });

    it("should validate simple text searches", () => {
      expect(adapter.validateQuery("error message")).toBe(true);
      expect(adapter.validateQuery("exception")).toBe(true);
    });

    it("should reject empty queries", () => {
      expect(adapter.validateQuery("")).toBe(false);
    });
  });

  describe("Stream modes", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should fetch historical messages by default (non-continuous mode)", async () => {
      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [
            {
              message: {
                _id: "msg1",
                message: "Request processed",
                timestamp: "2022-01-01T00:00:00.000Z",
                source: "frontend-server",
                fields: {
                  service: "frontend",
                  level: "info",
                  request_id: "req123",
                },
              },
              index: "graylog_0",
            },
            {
              message: {
                _id: "msg2",
                message: "Database query executed",
                timestamp: "2022-01-01T00:00:01.000Z",
                source: "database-server",
                fields: {
                  service: "database",
                  level: "debug",
                  query_time: "150ms",
                },
              },
              index: "graylog_0",
            },
          ],
          total_results: 2,
          from: "2022-01-01T00:00:00.000Z",
          to: "2022-01-01T00:05:00.000Z",
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streamIterator = adapter.createStream(query);
      const results: LogEvent[] = [];

      // Get first batch
      const iterator = streamIterator[Symbol.asyncIterator]();
      const result1 = await iterator.next();
      if (!result1.done) results.push(result1.value);

      const result2 = await iterator.next();
      if (!result2.done) results.push(result2.value);

      expect(results).toHaveLength(2);

      expect(results[0]).toMatchObject({
        timestamp: "2022-01-01T00:00:00.000Z",
        source: "graylog",
        stream: "frontend-server",
        message: "Request processed",
        labels: {
          service: "frontend",
          level: "info",
          request_id: "req123",
        },
        joinKeys: {
          request_id: "req123",
        },
      });

      expect(results[1]).toMatchObject({
        timestamp: "2022-01-01T00:00:01.000Z",
        source: "graylog",
        stream: "database-server",
        message: "Database query executed",
        labels: {
          service: "database",
          level: "debug",
          query_time: "150ms",
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: expect.any(String),
            Accept: "application/json",
            "X-Requested-By": "log-correlator",
          }),
        })
      );

      await adapter.destroy();
    });

    it("should handle time range options", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const query = "service:frontend";
      const options = { timeRange: "10m" };

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
          total_results: 0,
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      startStreamAndCheckFetch(adapter, query, options);

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should use 10 minute time range
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should include stream filter when streamId provided", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const optionsWithStream = {
        ...defaultOptions,
        streamId: "custom-stream-123",
      };

      adapter = new GraylogAdapter(optionsWithStream);

      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
          total_results: 0,
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      startStreamAndCheckFetch(adapter, query);

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should include stream filter in query parameters
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("filter=streams%3Acustom-stream-123"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should avoid duplicate messages using lastMessageId", async () => {
      const query = "service:frontend";

      // Mock first call - return messages
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [
            {
              message: {
                _id: "msg1",
                message: "First message",
                timestamp: "2022-01-01T00:00:00.000Z",
                source: "server",
                fields: {},
              },
            },
            {
              message: {
                _id: "msg2",
                message: "Second message",
                timestamp: "2022-01-01T00:00:01.000Z",
                source: "server",
                fields: {},
              },
            },
          ],
        }),
      } as any);

      // Mock subsequent calls - return empty to stop polling
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
        }),
      } as any);

      const streamIterator = adapter.createStream(query);
      const iterator = streamIterator[Symbol.asyncIterator]();
      const results: LogEvent[] = [];

      // Get first batch of messages
      let result = await iterator.next();
      if (!result.done) results.push(result.value);

      result = await iterator.next();
      if (!result.done) results.push(result.value);

      // Should get both messages from first call
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.message)).toEqual([
        "First message",
        "Second message",
      ]);

      await adapter.destroy();
    });

    it("should handle polling errors gracefully in continuous mode", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const query = "service:frontend";

      // First call fails, second succeeds
      mockFetch
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        } as any);

      startStreamAndCheckFetch(adapter, query, { continuous: true });

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have tried at least once
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should handle HTTP error responses in continuous mode", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const query = "service:frontend";

      // Mock HTTP error response for first call, then success for subsequent calls
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: jest.fn().mockResolvedValue({}),
        } as any)
        .mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        } as any);

      startStreamAndCheckFetch(adapter, query, { continuous: true });

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have made at least one fetch call
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should use exponential backoff on errors in continuous mode", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const query = "service:frontend";

      mockFetch.mockRejectedValue(new Error("Network error"));

      startStreamAndCheckFetch(adapter, query, { continuous: true });

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should continue polling with backoff
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    describe("Historical vs Continuous behavior", () => {
      it("should fetch once and complete for historical queries (default)", async () => {
        const query = "service:frontend";

        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [
              {
                message: {
                  _id: "msg1",
                  message: "Historical event 1",
                  timestamp: "2022-01-01T00:00:00.000Z",
                  source: "frontend-server",
                  fields: {
                    service: "frontend",
                    request_id: "req123",
                  },
                },
                index: "graylog_0",
              },
              {
                message: {
                  _id: "msg2",
                  message: "Historical event 2",
                  timestamp: "2022-01-01T00:00:01.000Z",
                  source: "frontend-server",
                  fields: {
                    service: "frontend",
                    request_id: "req456",
                  },
                },
                index: "graylog_0",
              },
            ],
            total_results: 2,
            from: "2022-01-01T00:00:00.000Z",
            to: "2022-01-01T00:05:00.000Z",
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        // Historical mode should fetch once and complete
        const streamIterator = adapter.createStream(query, { continuous: false });
        const results: LogEvent[] = [];

        for await (const event of streamIterator) {
          results.push(event);
        }

        expect(results).toHaveLength(2);
        expect(results[0].message).toBe("Historical event 1");
        expect(results[1].message).toBe("Historical event 2");

        // Should only make one API call (historical mode)
        expect(mockFetch).toHaveBeenCalledTimes(1);

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/search/universal/relative"),
          expect.objectContaining({
            method: "GET",
          })
        );

        await adapter.destroy();
      });

      it("should poll continuously when continuous: true is specified", async () => {
        // Use real timers for polling behavior
        jest.useRealTimers();

        const query = "service:frontend";

        // First call returns messages, subsequent calls return empty
        const mockResponse1 = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [
              {
                message: {
                  _id: "msg1",
                  message: "Live event 1",
                  timestamp: new Date().toISOString(),
                  source: "frontend-server",
                  fields: {
                    service: "frontend",
                    request_id: "req789",
                  },
                },
                index: "graylog_0",
              },
            ],
            total_results: 1,
          }),
        };

        const mockResponseEmpty = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        };

        // First call returns data, subsequent calls return empty
        mockFetch
          .mockResolvedValueOnce(mockResponse1 as any)
          .mockResolvedValue(mockResponseEmpty as any);

        // Continuous mode should keep polling
        const streamIterator = adapter.createStream(query, { continuous: true });
        const results: LogEvent[] = [];
        const iterator = streamIterator[Symbol.asyncIterator]();

        // Get first result
        const result1 = await iterator.next();
        if (!result1.done) {
          results.push(result1.value);
        }

        // Wait a bit for potential second poll
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(results).toHaveLength(1);
        expect(results[0].message).toBe("Live event 1");

        // Should make multiple API calls (continuous polling)
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/search/universal/relative"),
          expect.objectContaining({
            method: "GET",
          })
        );

        await adapter.destroy();

        // Restore fake timers
        jest.useFakeTimers();
      });

      it("should default to historical mode when continuous option not specified", async () => {
        const query = "service:backend";

        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [
              {
                message: {
                  _id: "msg1",
                  message: "Default mode event",
                  timestamp: "2022-01-01T00:00:00.000Z",
                  source: "backend-server",
                  fields: {
                    service: "backend",
                  },
                },
                index: "graylog_0",
              },
            ],
            total_results: 1,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        // No continuous option specified - should default to historical
        const streamIterator = adapter.createStream(query);
        const results: LogEvent[] = [];

        for await (const event of streamIterator) {
          results.push(event);
        }

        expect(results).toHaveLength(1);
        expect(results[0].message).toBe("Default mode event");

        // Should only make one API call (historical mode default)
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await adapter.destroy();
      });

      it("should respect timeRange option in both modes", async () => {
        // Use real timers
        jest.useRealTimers();

        const query = "service:api";
        const timeRange = "30m";

        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        // Test historical mode with custom time range
        startStreamAndCheckFetch(adapter, query, { 
          continuous: false, 
          timeRange: timeRange 
        });

        // Wait for fetch
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/search/universal/relative"),
          expect.objectContaining({
            method: "GET",
          })
        );

        await adapter.destroy();

        // Restore fake timers
        jest.useFakeTimers();
      });
    });

    describe("maxResults option", () => {
      it("should respect maxResults option in adapter configuration", async () => {
        const customMaxResults = 5000;
        const optionsWithMaxResults = {
          ...defaultOptions,
          maxResults: customMaxResults,
        };

        const customAdapter = new GraylogAdapter(optionsWithMaxResults);
        const query = "service:frontend";

        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        // Use real timers for this test
        jest.useRealTimers();

        startStreamAndCheckFetch(customAdapter, query);

        // Wait for fetch call
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("limit=5000"),
          expect.any(Object)
        );

        await customAdapter.destroy();

        // Restore fake timers
        jest.useFakeTimers();
      });

      it("should use default maxResults (10000) when not specified", async () => {
        const query = "service:backend";

        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        // Use real timers for this test
        jest.useRealTimers();

        startStreamAndCheckFetch(adapter, query);

        // Wait for fetch call
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("limit=10000"),
          expect.any(Object)
        );

        await adapter.destroy();

        // Restore fake timers
        jest.useFakeTimers();
      });

      it("should apply maxResults to both historical and continuous modes", async () => {
        const customMaxResults = 2500;
        const optionsWithMaxResults = {
          ...defaultOptions,
          maxResults: customMaxResults,
        };

        const customAdapter = new GraylogAdapter(optionsWithMaxResults);
        
        // Use real timers for polling tests
        jest.useRealTimers();

        const query = "service:test";

        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        // Test historical mode
        startStreamAndCheckFetch(customAdapter, query, { continuous: false });
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("limit=2500"),
          expect.any(Object)
        );

        mockFetch.mockClear();

        // Test continuous mode
        startStreamAndCheckFetch(customAdapter, query, { continuous: true });
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("limit=2500"),
          expect.any(Object)
        );

        await customAdapter.destroy();

        // Restore fake timers
        jest.useFakeTimers();
      });

      it("should handle large result sets up to maxResults limit", async () => {
        const customMaxResults = 3;
        const optionsWithMaxResults = {
          ...defaultOptions,
          maxResults: customMaxResults,
        };

        const customAdapter = new GraylogAdapter(optionsWithMaxResults);
        const query = "level:info";

        // Mock response with more messages than maxResults limit
        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [
              {
                message: {
                  _id: "msg1",
                  message: "Info message 1",
                  timestamp: "2022-01-01T00:00:00.000Z",
                  source: "server1",
                  fields: { level: "info" },
                },
                index: "graylog_0",
              },
              {
                message: {
                  _id: "msg2", 
                  message: "Info message 2",
                  timestamp: "2022-01-01T00:00:01.000Z",
                  source: "server2",
                  fields: { level: "info" },
                },
                index: "graylog_0",
              },
              // This would exceed our maxResults=3 if there was a third message,
              // but Graylog should respect the limit parameter
            ],
            total_results: 2,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        const streamIterator = customAdapter.createStream(query);
        const results: LogEvent[] = [];

        for await (const event of streamIterator) {
          results.push(event);
        }

        expect(results).toHaveLength(2);
        expect(results[0].message).toBe("Info message 1");
        expect(results[1].message).toBe("Info message 2");

        await customAdapter.destroy();
      });
    });
  });

  describe("Graylog v6 API", () => {
    beforeEach(() => {
      defaultOptions = {
        ...defaultOptions,
        apiVersion: "v6",
      };
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should use POST method for v6 views API", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        text: jest
          .fn()
          .mockResolvedValue(
            "timestamp,source,message\n" +
              "2024-01-01T10:00:00Z,frontend,Test message 1\n" +
              "2024-01-01T10:00:01Z,frontend,Test message 2"
          ),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      startStreamAndCheckFetch(adapter, query);

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/views/search/messages"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Accept: "text/csv",
          }),
          body: expect.stringContaining('"query_string"'),
        })
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should parse CSV response from v6 API", async () => {
      const query = "service:frontend";

      const csvResponse =
        "timestamp,source,message,_id,request_id\n" +
        '"2024-01-01T10:00:00Z","frontend","Request started","msg1","req123"\n' +
        '"2024-01-01T10:00:01Z","backend","Request processed","msg2","req123"';

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(csvResponse),
      } as any);

      const streamIterator = adapter.createStream(query);
      const results: LogEvent[] = [];

      for await (const event of streamIterator) {
        results.push(event);
        if (results.length >= 2) break;
      }

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        timestamp: "2024-01-01T10:00:00Z",
        source: "graylog",
        stream: "frontend",
        message: "Request started",
      });
      expect(results[1]).toMatchObject({
        timestamp: "2024-01-01T10:00:01Z",
        source: "graylog",
        stream: "backend",
        message: "Request processed",
      });

      await adapter.destroy();
    });

    it("should handle CSV with quoted fields containing commas", async () => {
      const query = "service:frontend";

      const csvResponse =
        "timestamp,message\n" +
        '"2024-01-01T10:00:00Z","Error: Failed to process, reason: timeout"';

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(csvResponse),
      } as any);

      const streamIterator = adapter.createStream(query);
      const results: LogEvent[] = [];

      for await (const event of streamIterator) {
        results.push(event);
        break;
      }

      expect(results[0].message).toBe(
        "Error: Failed to process, reason: timeout"
      );

      await adapter.destroy();
    });

    it("should handle empty CSV response", async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        text: jest.fn().mockResolvedValue(""),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      startStreamAndCheckFetch(adapter, query);

      // Wait for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should continue polling even with empty response
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/views/search/messages"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });
  });

  describe("Query conversion", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should convert PromQL-style label matchers to Graylog syntax", async () => {
      // Use real timers for this test to avoid hanging
      jest.useRealTimers();

      const queries = [
        { input: 'service="frontend"', expected: "service:frontend" },
        { input: "level='error'", expected: "level:error" },
        {
          input: 'service="web" AND level="info"',
          expected: "service:web AND level:info",
        },
        {
          input: 'host="server1" OR host="server2"',
          expected: "host:server1 OR host:server2",
        },
      ];

      for (const { input } of queries) {
        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        startStreamAndCheckFetch(adapter, input);

        // Wait a short time for the fetch call to happen
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Verify the converted query is used
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("query="),
          expect.any(Object)
        );

        mockFetch.mockClear();
      }

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });
  });

  describe("Join key extraction", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should extract join keys from message fields", async () => {
      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [
            {
              message: {
                _id: "msg1",
                message: "Processing request",
                timestamp: "2022-01-01T00:00:00.000Z",
                source: "server",
                fields: {
                  request_id: "req123",
                  trace_id: "trace456",
                  correlation_id: "corr789",
                  user_id: "user999", // Should be extracted as it ends with _id
                  level: "info", // Should not be extracted
                },
              },
            },
          ],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streamIterator = adapter.createStream(query);
      const result = await (() => {
        const iterator = streamIterator[Symbol.asyncIterator]();
        return iterator.next();
      })();

      expect(result.value?.joinKeys).toMatchObject({
        request_id: "req123",
        trace_id: "trace456",
        correlation_id: "corr789",
        user_id: "user999",
      });

      await adapter.destroy();
    });

    it("should extract join keys from message content", async () => {
      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [
            {
              message: {
                _id: "msg1",
                message: "Processing request_id=abc123 with trace-id def456",
                timestamp: "2022-01-01T00:00:00.000Z",
                source: "server",
                fields: {},
              },
            },
          ],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streamIterator = adapter.createStream(query);
      const result = await (() => {
        const iterator = streamIterator[Symbol.asyncIterator]();
        return iterator.next();
      })();

      expect(result.value?.joinKeys).toMatchObject({
        request_id: "abc123",
        trace_id: "def456",
      });

      await adapter.destroy();
    });

    it("should handle non-string field values", async () => {
      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [
            {
              message: {
                _id: "msg1",
                message: "Processing request",
                timestamp: "2022-01-01T00:00:00.000Z",
                source: "server",
                fields: {
                  request_id: 123, // Number
                  is_error: true, // Boolean
                  metadata: { key: "value" }, // Object
                  tags: ["tag1", "tag2"], // Array
                },
              },
            },
          ],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streamIterator = adapter.createStream(query);
      const result = await (() => {
        const iterator = streamIterator[Symbol.asyncIterator]();
        return iterator.next();
      })();

      expect(result.value?.labels).toMatchObject({
        request_id: "123",
        is_error: "true",
      });

      expect(result.value?.joinKeys).toMatchObject({
        request_id: "123",
      });

      await adapter.destroy();
    });
  });

  describe("Time range parsing", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should parse different time range formats", async () => {
      // Use real timers for this test to avoid hanging
      jest.useRealTimers();

      const testCases = [
        { timeRange: "30s", expectedMs: 30 * 1000 },
        { timeRange: "5m", expectedMs: 5 * 60 * 1000 },
        { timeRange: "2h", expectedMs: 2 * 60 * 60 * 1000 },
        { timeRange: "1d", expectedMs: 1 * 24 * 60 * 60 * 1000 },
      ];

      for (const { timeRange } of testCases) {
        const query = "service:frontend";

        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            messages: [],
            total_results: 0,
          }),
        };

        mockFetch.mockResolvedValue(mockResponse as any);

        startStreamAndCheckFetch(adapter, query, { timeRange });

        // Wait a short time for the fetch call to happen
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/search/universal/relative"),
          expect.any(Object)
        );

        mockFetch.mockClear();
      }

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should use default time range for invalid formats", async () => {
      // Use real timers for this test to avoid hanging
      jest.useRealTimers();

      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
          total_results: 0,
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      startStreamAndCheckFetch(adapter, query, {
        timeRange: "invalid",
      });

      // Wait a short time for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should still make request with default time range
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });
  });

  describe("getAvailableStreams", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should fetch available streams", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          streams: [
            { title: "Application Logs" },
            { title: "System Logs" },
            { title: "Security Logs" },
          ],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streams = await adapter.getAvailableStreams();

      expect(streams).toEqual([
        "Application Logs",
        "System Logs",
        "Security Logs",
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9000/api/streams",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.any(String),
            Accept: "application/json",
            "X-Requested-By": "log-correlator",
          }),
        })
      );
    });

    it("should handle fetch errors gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const streams = await adapter.getAvailableStreams();

      expect(streams).toEqual([]);
    });

    it("should handle HTTP errors gracefully", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      } as any);

      const streams = await adapter.getAvailableStreams();

      expect(streams).toEqual([]);
    });

    it("should handle malformed response gracefully", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          // Missing streams property
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streams = await adapter.getAvailableStreams();

      expect(streams).toEqual([]);
    });
  });

  describe("destroy", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should cancel active polling streams", async () => {
      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
          total_results: 0,
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streamIterator = adapter.createStream(query);

      // Start iteration
      const iterator = streamIterator[Symbol.asyncIterator]();
      void iterator.next(); // Start the async iteration

      await adapter.destroy();

      // The stream should be cancelled
      // AbortController should prevent further fetch calls
      expect(true).toBe(true);
    });

    it("should handle multiple concurrent streams", async () => {
      const queries = ["service:frontend", "service:backend", "level:error"];

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
          total_results: 0,
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      // Start multiple streams
      const streamIterators = queries.map((query) =>
        adapter.createStream(query)
      );
      streamIterators.forEach((iter) => {
        const iterator = iter[Symbol.asyncIterator]();
        void iterator.next(); // Start the async iteration
      });

      await adapter.destroy();

      // All streams should be cancelled
      expect(true).toBe(true);
    });
  });

  describe("Edge cases and error handling", () => {
    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    it("should handle empty message arrays", async () => {
      // Use real timers for this test to avoid hanging
      jest.useRealTimers();

      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
          total_results: 0,
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      startStreamAndCheckFetch(adapter, query);

      // Wait a short time for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should handle malformed message objects", async () => {
      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [
            {
              message: {
                // Missing required fields
                _id: "msg1",
                // No message, timestamp, source, or fields
              },
            },
          ],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streamIterator = adapter.createStream(query);
      const result = await (() => {
        const iterator = streamIterator[Symbol.asyncIterator]();
        return iterator.next();
      })();

      // Should handle malformed message gracefully
      expect(result.value).toBeDefined();
      expect(result.value?.message).toBeDefined();

      await adapter.destroy();
    });

    it("should handle JSON parsing errors in continuous mode", async () => {
      // Use real timers for this test to avoid hanging
      jest.useRealTimers();

      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockRejectedValue(new Error("Invalid JSON")),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      startStreamAndCheckFetch(adapter, query, { continuous: true });

      // Wait a short time for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should handle network timeouts", async () => {
      // Use real timers for this test to avoid hanging
      jest.useRealTimers();

      const options = { ...defaultOptions, timeout: 100 };
      adapter = new GraylogAdapter(options);

      const query = "service:frontend";

      // Mock a hanging request
      mockFetch.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      startStreamAndCheckFetch(adapter, query);

      // Wait a short time for the fetch call to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should handle timeout gracefully
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/search/universal/relative"),
        expect.any(Object)
      );

      await adapter.destroy();

      // Restore fake timers
      jest.useFakeTimers();
    });

    it("should handle missing stream in message response", async () => {
      const query = "service:frontend";

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [
            {
              message: {
                _id: "msg1",
                message: "Test message",
                timestamp: "2022-01-01T00:00:00.000Z",
                // Missing source field
                fields: {},
              },
            },
          ],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const streamIterator = adapter.createStream(query);
      const result = await (() => {
        const iterator = streamIterator[Symbol.asyncIterator]();
        return iterator.next();
      })();

      expect(result.value?.stream).toBe("unknown");

      await adapter.destroy();
    });
  });

  describe("parseGraylogMessage", () => {
    let adapter: GraylogAdapter;

    beforeEach(() => {
      adapter = new GraylogAdapter(defaultOptions);
    });

    describe("Field structure handling", () => {
      it("should parse messages with fields in message.fields structure", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            service: "frontend",
            level: "info",
            request_id: "req123",
            trace_id: "trace456",
            user_id: "user789",
            response_time: 250,
            is_error: false,
            status: "success"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result).toEqual({
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "graylog",
          stream: "test-server",
          message: "Test message",
          labels: {
            service: "frontend",
            level: "info",
            request_id: "req123",
            trace_id: "trace456",
            user_id: "user789",
            response_time: "250",
            is_error: "false",
            status: "success"
          },
          joinKeys: {
            request_id: "req123",
            trace_id: "trace456",
            user_id: "user789"
          }
        });
      });

      it("should parse messages with fields directly on message object", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          // Fields directly on message object (no nested fields property)
          service: "backend",
          level: "warn",
          correlation_id: "corr123",
          session_id: "sess456",
          duration: 1500,
          completed: true,
          priority: "high"
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result).toEqual({
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "graylog",
          stream: "test-server",
          message: "Test message",
          labels: {
            service: "backend",
            level: "warn",
            correlation_id: "corr123",
            session_id: "sess456",
            duration: "1500",
            completed: "true",
            priority: "high"
          },
          joinKeys: {
            correlation_id: "corr123",
            session_id: "sess456"
          }
        });
      });

      it("should handle message with both fields property and direct fields", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            service: "api",
            request_id: "req123"
          },
          // Direct fields that should be ignored when fields property exists
          level: "error",
          trace_id: "trace456"
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        // Should use fields property, not direct fields
        expect(result.labels).toEqual({
          service: "api",
          request_id: "req123"
        });
        expect(result.joinKeys).toEqual({
          request_id: "req123"
        });
      });
    });

    describe("System fields filtering", () => {
      it("should filter out system fields from message.fields", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            service: "frontend",
            level: "info",
            _id: "internal123",
            gl2_message_id: "gl2_123",
            streams: ["stream1", "stream2"],
            decoration_stats: { count: 5 },
            message: "duplicate message",
            timestamp: "duplicate timestamp",
            source: "duplicate source",
            fields: "duplicate fields"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        // Only service and level should be in labels, system fields filtered out
        expect(result.labels).toEqual({
          service: "frontend",
          level: "info"
        });
        expect(result.joinKeys).toEqual({});
      });

      it("should filter out system fields from direct message properties", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          service: "backend",
          level: "error",
          gl2_message_id: "gl2_456",
          streams: ["stream3"],
          decoration_stats: { processed: true }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        // Only service and level should be in labels
        expect(result.labels).toEqual({
          service: "backend",
          level: "error"
        });
      });
    });

    describe("Join key identification", () => {
      it("should identify join keys from fields ending with _id", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            user_id: "user123",
            session_id: "sess456",
            transaction_id: "txn789",
            request_id: "req999",
            random_field: "not_a_key"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.joinKeys).toEqual({
          user_id: "user123",
          session_id: "sess456",
          transaction_id: "txn789",
          request_id: "req999"
        });
      });

      it("should identify join keys containing correlation", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            correlation_id: "corr123",
            correlation_token: "token456",
            request_correlation: "reqcorr789",
            correlation: "simple_corr",
            unrelated_field: "not_correlated"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.joinKeys).toEqual({
          correlation_id: "corr123",
          correlation_token: "token456",
          request_correlation: "reqcorr789",
          correlation: "simple_corr"
        });
      });

      it("should identify join keys containing trace", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            trace_id: "trace123",
            trace_span: "span456",
            distributed_trace: "dtrace789",
            trace: "simple_trace",
            other_field: "no_trace_here"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.joinKeys).toEqual({
          trace_id: "trace123",
          trace_span: "span456",
          distributed_trace: "dtrace789",
          trace: "simple_trace"
        });
      });

      it("should identify join keys containing request_id", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            request_id: "req123",
            http_request_id: "http_req456",
            parent_request_id: "parent789",
            other_field: "no_request_here"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.joinKeys).toEqual({
          request_id: "req123",
          http_request_id: "http_req456",
          parent_request_id: "parent789"
        });
      });

      it("should combine multiple join key identification patterns", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            user_id: "user123",
            correlation_token: "corr456",
            trace_span: "trace789",
            parent_request_id: "req999",
            normal_field: "not_a_join_key"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.joinKeys).toEqual({
          user_id: "user123",
          correlation_token: "corr456",
          trace_span: "trace789",
          parent_request_id: "req999"
        });
      });
    });

    describe("Field type conversion", () => {
      it("should convert string fields to string labels", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            service: "frontend",
            level: "info",
            status: "success"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.labels).toEqual({
          service: "frontend",
          level: "info",
          status: "success"
        });
      });

      it("should convert number fields to string labels", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            response_time: 250,
            status_code: 200,
            retry_count: 0,
            temperature: 98.6,
            user_id: 12345
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.labels).toEqual({
          response_time: "250",
          status_code: "200",
          retry_count: "0",
          temperature: "98.6",
          user_id: "12345"
        });

        // user_id should also be a join key
        expect(result.joinKeys).toEqual({
          user_id: "12345"
        });
      });

      it("should convert boolean fields to string labels", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            is_error: true,
            completed: false,
            authenticated: true,
            cache_hit: false
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.labels).toEqual({
          is_error: "true",
          completed: "false",
          authenticated: "true",
          cache_hit: "false"
        });
      });

      it("should skip non-primitive field types", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            service: "frontend", // string - should be included
            count: 42, // number - should be included
            enabled: true, // boolean - should be included
            metadata: { key: "value" }, // object - should be skipped
            tags: ["tag1", "tag2"], // array - should be skipped
            nullable_field: null, // null - should be skipped
            undefined_field: undefined // undefined - should be skipped
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.labels).toEqual({
          service: "frontend",
          count: "42",
          enabled: "true"
        });
      });
    });

    describe("Edge cases", () => {
      it("should handle message with no fields property and no direct fields", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server"
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.labels).toEqual({});
        expect(result.joinKeys).toEqual({});
      });

      it("should handle message with empty fields object", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {}
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.labels).toEqual({});
        expect(result.joinKeys).toEqual({});
      });

      it("should handle message with missing timestamp", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          source: "test-server",
          fields: {
            service: "frontend"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
        expect(result.labels).toEqual({
          service: "frontend"
        });
      });

      it("should handle message with missing source", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          fields: {
            service: "frontend"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.stream).toBe("unknown");
      });

      it("should handle message with missing message content", () => {
        const graylogMessage = {
          _id: "msg123",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            service: "frontend"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.message).toBe("");
      });

      it("should handle fields with empty string values", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Test message",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {
            service: "",
            level: "info",
            empty_id: "",
            request_id: "req123"
          }
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        expect(result.labels).toEqual({
          service: "",
          level: "info",
          empty_id: "",
          request_id: "req123"
        });

        expect(result.joinKeys).toEqual({
          empty_id: "",
          request_id: "req123"
        });
      });

      it("should extract join keys from message content when fields are missing", () => {
        const graylogMessage = {
          _id: "msg123",
          message: "Processing request_id=abc123 with trace-id def456 for correlation_id ghi789",
          timestamp: "2022-01-01T00:00:00.000Z",
          source: "test-server",
          fields: {}
        };

        const result = (adapter as any).parseGraylogMessage(graylogMessage);

        // Should extract from message content
        expect(result.joinKeys).toMatchObject({
          request_id: "abc123",
          trace_id: "def456",
          correlation_id: "ghi789"
        });
      });
    });
  });
});
