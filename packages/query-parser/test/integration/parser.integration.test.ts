/**
 * TimeQL Parser Integration Tests
 *
 * These tests validate the complete parsing pipeline from TimeQL query strings
 * to fully structured query objects that can be executed by the TimeBridge engine.
 */

import { PeggyQueryParser } from "../../src/peggy-parser";

describe("TimeQL Parser Integration Tests", () => {
  let parser: PeggyQueryParser;

  beforeEach(() => {
    parser = new PeggyQueryParser();
  });

  describe("Complete Query Parsing Pipeline", () => {
    it("should parse and validate complex multi-source correlation queries", () => {
      const complexQuery = `loki({service="frontend",level="error",environment="prod"})[30m] and on(request_id,trace_id) within(5s) group_left(session_id,user_id) ignoring(timestamp,level) graylog(service:backend AND level:error)[30m] and on(trace_id) within(2s) prometheus(http_requests_total{status=~"5.."})[30m] {response_time="high",status_code="500"}`;

      const result = parser.parse(complexQuery);

      // Validate basic structure
      expect(result.leftStream.source).toBe("loki");
      expect(result.rightStream.source).toBe("graylog");
      expect(result.additionalStreams).toHaveLength(1);
      expect(result.additionalStreams![0].source).toBe("prometheus");

      // Validate temporal constraints
      expect(result.temporal).toBe("5s");

      // Validate grouping
      expect(result.grouping).toEqual({
        side: "left",
        labels: ["session_id", "user_id"],
      });

      // Validate join keys
      expect(result.joinKeys).toContain("request_id");
      expect(result.joinKeys).toContain("trace_id");

      // Validate ignoring clause
      expect(result.ignoring).toContain("timestamp");
      expect(result.ignoring).toContain("level");

      // Validate post-correlation filter
      expect(result.filter).toContain('response_time="high"');
      expect(result.filter).toContain('status_code="500"');
    });

    it("should handle all supported data sources", () => {
      const dataSources = [
        'loki({service="api"})[5m]',
        "graylog(service:api)[5m]",
        "prometheus(http_requests_total)[5m]",
        "influxdb(SELECT value FROM requests WHERE time > now() - 5m)[5m]",
        "custom-adapter(query)[5m]",
      ];

      for (const source of dataSources) {
        const result = parser.parse(`${source} and on(id) mock(test)[5m]`);
        expect(result.leftStream.source).toBeTruthy();
        expect(result.rightStream.source).toBe("mock");
      }
    });

    it("should parse nested label selectors correctly", () => {
      const query = `loki({service="frontend",environment=~"prod|staging",instance!="localhost",level!~"debug|trace"})[1h] and on(request_id) graylog(service:backend AND (level:error OR level:warn) AND NOT instance:test)[1h]`;

      const result = parser.parse(query);

      // Verify complex Loki selector parsing
      expect(result.leftStream.selector).toContain('service="frontend"');
      expect(result.leftStream.selector).toContain(
        'environment=~"prod|staging"'
      );
      expect(result.leftStream.selector).toContain('instance!="localhost"');
      expect(result.leftStream.selector).toContain('level!~"debug|trace"');

      // Verify complex Graylog selector parsing
      expect(result.rightStream.selector).toContain("service:backend");
      expect(result.rightStream.selector).toContain(
        "level:error OR level:warn"
      );
      expect(result.rightStream.selector).toContain("NOT instance:test");
    });

    it("should handle multiple join operations with different operators", () => {
      const query = `loki({job="nginx"})[10m] and on(request_id) within(1s) graylog(service:api)[10m] or on(session_id) within(30s) prometheus(user_sessions_total)[10m] unless on(error_id) within(5s) influxdb(SELECT value FROM errors WHERE time > now() - 10m)[10m]`;

      const result = parser.parse(query);

      expect(result.leftStream.source).toBe("loki");
      expect(result.rightStream.source).toBe("graylog");
      expect(result.joinType).toBe("and");

      expect(result.additionalStreams).toHaveLength(2);
      expect(result.additionalStreams![0].source).toBe("prometheus");
      expect(result.additionalStreams![1].source).toBe("influxdb");
    });

    it("should validate and format complex queries", () => {
      const messyQuery = `loki({service="test"})[5m] and on(id) within(10s) group_left(user) graylog(service:test)[5m] {status=~"4..|5.."}`;

      // First validate
      const validation = parser.validate(messyQuery);
      expect(validation.valid).toBe(true);

      // Then format
      const formatted = parser.formatQuery(messyQuery);
      expect(formatted).toContain('loki({service="test"})[5m]');
      expect(formatted).toContain("  and on(id) within(10s) group_left(user)");
      expect(formatted).toContain("  graylog(service:test)[5m]");
      expect(formatted).toContain('{status=~"4..|5.."}');
    });
  });

  describe("Advanced Features Integration", () => {
    it("should handle complex label mappings with validation", () => {
      const query = `loki({service="frontend"})[5m] and on(request_id=req_id,session_id=sess_id,user_id=uid) graylog(service:backend)[5m]`;

      const result = parser.parse(query);

      expect(result.labelMappings).toHaveLength(3);
      expect(result.labelMappings![0]).toEqual({
        left: "request_id",
        right: "req_id",
      });
      expect(result.labelMappings![1]).toEqual({
        left: "session_id",
        right: "sess_id",
      });
      expect(result.labelMappings![2]).toEqual({
        left: "user_id",
        right: "uid",
      });

      // Validate the query is syntactically correct
      expect(parser.validate(query).valid).toBe(true);
    });

    it("should support group modifiers with complex scenarios", () => {
      const groupLeftQuery = `loki({service="frontend"})[5m] and on(request_id) group_left(session_id,user_id,client_ip) graylog(service:backend)[5m]`;
      const groupRightQuery = `loki({service="frontend"})[5m] and on(request_id) group_right(operation,method,endpoint) graylog(service:backend)[5m]`;

      const leftResult = parser.parse(groupLeftQuery);
      expect(leftResult.grouping).toEqual({
        side: "left",
        labels: ["session_id", "user_id", "client_ip"],
      });

      const rightResult = parser.parse(groupRightQuery);
      expect(rightResult.grouping).toEqual({
        side: "right",
        labels: ["operation", "method", "endpoint"],
      });
    });

    it("should handle time ranges with various units", () => {
      const timeRanges = ["30s", "5m", "2h", "1d", "7d"];

      for (const timeRange of timeRanges) {
        const query = `loki({service="test"})[${timeRange}] and on(id) graylog(service:test)[${timeRange}]`;
        const result = parser.parse(query);

        expect(result.leftStream.timeRange).toBe(timeRange);
        expect(result.rightStream.timeRange).toBe(timeRange);
        expect(parser.validate(query).valid).toBe(true);
      }
    });

    it("should parse post-correlation filters with complex expressions", () => {
      const complexFilters = [
        '{status=~"4..|5..",response_time="high"}',
        '{level="error",component!~"test.*",timestamp="recent"}',
        '{count="high",rate="low",enabled="true"}',
        '{tags=~"urgent|critical",priority="high"}',
      ];

      for (const filter of complexFilters) {
        const query = `loki({service="test"})[5m] and on(id) graylog(service:test)[5m] ${filter}`;
        const result = parser.parse(query);

        expect(result.filter).toBe(filter);
        expect(parser.validate(query).valid).toBe(true);
      }
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("should provide detailed validation errors for invalid syntax", () => {
      const invalidQueries = [
        {
          query: "loki({service==test})[5m] and on(id) other(test)[5m]",
          expectedError: /Expected/,
        },
        {
          query: 'loki({service="test"})[5m] and other(test)[5m]',
          expectedError: /Expected "on"/,
        },
        {
          query: 'loki({service="test"}) and on(id) other(test)[5m]',
          expectedError: /Expected "\["/,
        },
        {
          query: 'loki({service="test"})[5m] and on() other(test)[5m]',
          expectedError: /Expected.*[a-zA-Z_]/,
        },
      ];

      for (const { query, expectedError } of invalidQueries) {
        const result = parser.validate(query);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(expectedError);
      }
    });

    it("should handle malformed selectors gracefully", () => {
      const malformedQueries = [
        'loki({service="test",})[5m] and on(id) other(test)[5m]', // Trailing comma
        'loki({service="test" level="error"})[5m] and on(id) other(test)[5m]', // Missing comma
        "loki({service=})[5m] and on(id) other(test)[5m]", // Empty value
        'loki({="test"})[5m] and on(id) other(test)[5m]', // Empty key
      ];

      for (const query of malformedQueries) {
        const result = parser.validate(query);
        expect(result.valid).toBe(false);
        expect(result.error).toBeTruthy();
      }
    });

    it("should validate temporal constraints", () => {
      const invalidTemporalQueries = [
        'loki({service="test"})[5m] and on(id) within() other(test)[5m]', // Empty temporal
        'loki({service="test"})[5m] and on(id) within(invalid) other(test)[5m]', // Invalid format
        'loki({service="test"})[5m] and on(id) within(-5s) other(test)[5m]', // Negative time
      ];

      for (const query of invalidTemporalQueries) {
        const result = parser.validate(query);
        expect(result.valid).toBe(false);
      }
    });

    it("should handle very long and complex queries", () => {
      // Generate a complex query with many streams
      let complexQuery = 'loki({service="service1"})[5m]';

      for (let i = 2; i <= 10; i++) {
        complexQuery += ` and on(id) within(${i}s) service${i}({query="test"})[5m]`;
      }

      complexQuery += ' {status="success",count="positive"}';

      const result = parser.parse(complexQuery);
      expect(result.leftStream.source).toBe("loki");
      expect(result.additionalStreams).toHaveLength(8);
      expect(result.filter).toBe('{status="success",count="positive"}');
    });
  });

  describe("Real-World Query Patterns", () => {
    it("should parse typical microservices correlation queries", () => {
      const microservicesQuery = `loki({service="api-gateway",level="info"})[15m] and on(trace_id) within(30s) group_left(user_id,endpoint) graylog(service:auth-service AND level:info)[15m] and on(trace_id) within(10s) prometheus(http_request_duration_seconds{service="payment"})[15m] {duration="slow"}`;

      const result = parser.parse(microservicesQuery);

      expect(result.leftStream.source).toBe("loki");
      expect(result.rightStream.source).toBe("graylog");
      expect(result.additionalStreams![0].source).toBe("prometheus");
      expect(result.temporal).toBe("30s");
      expect(result.grouping!.labels).toContain("user_id");
      expect(result.filter).toContain('duration="slow"');
    });

    it("should parse infrastructure monitoring queries", () => {
      const infraQuery = `prometheus(cpu_usage{instance=~"web-.*"})[1h] and on(instance) within(1m) influxdb(SELECT mean(memory_usage) FROM system WHERE time > now() - 1h GROUP BY host)[1h] and on(instance=host) within(30s) loki({job="syslog",level!~"debug|info"})[1h] {cpu_usage="high",memory_usage="critical"}`;

      const result = parser.parse(infraQuery);

      expect(result.leftStream.source).toBe("prometheus");
      expect(result.rightStream.source).toBe("influxdb");
      expect(result.additionalStreams![0].source).toBe("loki");
      // Additional streams have join info attached by the parser
      const additionalStream = result.additionalStreams![0] as any;
      expect(additionalStream.join?.labelMappings![0]).toEqual({
        left: "instance",
        right: "host",
      });
      expect(result.filter).toContain('cpu_usage="high"');
      expect(result.filter).toContain('memory_usage="critical"');
    });

    it("should parse security monitoring queries", () => {
      const securityQuery = `graylog(facility:auth AND message:failed)[24h] and on(source_ip) within(5m) group_left(username,attempt_count) loki({job="security",level="warn"})[24h] unless on(source_ip) within(1m) prometheus(whitelist_ips{status="active"})[24h] {attempt_count="high",source_ip!~"192.168.*"}`;

      const result = parser.parse(securityQuery);

      expect(result.leftStream.source).toBe("graylog");
      expect(result.rightStream.source).toBe("loki");
      expect(result.additionalStreams![0].source).toBe("prometheus");
      expect(result.joinType).toBe("and");
      expect(result.grouping!.side).toBe("left");
      expect(result.filter).toContain('attempt_count="high"');
    });
  });

  describe("Parser Performance and Scalability", () => {
    it("should parse queries efficiently", () => {
      const startTime = Date.now();
      const iterations = 100;

      const query = `loki({service="test",level="error"})[5m] and on(request_id) within(30s) graylog(service:api)[5m]`;

      for (let i = 0; i < iterations; i++) {
        parser.parse(query);
      }

      const duration = Date.now() - startTime;
      const avgTime = duration / iterations;

      // Should parse queries quickly (less than 5ms per query on average)
      expect(avgTime).toBeLessThan(5);
    });

    it("should handle concurrent parsing", async () => {
      const queries = [
        'loki({service="a"})[5m] and on(id) graylog(service:a)[5m]',
        'loki({service="b"})[5m] or on(id) graylog(service:b)[5m]',
        'loki({service="c"})[5m] unless on(id) graylog(service:c)[5m]',
        'loki({service="d"})[5m] and on(id) within(10s) graylog(service:d)[5m]',
        'loki({service="e"})[5m] and on(id) group_left(user) graylog(service:e)[5m]',
      ];

      const promises = queries.map(
        (query) =>
          new Promise((resolve) => {
            const result = parser.parse(query);
            resolve(result);
          })
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);

      // Verify all were parsed correctly
      results.forEach((result: any) => {
        expect(result.leftStream.source).toBe("loki");
        expect(result.rightStream.source).toBe("graylog");
      });
    });
  });

  describe("Autocomplete and Suggestions", () => {
    it("should provide relevant suggestions for incomplete queries", () => {
      const testCases = [
        {
          query: 'loki({service="test"})[5m] ',
          suggestions: ["and on(", "or on(", "unless on("],
        },
        {
          query: 'loki({service="test"})[5m] and on(',
          suggestions: [
            "request_id",
            "trace_id",
            "session_id",
            "correlation_id",
          ],
        },
        {
          query: 'loki({service="test"})[5m] and on(id) ',
          suggestions: ["within(", "group_left(", "group_right(", "ignoring("],
        },
      ];

      for (const { query, suggestions } of testCases) {
        const result = parser.getSuggestions(query, query.length);
        suggestions.forEach((suggestion) => {
          expect(result).toContain(suggestion);
        });
      }
    });

    it("should suggest appropriate data sources", () => {
      const query = "";
      const suggestions = parser.getSuggestions(query, 0);

      expect(suggestions).toContain("loki(");
      expect(suggestions).toContain("graylog(");
      expect(suggestions).toContain("prometheus(");
      expect(suggestions).toContain("influxdb(");
    });
  });
});
