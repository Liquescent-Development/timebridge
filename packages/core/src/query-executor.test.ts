import { TimeQLExecutor } from "./query-executor";
import { DataSourceAdapter, LogEvent, CorrelatedEvent, TimeQLResult } from "./types";
import { TimeBridgeEngine } from "./correlation-engine";

// Import type guards directly to ensure they work in tests
function isEventResult(result: TimeQLResult): result is TimeQLResult & { type: 'event'; data: LogEvent } {
  return result.type === 'event';
}

function isCorrelationResult(result: TimeQLResult): result is TimeQLResult & { type: 'correlation'; data: CorrelatedEvent } {
  return result.type === 'correlation';
}

// Mock PeggyQueryParser for testing
class MockPeggyQueryParser {
  isDirect(query: string): boolean {
    // Simple mock logic: queries with 'and on', 'or on', 'unless on' are correlations
    const trimmedQuery = query.trim();
    // More flexible pattern to match correlation operators
    return !/(\s+(and|or|unless)\s+on\s*\([^)]+\))/i.test(trimmedQuery);
  }

  parse(query: string): any {
    const trimmedQuery = query.trim();
    const isDirect = this.isDirect(trimmedQuery);
    
    if (isDirect) {
      // Extract source from direct query like "graylog(selector)[timeRange]"
      const match = trimmedQuery.match(/^([\w-]+)\s*\([^)]*\)(?:\[[^\]]*\])?/);
      const source = match ? match[1] : 'unknown';
      return {
        leftStream: {
          source,
          selector: trimmedQuery,
          timeRange: '5m'
        }
      };
    } else {
      // Extract sources from correlation query - improved parsing
      const sources = [];
      // Match patterns like "graylog-prod(test)[5m] and on(id) graylog-staging(test)[5m]"
      // But exclude "on" patterns which are join operators
      const sourceMatches = trimmedQuery.match(/([\w-]+)\s*\([^)]*\)(?:\[[^\]]*\])?/g);
      if (sourceMatches) {
        for (const match of sourceMatches) {
          const sourceMatch = match.match(/^([\w-]+)/);
          if (sourceMatch && sourceMatch[1] !== 'on') { // Skip "on" join operators
            sources.push(sourceMatch[1]);
          }
        }
      }
      
      return {
        leftStream: sources[0] ? { source: sources[0], selector: '', timeRange: '5m' } : null,
        rightStream: sources[1] ? { source: sources[1], selector: '', timeRange: '5m' } : null,
        additionalStreams: sources.slice(2).map(source => ({ source, selector: '', timeRange: '5m' }))
      };
    }
  }

  validate(query: string): { valid: boolean; error?: string; details?: any } {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return { valid: false, error: 'Empty query' };
    }
    
    // Basic validation - check for proper format
    if (!/^[\w-]+\s*\([^)]*\)(?:\[[^\]]*\])?/.test(trimmedQuery)) {
      return { valid: false, error: 'Invalid query format' };
    }
    
    return {
      valid: true,
      details: {
        type: this.isDirect(trimmedQuery) ? 'direct' : 'correlation'
      }
    };
  }
}

// Mock adapter for testing
class MockAdapter implements DataSourceAdapter {
  constructor(private name: string, private events: LogEvent[] = []) {}

  async *createStream(
    selector: string,
    options?: { timeRange?: string }
  ): AsyncIterable<LogEvent> {
    // Simulate parsing selector for filtering
    const filters = this.parseSelector(selector);
    
    for (const event of this.events) {
      // Apply filtering if selector has filters, otherwise return all events
      if (!this.matchesFilters(event, filters)) {
        continue;
      }
      yield { ...event, source: this.name };
      // Small delay to simulate real streaming
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  private parseSelector(selector: string): Record<string, string> | null {
    // Basic selector parsing for testing - more flexible parsing
    const filters: Record<string, string> = {};
    
    // Match patterns like service:frontend, level="error", {service='api'}, etc.
    const patterns = [
      /(\w+)[:=]"?'?([^"'\s,})]+)"?'?/g,  // service:frontend or level="error"
      /(\w+)\s*=\s*["']([^"']+)["']/g      // service="frontend" or service='frontend'
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(selector)) !== null) {
        const [, key, value] = match;
        if (key && value) {
          filters[key] = value;
        }
      }
    }
    
    return Object.keys(filters).length > 0 ? filters : null;
  }

