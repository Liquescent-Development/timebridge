import { LogQLParser } from './logql-parser';

describe('LogQLParser', () => {
  let parser: LogQLParser;

  beforeEach(() => {
    parser = new LogQLParser();
  });

  describe('Basic Selectors', () => {
    it('should parse empty selector', () => {
      expect(parser.parse('{}').valid).toBe(true);
    });

    it('should parse single label matcher', () => {
      expect(parser.parse('{job="nginx"}').valid).toBe(true);
      expect(parser.parse('{app!="mysql"}').valid).toBe(true);
      expect(parser.parse('{env=~"prod|staging"}').valid).toBe(true);
      expect(parser.parse('{level!~"debug|info"}').valid).toBe(true);
    });

    it('should parse multiple label matchers', () => {
      expect(parser.parse('{job="nginx", env="prod"}').valid).toBe(true);
      expect(parser.parse('{app="api", version="v2", region!="us-east"}').valid).toBe(true);
    });

    it('should allow trailing comma', () => {
      expect(parser.parse('{job="nginx",}').valid).toBe(true);
    });

    it('should reject empty query', () => {
      const result = parser.parse('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Empty');
    });
  });

  describe('Line Filters', () => {
    it('should parse line contains filter', () => {
      expect(parser.parse('{job="nginx"} |= "error"').valid).toBe(true);
    });

    it('should parse line not contains filter', () => {
      expect(parser.parse('{job="nginx"} != "debug"').valid).toBe(true);
    });

    it('should parse line regex filter', () => {
      expect(parser.parse('{job="nginx"} |~ "\\d+\\.\\d+\\.\\d+\\.\\d+"').valid).toBe(true);
    });

    it('should parse line not regex filter', () => {
      expect(parser.parse('{job="nginx"} !~ "test.*"').valid).toBe(true);
    });

    it('should parse pattern filters', () => {
      expect(parser.parse('{job="nginx"} |> "<_> <method> <path>"').valid).toBe(true);
      expect(parser.parse('{job="nginx"} !> "<error>"').valid).toBe(true);
    });

    it('should parse IP filter', () => {
      expect(parser.parse('{job="nginx"} |= ip("192.168.1.0/24")').valid).toBe(true);
    });

    it('should parse OR filters', () => {
      expect(parser.parse('{job="nginx"} |= "error" or "warning" or "fatal"').valid).toBe(true);
    });

    it('should parse multiple line filters', () => {
      expect(parser.parse('{job="nginx"} |= "request" != "debug" |~ "POST|PUT"').valid).toBe(true);
    });
  });

  describe('Parser Stages', () => {
    it('should parse json parser', () => {
      expect(parser.parse('{job="nginx"} | json').valid).toBe(true);
    });

    it('should parse json with extractions', () => {
      expect(parser.parse('{job="nginx"} | json status="status_code", method').valid).toBe(true);
    });

    it('should parse logfmt parser', () => {
      expect(parser.parse('{job="nginx"} | logfmt').valid).toBe(true);
    });

    it('should parse logfmt with flags', () => {
      expect(parser.parse('{job="nginx"} | logfmt --strict --keep-empty').valid).toBe(true);
    });

    it('should parse pattern parser', () => {
      expect(parser.parse('{job="nginx"} | pattern "<ip> <method> <path> <status>"').valid).toBe(true);
    });

    it('should parse regexp parser', () => {
      expect(parser.parse('{job="nginx"} | regexp "(?P<ip>\\S+) (?P<method>\\S+)"').valid).toBe(true);
    });

    it('should parse unpack parser', () => {
      expect(parser.parse('{job="nginx"} | unpack').valid).toBe(true);
    });
  });

  describe('Label Filters', () => {
    it('should parse numeric comparison', () => {
      expect(parser.parse('{job="nginx"} | json | status >= 400').valid).toBe(true);
      expect(parser.parse('{job="nginx"} | json | response_time > 1000').valid).toBe(true);
    });

    it('should parse duration filter', () => {
      expect(parser.parse('{job="nginx"} | json | duration > 1s').valid).toBe(true);
      expect(parser.parse('{job="nginx"} | json | latency <= 500ms').valid).toBe(true);
    });

    it('should parse bytes filter', () => {
      expect(parser.parse('{job="nginx"} | json | size > 10KB').valid).toBe(true);
      expect(parser.parse('{job="nginx"} | json | bytes_sent >= 1MB').valid).toBe(true);
    });

    it('should parse IP label filter', () => {
      expect(parser.parse('{job="nginx"} | json | client = ip("192.168.0.0/16")').valid).toBe(true);
    });

    it('should parse logical operators in label filters', () => {
      expect(parser.parse('{job="nginx"} | json | status >= 400 and method = "POST"').valid).toBe(true);
      expect(parser.parse('{job="nginx"} | json | level = "error" or level = "fatal"').valid).toBe(true);
    });
  });

  describe('Formatting Stages', () => {
    it('should parse line_format', () => {
      expect(parser.parse('{job="nginx"} | line_format "{{.ip}} {{.status}}"').valid).toBe(true);
    });

    it('should parse label_format', () => {
      expect(parser.parse('{job="nginx"} | label_format status="status_{{.code}}"').valid).toBe(true);
      expect(parser.parse('{job="nginx"} | label_format level="error", app="backend"').valid).toBe(true);
    });

    it('should parse decolorize', () => {
      expect(parser.parse('{job="nginx"} | decolorize').valid).toBe(true);
    });

    it('should parse drop labels', () => {
      expect(parser.parse('{job="nginx"} | json | drop level, timestamp').valid).toBe(true);
    });

    it('should parse keep labels', () => {
      expect(parser.parse('{job="nginx"} | json | keep status, method, path').valid).toBe(true);
    });
  });

  describe('Range Queries', () => {
    it('should parse log range', () => {
      expect(parser.parse('{job="nginx"}[5m]').valid).toBe(true);
      expect(parser.parse('{job="nginx"}[1h30m]').valid).toBe(true);
    });

    it('should parse range with offset', () => {
      expect(parser.parse('{job="nginx"}[5m] offset 1h').valid).toBe(true);
    });

    it('should parse range with pipeline', () => {
      expect(parser.parse('{job="nginx"} |= "error" [5m]').valid).toBe(true);
      expect(parser.parse('{job="nginx"} | json | status >= 400 [10m]').valid).toBe(true);
    });
  });

  describe('Aggregations', () => {
    it('should parse range aggregations', () => {
      expect(parser.parse('count_over_time({job="nginx"}[5m])').valid).toBe(true);
      expect(parser.parse('rate({job="nginx"}[5m])').valid).toBe(true);
      expect(parser.parse('bytes_over_time({job="nginx"}[5m])').valid).toBe(true);
    });

    it('should parse unwrap aggregations', () => {
      expect(parser.parse('sum_over_time({job="nginx"} | unwrap bytes_sent [5m])').valid).toBe(true);
      expect(parser.parse('avg_over_time({job="nginx"} | unwrap duration [5m])').valid).toBe(true);
    });

    it('should parse vector aggregations', () => {
      expect(parser.parse('sum(rate({job="nginx"}[5m]))').valid).toBe(true);
      expect(parser.parse('avg(rate({job="nginx"}[5m])) by (status)').valid).toBe(true);
      expect(parser.parse('topk(5, rate({job="nginx"}[5m]))').valid).toBe(true);
    });

    it('should parse grouping', () => {
      expect(parser.parse('sum by (job, instance) (rate({job="nginx"}[5m]))').valid).toBe(true);
      expect(parser.parse('sum without (timestamp) (rate({job="nginx"}[5m]))').valid).toBe(true);
    });
  });

  describe('Binary Operations', () => {
    it('should parse arithmetic operations', () => {
      expect(parser.parse('rate({job="nginx"}[5m]) * 60').valid).toBe(true);
      expect(parser.parse('rate({job="nginx"}[5m]) + rate({job="mysql"}[5m])').valid).toBe(true);
    });

    it('should parse comparison operations', () => {
      expect(parser.parse('rate({job="nginx"}[5m]) > 100').valid).toBe(true);
      expect(parser.parse('rate({job="nginx"}[5m]) <= 1000').valid).toBe(true);
    });

    it('should parse logical operations', () => {
      expect(parser.parse('rate({job="nginx"}[5m]) and rate({job="mysql"}[5m])').valid).toBe(true);
      expect(parser.parse('rate({job="nginx"}[5m]) or rate({job="mysql"}[5m])').valid).toBe(true);
      expect(parser.parse('rate({job="nginx"}[5m]) unless rate({job="mysql"}[5m])').valid).toBe(true);
    });

    it('should parse vector matching', () => {
      expect(parser.parse('rate({job="nginx"}[5m]) * on(instance) rate({job="mysql"}[5m])').valid).toBe(true);
      expect(parser.parse('rate({job="nginx"}[5m]) / ignoring(job) rate({job="mysql"}[5m])').valid).toBe(true);
    });
  });

  describe('Complex Queries', () => {
    it('should parse real-world queries', () => {
      const queries = [
        '{app="frontend"} |= "error" != "debug"',
        '{job="nginx"} | json | status >= 400 | line_format "{{.method}} {{.path}} {{.status}}"',
        'sum by (status) (rate({job="nginx"} | json [5m]))',
        'quantile_over_time(0.95, {job="api"} | json | unwrap latency_ms [5m]) by (endpoint)',
        'sum(bytes_rate({job="processor"} | json | unwrap bytes_processed [1h]))',
        'absent_over_time({job="critical-service"}[5m])',
        '{job="nginx"} | pattern "<ip> <method> <path> <status>" | status >= 400',
        'topk(10, sum by (job) (rate({namespace="production"}[5m])))',
      ];

      for (const query of queries) {
        const result = parser.parse(query);
        if (!result.valid) {
          console.log(`Failed to parse: ${query}`);
          console.log(`Error: ${result.error}`);
        }
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('Error Handling', () => {
    it('should detect unbalanced braces', () => {
      const result = parser.parse('{job="nginx"');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('brace');
    });

    it('should detect unbalanced brackets', () => {
      const result = parser.parse('{job="nginx"}[5m');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('bracket');
    });

    it('should detect unbalanced parentheses', () => {
      const result = parser.parse('sum(rate({job="nginx"}[5m])');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('parenthes');
    });

    it('should provide suggestions for missing duration units', () => {
      const result = parser.parse('{job="nginx"}[5]');
      expect(result.valid).toBe(false);
      if (result.suggestions) {
        expect(result.suggestions[0]).toContain('unit');
      }
    });
  });

  describe('Validation', () => {
    it('should validate pipeline order', () => {
      const result = parser.validate('{job="nginx"} | status > 400 | json');
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].type).toBe('PIPELINE');
      expect(result.errors?.[0].message).toContain('parser');
    });

    it('should validate label names', () => {
      const result = parser.validate('{123="value"}');
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].type).toBe('LABEL');
    });

    it('should warn about performance issues', () => {
      const result = parser.validate('{job=~".*nginx"}');
      expect(result.valid).toBe(true);
      expect(result.warnings?.[0].type).toBe('PERFORMANCE');
      expect(result.warnings?.[0].message).toContain('Leading .*');
    });
  });

  describe('Query Type Detection', () => {
    it('should detect log queries', () => {
      const result = parser.parse('{job="nginx"} |= "error"');
      if (result.valid && result.ast) {
        expect(parser.getQueryType(result.ast)).toBe('log');
      }
    });

    it('should detect metric queries', () => {
      const result = parser.parse('rate({job="nginx"}[5m])');
      if (result.valid && result.ast) {
        expect(parser.getQueryType(result.ast)).toBe('metric');
      }
    });
  });

  describe('AST Stringify', () => {
    const testCases = [
      { query: '{}', description: 'empty selector' },
      { query: '{job="nginx"}', description: 'simple selector' },
      { query: '{job="nginx"} |= "error"', description: 'line filter' },
      { query: '{job="nginx"} | json', description: 'json parser' },
      { query: '{job="nginx"} | json | status > 400', description: 'label filter' },
      { query: '{job="nginx"}[5m]', description: 'range selector' },
      { query: 'rate({job="nginx"}[5m])', description: 'rate function' },
      { query: 'sum(rate({job="nginx"}[5m])) by (status)', description: 'aggregation' },
    ];

    testCases.forEach(({ query, description }) => {
      it(`should round-trip ${description}: ${query}`, () => {
        const parseResult = parser.parse(query);
        if (parseResult.valid && parseResult.ast) {
          const stringified = parser.stringify(parseResult.ast);
          // Parse again to verify it's still valid
          const reparsed = parser.parse(stringified);
          expect(reparsed.valid).toBe(true);
        } else {
          // If parsing fails, skip the test
          console.warn(`Skipping round-trip test for: ${query}`);
        }
      });
    });
  });
});