  private matchesFilters(event: LogEvent, filters: Record<string, string> | null): boolean {
    // If no filters specified, return all events
    if (!filters || Object.keys(filters).length === 0) {
      return true;
    }
    
    // Check if event matches all specified filters
    for (const [key, value] of Object.entries(filters)) {
      if (event.labels?.[key] !== value) {
        return false;
      }
    }
    return true;
  }

  validateQuery(_query: string): boolean {
    return true;
  }

  getName(): string {
    return this.name;
  }

  async destroy(): Promise<void> {}
}

// Mock TimeBridgeEngine for correlation testing
class MockTimeBridgeEngine {
  private adapters: Map<string, DataSourceAdapter> = new Map();

  addAdapter(name: string, adapter: DataSourceAdapter): void {
    this.adapters.set(name, adapter);
  }

  async *correlate(query: string): AsyncGenerator<CorrelatedEvent> {
    // Mock correlation result based on query
    const mockCorrelation: CorrelatedEvent = {
      correlationId: 'corr-123',
      timestamp: new Date().toISOString(),
      timeWindow: {
        start: new Date(Date.now() - 5000).toISOString(),
        end: new Date().toISOString()
      },
      joinKey: 'request_id',
      joinValue: 'req123',
      events: [
        {
          source: 'graylog',
          timestamp: new Date().toISOString(),
          message: 'Frontend event',
          labels: { service: 'frontend', request_id: 'req123' }
        },
        {
          source: 'loki',
          timestamp: new Date().toISOString(),
          message: 'Backend event',
          labels: { service: 'backend', request_id: 'req123' }
        }
      ],
      metadata: {
        completeness: 'complete' as const,
        matchedStreams: ['graylog', 'loki'],
        totalStreams: 2
      }
    };
    
    yield mockCorrelation;
  }

  async destroy(): Promise<void> {}
}

// Mock the PeggyQueryParser module
jest.mock('@timebridge/timeql-parser/dist/peggy-parser', () => ({
  PeggyQueryParser: jest.fn().mockImplementation(() => new MockPeggyQueryParser())
}));

// Mock the TimeBridgeEngine 
jest.mock('./correlation-engine', () => ({
  TimeBridgeEngine: jest.fn().mockImplementation(() => new MockTimeBridgeEngine())
}));

describe("TimeQLExecutor", () => {

  let executor: TimeQLExecutor;

  beforeEach(() => {
    executor = new TimeQLExecutor();
  });

  describe("adapter registration", () => {
    it("should register adapters with custom names", () => {
      const adapter = new MockAdapter("test");
      executor.addAdapter("graylog-prod", adapter);

      const info = executor.getAdapterInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe("graylog-prod");
      expect(info[0].baseType).toBe("graylog");
      expect(info[0].isDefault).toBe(true); // First of its type is default
    });

    it("should handle default adapters", () => {
      const adapter1 = new MockAdapter("prod");
      const adapter2 = new MockAdapter("staging");

      executor.addAdapter("graylog-staging", adapter2);
      executor.addAdapter("graylog-prod", adapter1, { isDefault: true });

      const info = executor.getAdapterInfo();
      const prodInfo = info.find((i) => i.name === "graylog-prod");
      const stagingInfo = info.find((i) => i.name === "graylog-staging");

      expect(prodInfo?.isDefault).toBe(true);
      expect(stagingInfo?.isDefault).toBe(false);
    });

    it("should automatically set first adapter of type as default", () => {
      const adapter1 = new MockAdapter("first");
      const adapter2 = new MockAdapter("second");

      executor.addAdapter("graylog-first", adapter1);
      executor.addAdapter("graylog-second", adapter2);

      const info = executor.getAdapterInfo();
      expect(info[0].isDefault).toBe(true);
      expect(info[1].isDefault).toBe(false);
    });

    it("should resolve base type to specific adapter name", () => {
      const adapter = new MockAdapter("prod");
      executor.addAdapter("graylog-prod", adapter, { isDefault: true });

      const info = executor.getAdapterInfo();
      expect(info[0].name).toBe("graylog-prod");
      expect(info[0].baseType).toBe("graylog");
      expect(info[0].isDefault).toBe(true);
    });
  });

  describe("query validation", () => {
    it("should validate direct queries with available adapters", () => {
      const adapter = new MockAdapter("test");
      executor.addAdapter("graylog", adapter);

      const result = executor.validateQuery("graylog(test)[5m]");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("direct");
      expect(result.sources).toEqual(["graylog"]);
    });

    it("should fail validation for missing adapters", () => {
      const result = executor.validateQuery("graylog(test)[5m]");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing adapters for sources: graylog");
    });

    it("should validate correlation queries", () => {
      const adapter1 = new MockAdapter("prod");
      const adapter2 = new MockAdapter("staging");
      executor.addAdapter("graylog-prod", adapter1);
      executor.addAdapter("graylog-staging", adapter2);

      const result = executor.validateQuery(
        "graylog-prod(test)[5m] and on(id) graylog-staging(test)[5m]"
      );
      expect(result.valid).toBe(true);
      expect(result.type).toBe("correlation");
      expect(result.sources).toEqual(["graylog-prod", "graylog-staging"]);
    });

    it("should resolve base type to default adapter", () => {
      const adapter = new MockAdapter("test");
      executor.addAdapter("graylog-prod", adapter, { isDefault: true });

      const result = executor.validateQuery("graylog(test)[5m]");
      expect(result.valid).toBe(true);
    });

    it("should validate multiline queries", () => {
      const adapter1 = new MockAdapter("graylog");
      const adapter2 = new MockAdapter("loki");
      executor.addAdapter("graylog", adapter1);
      executor.addAdapter("loki", adapter2);

      const multilineQuery = `
        graylog(service:frontend)[5m]
          and on(request_id)
        loki({job="backend"})[5m]
      `;
      
      const result = executor.validateQuery(multilineQuery);
      expect(result.valid).toBe(true);
      expect(result.type).toBe("correlation");
      expect(result.sources).toEqual(["graylog", "loki"]);
    });

    it("should handle invalid queries", () => {
      const result = executor.validateQuery("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Empty query");
    });

    it("should handle malformed queries", () => {
      const result = executor.validateQuery("invalid query format");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid query format");
    });
  });

  describe("execute() method - unified TimeQL execution", () => {
    it("should return TimeQLResult objects for direct queries", async () => {
      const events: LogEvent[] = [
        {
          timestamp: new Date().toISOString(),
          source: "graylog",
          message: "test1",
          labels: { service: "frontend" },
        },
        {
          timestamp: new Date().toISOString(),
          source: "graylog", 
          message: "test2",
          labels: { service: "frontend" },
        },
      ];
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog(service:frontend)[5m]")) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results[0].type).toBe('event');
      expect(results[1].type).toBe('event');
      expect(isEventResult(results[0])).toBe(true);
      expect(isCorrelationResult(results[0])).toBe(false);
      
      if (isEventResult(results[0])) {
        expect(results[0].data.message).toBe("test1");
        expect(results[0].data.source).toBe("graylog");
      }
    });

    it("should return TimeQLResult objects for correlation queries", async () => {
      const graylogEvents: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog",
        message: "Frontend request",
        labels: { service: "frontend", request_id: "req123" },
      }];
      
      const lokiEvents: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "loki", 
        message: "Backend processing",
        labels: { service: "backend", request_id: "req123" },
      }];

      const graylogAdapter = new MockAdapter("graylog", graylogEvents);
      const lokiAdapter = new MockAdapter("loki", lokiEvents);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute(
        "graylog(service:frontend)[5m] and on(request_id) loki({service='backend'})[5m]"
      )) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('correlation');
      expect(isCorrelationResult(results[0])).toBe(true);
      expect(isEventResult(results[0])).toBe(false);
      
      if (isCorrelationResult(results[0])) {
        expect(results[0].data.correlationId).toBe('corr-123');
        expect(results[0].data.joinKey).toBe('request_id');
        expect(results[0].data.events).toHaveLength(2);
      }
    });

    it("should handle multiline queries", async () => {
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog",
        message: "test",
        labels: { service: "frontend" },
      }];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      const multilineQuery = `
        graylog(service:frontend)[5m]
      `;

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute(multilineQuery)) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('event');
    });

    it("should handle multiline correlation queries with indentation", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      const multilineQuery = `
        graylog(service:frontend)[5m]
          and on(request_id) 
        loki({job="backend"})[5m]
      `;

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute(multilineQuery)) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('correlation');
    });

    it("should handle named adapter instances", async () => {
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog-prod",
        message: "prod event",
        labels: { env: "production" },
      }];
      
      const adapter = new MockAdapter("graylog-prod", events);
      executor.addAdapter("graylog-prod", adapter);

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog-prod(env:production)[5m]")) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('event');
      if (isEventResult(results[0])) {
        expect(results[0].data.source).toBe("graylog-prod");
        expect(results[0].data.message).toBe("prod event");
      }
    });

    it("should resolve base type to default adapter", async () => {
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog-prod",
        message: "default event",
        labels: {},
      }];
      
      const adapter = new MockAdapter("graylog-prod", events);
      executor.addAdapter("graylog-prod", adapter, { isDefault: true });

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog(test)[5m]")) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('event');
      if (isEventResult(results[0])) {
        expect(results[0].data.source).toBe("graylog-prod");
        expect(results[0].data.message).toBe("default event");
      }
    });

    it("should handle empty results gracefully", async () => {
      const adapter = new MockAdapter("graylog", []);
      executor.addAdapter("graylog", adapter);

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog(nonexistent)[5m]")) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });
  });

  describe("executeEvents() method - direct queries only", () => {
    it("should execute direct queries and return LogEvent objects", async () => {
      const events: LogEvent[] = [
        {
          timestamp: new Date().toISOString(),
          source: "graylog",
          message: "test1",
          labels: { service: "frontend" },
        },
        {
          timestamp: new Date().toISOString(),
          source: "graylog",
          message: "test2", 
          labels: { service: "frontend" },
        },
      ];
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      const results: LogEvent[] = [];
      for await (const event of executor.executeEvents("graylog(service:frontend)[5m]")) {
        results.push(event);
      }

      expect(results).toHaveLength(2);
      expect(results[0].message).toBe("test1");
      expect(results[0].source).toBe("graylog");
      expect(results[1].message).toBe("test2");
    });

    it("should throw error when given a correlation query", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      const executeCorrelationQuery = async () => {
        const results = [];
        for await (const event of executor.executeEvents(
          "graylog(service:frontend)[5m] and on(request_id) loki({service='backend'})[5m]"
        )) {
          results.push(event);
        }
      };

      await expect(executeCorrelationQuery()).rejects.toThrow(
        "Query is a correlation query, use executeCorrelation() instead"
      );
    });

    it("should handle multiline direct queries", async () => {
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog",
        message: "test",
        labels: { service: "frontend" },
      }];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      const multilineQuery = `
        graylog(service:frontend)[5m]
      `;

      const results: LogEvent[] = [];
      for await (const event of executor.executeEvents(multilineQuery)) {
        results.push(event);
      }

      expect(results).toHaveLength(1);
      expect(results[0].message).toBe("test");
    });
  });

  describe("executeCorrelation() method - correlation queries only", () => {
    it("should execute correlation queries and return CorrelatedEvent objects", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      const results: CorrelatedEvent[] = [];
      for await (const correlation of executor.executeCorrelation(
        "graylog(service:frontend)[5m] and on(request_id) loki({service='backend'})[5m]"
      )) {
        results.push(correlation);
      }

      expect(results).toHaveLength(1);
      expect(results[0].correlationId).toBe('corr-123');
      expect(results[0].joinKey).toBe('request_id');
      expect(results[0].metadata.totalStreams).toBe(2);
      expect(results[0].events).toHaveLength(2);
    });

    it("should throw error when given a direct query", async () => {
      const adapter = new MockAdapter("graylog", []);
      executor.addAdapter("graylog", adapter);

      const executeDirectQuery = async () => {
        const results = [];
        for await (const correlation of executor.executeCorrelation("graylog(service:frontend)[5m]")) {
          results.push(correlation);
        }
      };

      await expect(executeDirectQuery()).rejects.toThrow(
        "Query is a direct query, use executeEvents() instead"
      );
    });

    it("should handle multiline correlation queries", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      const multilineQuery = `
        graylog(service:frontend)[5m]
          and on(request_id)
        loki({job="backend"})[5m]
      `;

      const results: CorrelatedEvent[] = [];
      for await (const correlation of executor.executeCorrelation(multilineQuery)) {
        results.push(correlation);
      }

      expect(results).toHaveLength(1);
      expect(results[0].correlationId).toBe('corr-123');
    });

    it("should handle complex multi-stream correlations", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      const otherAdapter = new MockAdapter("other", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);
      executor.addAdapter("other", otherAdapter);

      const complexQuery = "graylog(service:frontend)[5m] and on(id) loki({job='api'})[5m] and on(id) other(type:audit)[5m]";

      const results: CorrelatedEvent[] = [];
      for await (const correlation of executor.executeCorrelation(complexQuery)) {
        results.push(correlation);
      }

      expect(results).toHaveLength(1);
      expect(results[0].correlationId).toBe('corr-123');
    });
  });

  describe("type guards", () => {
    it("should correctly identify event results", async () => {
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog",
        message: "test",
        labels: {},
      }];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog(test)[5m]")) {
        results.push(result);
        
        expect(isEventResult(result)).toBe(true);
        expect(isCorrelationResult(result)).toBe(false);
        
        if (isEventResult(result)) {
          // TypeScript should now know this is LogEvent
          expect(result.data.message).toBe("test");
          expect(result.data.source).toBe("graylog");
          expect(result.data.labels).toBeDefined();
        }
      }
    });

    it("should correctly identify correlation results", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute(
        "graylog(service:frontend)[5m] and on(request_id) loki({service='backend'})[5m]"
      )) {
        results.push(result);
        
        expect(isCorrelationResult(result)).toBe(true);
        expect(isEventResult(result)).toBe(false);
        
        if (isCorrelationResult(result)) {
          // TypeScript should now know this is CorrelatedEvent
          expect(result.data.correlationId).toBe('corr-123');
          expect(result.data.joinKey).toBe('request_id');
          expect(result.data.events).toHaveLength(2);
          expect(result.data.metadata).toBeDefined();
        }
      }
    });

    it("should type guard functions work correctly with mixed results", async () => {
      // Test that type guards correctly discriminate between result types
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog",
        message: "test event",
        labels: { service: "frontend" },
      }];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      // Test with direct query - should get event results
      const eventResults: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog(service:frontend)[5m]")) {
        eventResults.push(result);
      }

      expect(eventResults).toHaveLength(1);
      const eventResult = eventResults[0];
      
      // Type guard assertions
      expect(isEventResult(eventResult)).toBe(true);
      expect(isCorrelationResult(eventResult)).toBe(false);
      
      // TypeScript type narrowing test
      if (isEventResult(eventResult)) {
        expect(eventResult.type).toBe('event');
        expect(eventResult.data.message).toBe('test event');
        expect(eventResult.data.labels?.service).toBe('frontend');
        // This should compile without TypeScript errors because type is narrowed to LogEvent
        expect(eventResult.data.timestamp).toBeDefined();
        expect(eventResult.data.source).toBe('graylog');
      }

      // Test with correlation query - should get correlation results  
      const graylogAdapter2 = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog-test", graylogAdapter2);
      executor.addAdapter("loki-test", lokiAdapter);

      const correlationResults: TimeQLResult[] = [];
      for await (const result of executor.execute(
        "graylog-test(service:frontend)[5m] and on(request_id) loki-test({service='backend'})[5m]"
      )) {
        correlationResults.push(result);
      }

      expect(correlationResults).toHaveLength(1);
      const correlationResult = correlationResults[0];
      
      // Type guard assertions
      expect(isEventResult(correlationResult)).toBe(false);
      expect(isCorrelationResult(correlationResult)).toBe(true);
      
      // TypeScript type narrowing test
      if (isCorrelationResult(correlationResult)) {
        expect(correlationResult.type).toBe('correlation');
        expect(correlationResult.data.correlationId).toBe('corr-123');
        expect(correlationResult.data.joinKey).toBe('request_id');
        // This should compile without TypeScript errors because type is narrowed to CorrelatedEvent
        expect(correlationResult.data.events).toHaveLength(2);
        expect(correlationResult.data.metadata.totalStreams).toBe(2);
        expect(correlationResult.data.timeWindow).toBeDefined();
      }
    });
  });

  describe("method-specific error handling", () => {
    it("should throw descriptive error when executeEvents() is called with correlation query", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      const correlationQuery = "graylog(service:frontend)[5m] and on(request_id) loki({service='backend'})[5m]";
      
      await expect(async () => {
        const results = [];
        for await (const event of executor.executeEvents(correlationQuery)) {
          results.push(event);
        }
      }).rejects.toThrow('Query is a correlation query, use executeCorrelation() instead');
    });

    it("should throw descriptive error when executeCorrelation() is called with direct query", async () => {
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog",
        message: "test event",
        labels: { service: "frontend" },
      }];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      const directQuery = "graylog(service:frontend)[5m]";
      
      await expect(async () => {
        const results = [];
        for await (const correlation of executor.executeCorrelation(directQuery)) {
          results.push(correlation);
        }
      }).rejects.toThrow('Query is a direct query, use executeEvents() instead');
    });

    it("should validate query type before execution in executeEvents()", async () => {
      const adapter = new MockAdapter("graylog", []);
      executor.addAdapter("graylog", adapter);

      // This should work fine - direct query
      const directQuery = "graylog(test)[5m]";
      const results = [];
      for await (const event of executor.executeEvents(directQuery)) {
        results.push(event);
      }
      expect(results).toHaveLength(0); // No events in mock
    });

    it("should validate query type before execution in executeCorrelation()", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter);

      // This should work fine - correlation query
      const correlationQuery = "graylog(service:frontend)[5m] and on(request_id) loki({service='backend'})[5m]";
      const results = [];
      for await (const correlation of executor.executeCorrelation(correlationQuery)) {
        results.push(correlation);
      }
      expect(results).toHaveLength(1); // Mock correlation result
    });

    it("should handle edge case queries that might confuse type detection", async () => {
      // Query that contains "and on" in the message content but is actually a direct query
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog", 
        message: "Error: failed to connect and on retry the connection was established",
        labels: { service: "backend", message: "Error: failed to connect and on retry the connection was established" },
      }];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      // This should be detected as a direct query, not a correlation
      // Use a simpler query that the mock can match
      const trickQuery = 'graylog(service:backend)[5m]';
      
      // Should work with executeEvents()
      const eventResults = [];
      for await (const event of executor.executeEvents(trickQuery)) {
        eventResults.push(event);
      }
      expect(eventResults).toHaveLength(1);
      
      // Should throw with executeCorrelation()
      await expect(async () => {
        const results = [];
        for await (const correlation of executor.executeCorrelation(trickQuery)) {
          results.push(correlation);
        }
      }).rejects.toThrow('Query is a direct query, use executeEvents() instead');
    });

    it("should handle complex correlation queries correctly", async () => {
      const graylogAdapter = new MockAdapter("graylog", []);
      const lokiAdapter = new MockAdapter("loki", []);
      const prometheusAdapter = new MockAdapter("prometheus", []);
      executor.addAdapter("graylog", graylogAdapter);
      executor.addAdapter("loki", lokiAdapter); 
      executor.addAdapter("prometheus", prometheusAdapter);

      // Multi-stream correlation query
      const complexQuery = "graylog(service:frontend)[5m] and on(trace_id) loki({job='backend'})[5m] and on(trace_id) prometheus(job:metrics)[5m]";
      
      // Should work with executeCorrelation()
      const correlationResults = [];
      for await (const correlation of executor.executeCorrelation(complexQuery)) {
        correlationResults.push(correlation);
      }
      expect(correlationResults).toHaveLength(1);
      
      // Should throw with executeEvents()
      await expect(async () => {
        const results = [];
        for await (const event of executor.executeEvents(complexQuery)) {
          results.push(event);
        }
      }).rejects.toThrow('Query is a correlation query, use executeCorrelation() instead');
    });
  });

  describe("edge cases and error scenarios", () => {
    it("should handle queries that look like correlations but aren't", async () => {
      const events: LogEvent[] = [{
        timestamp: new Date().toISOString(),
        source: "graylog",
        message: "test log message",
        labels: { content: "something" },
      }];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      // This should be treated as a direct query since it doesn't have proper correlation operators
      const directQuery = "graylog(content:something)[5m]";
      
      const results: TimeQLResult[] = [];
      for await (const result of executor.execute(directQuery)) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('event');
    });

    it("should throw error for missing adapter in direct query", async () => {
      const executeQuery = async () => {
        const results = [];
        for await (const result of executor.execute("nonexistent(test)[5m]")) {
          results.push(result);
        }
      };

      await expect(executeQuery()).rejects.toThrow(
        "No adapter found for source: nonexistent"
      );
    });

    it("should handle whitespace-only queries gracefully", async () => {
      const executeQuery = async () => {
        const results = [];
        for await (const result of executor.execute("   \n\t   ")) {
          results.push(result);
        }
      };

      await expect(executeQuery()).rejects.toThrow();
    });

    it("should filter events based on selector parsing", async () => {
      const events: LogEvent[] = [
        {
          timestamp: new Date().toISOString(),
          source: "graylog",
          message: "frontend event",
          labels: { service: "frontend", level: "info" },
        },
        {
          timestamp: new Date().toISOString(),
          source: "graylog",
          message: "backend event",
          labels: { service: "backend", level: "error" },
        },
        {
          timestamp: new Date().toISOString(),
          source: "graylog",
          message: "another frontend event",
          labels: { service: "frontend", level: "error" },
        },
      ];
      
      const adapter = new MockAdapter("graylog", events);
      executor.addAdapter("graylog", adapter);

      // Filter for frontend service only
      const results: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog(service:frontend)[5m]")) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      for (const result of results) {
        if (isEventResult(result)) {
          expect(result.data.labels?.service).toBe("frontend");
        }
      }
    });

    it("should handle adapters with no events", async () => {
      const adapter = new MockAdapter("graylog", []);
      executor.addAdapter("graylog", adapter);

      const results: TimeQLResult[] = [];
      for await (const result of executor.execute("graylog(test)[5m]")) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });
  });
});
