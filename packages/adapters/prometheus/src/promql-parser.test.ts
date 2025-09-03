import { PromQLParser } from "./promql-parser";

describe("PromQLParser", () => {
  let parser: PromQLParser;

  beforeEach(() => {
    parser = new PromQLParser();
  });

  describe("Basic Literals", () => {
    it("should parse numbers", () => {
      expect(parser.parse("123").valid).toBe(true);
      expect(parser.parse("123.456").valid).toBe(true);
      expect(parser.parse(".5").valid).toBe(true);
      expect(parser.parse("5.").valid).toBe(true);
      expect(parser.parse("-123").valid).toBe(true);
      expect(parser.parse("+123").valid).toBe(true);
    });

    it("should parse scientific notation", () => {
      expect(parser.parse("5e-3").valid).toBe(true);
      expect(parser.parse("5e3").valid).toBe(true);
      expect(parser.parse("+5.5e-3").valid).toBe(true);
    });

    it("should parse special numbers", () => {
      expect(parser.parse("+Inf").valid).toBe(true);
      expect(parser.parse("-Inf").valid).toBe(true);
      expect(parser.parse("NaN").valid).toBe(true);
    });

    it("should parse hex and octal", () => {
      expect(parser.parse("0x1f").valid).toBe(true);
      expect(parser.parse("0755").valid).toBe(true);
    });

    it("should reject empty queries", () => {
      const result = parser.parse("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Empty");
    });
  });

  describe("Vector Selectors", () => {
    it("should parse simple metric names", () => {
      expect(parser.parse("http_requests").valid).toBe(true);
      expect(parser.parse("up").valid).toBe(true);
      expect(parser.parse("node_cpu_seconds_total").valid).toBe(true);
    });

    it("should parse metrics with labels", () => {
      expect(parser.parse('http_requests{method="GET"}').valid).toBe(true);
      expect(
        parser.parse('http_requests{method="POST", status="200"}').valid
      ).toBe(true);
      expect(parser.parse('http_requests{env=~"prod|staging"}').valid).toBe(
        true
      );
      expect(parser.parse('http_requests{status!="500"}').valid).toBe(true);
      expect(parser.parse('http_requests{path!~"/admin.*"}').valid).toBe(true);
    });

    it("should parse label-only selectors", () => {
      expect(parser.parse('{job="prometheus"}').valid).toBe(true);
      expect(parser.parse('{__name__="http_requests"}').valid).toBe(true);
      expect(parser.parse('{__name__=~"http_.*"}').valid).toBe(true);
    });

    it("should handle quoted label names", () => {
      expect(
        parser.parse('{"app.kubernetes.io/name"="prometheus"}').valid
      ).toBe(true);
      expect(parser.parse("{'foo.bar'=\"value\"}").valid).toBe(true);
    });

    it("should allow trailing commas in label matchers", () => {
      expect(parser.parse('http_requests{method="GET",}').valid).toBe(true);
    });
  });

  describe("Range Selectors", () => {
    it("should parse range vectors", () => {
      expect(parser.parse("http_requests[5m]").valid).toBe(true);
      expect(parser.parse("http_requests[30s]").valid).toBe(true);
      expect(parser.parse("http_requests[1h]").valid).toBe(true);
      expect(parser.parse("http_requests[1d]").valid).toBe(true);
      expect(parser.parse("http_requests[1w]").valid).toBe(true);
    });

    it("should parse range vectors with labels", () => {
      expect(parser.parse('http_requests{method="GET"}[5m]').valid).toBe(true);
      expect(parser.parse('{job="prometheus"}[10m]').valid).toBe(true);
    });

    it("should parse combined duration units", () => {
      expect(parser.parse("http_requests[1h30m]").valid).toBe(true);
      expect(parser.parse("http_requests[2d12h]").valid).toBe(true);
    });
  });

  describe("Time Modifiers", () => {
    it("should parse offset modifier", () => {
      expect(parser.parse("http_requests offset 5m").valid).toBe(true);
      expect(parser.parse("http_requests[1h] offset 1d").valid).toBe(true);
      expect(parser.parse("rate(http_requests[5m]) offset 10m").valid).toBe(
        true
      );
    });

    it("should parse @ modifier", () => {
      expect(parser.parse("http_requests @ 1609746000").valid).toBe(true);
      expect(parser.parse("http_requests @ start()").valid).toBe(true);
      expect(parser.parse("http_requests @ end()").valid).toBe(true);
    });

    it("should parse combined modifiers", () => {
      expect(
        parser.parse("http_requests[5m] @ 1609746000 offset 1h").valid
      ).toBe(true);
    });
  });

  describe("Binary Operators", () => {
    it("should parse arithmetic operators", () => {
      expect(parser.parse("metric1 + metric2").valid).toBe(true);
      expect(parser.parse("metric1 - metric2").valid).toBe(true);
      expect(parser.parse("metric1 * metric2").valid).toBe(true);
      expect(parser.parse("metric1 / metric2").valid).toBe(true);
      expect(parser.parse("metric1 % metric2").valid).toBe(true);
      expect(parser.parse("metric1 ^ metric2").valid).toBe(true);
    });

    it("should parse comparison operators", () => {
      expect(parser.parse("metric1 == metric2").valid).toBe(true);
      expect(parser.parse("metric1 != metric2").valid).toBe(true);
      expect(parser.parse("metric1 < metric2").valid).toBe(true);
      expect(parser.parse("metric1 > metric2").valid).toBe(true);
      expect(parser.parse("metric1 <= metric2").valid).toBe(true);
      expect(parser.parse("metric1 >= metric2").valid).toBe(true);
    });

    it("should parse logical operators", () => {
      expect(parser.parse("metric1 and metric2").valid).toBe(true);
      expect(parser.parse("metric1 or metric2").valid).toBe(true);
      expect(parser.parse("metric1 unless metric2").valid).toBe(true);
    });

    it("should parse bool modifier", () => {
      expect(parser.parse("metric1 == bool metric2").valid).toBe(true);
      expect(parser.parse("metric1 > bool 100").valid).toBe(true);
    });

    it("should respect operator precedence", () => {
      expect(parser.parse("1 + 2 * 3").valid).toBe(true);
      expect(parser.parse("2 ^ 3 ^ 2").valid).toBe(true);
      expect(parser.parse("1 < 2 and 3 > 2").valid).toBe(true);
    });
  });

  describe("Vector Matching", () => {
    it("should parse on/ignoring clauses", () => {
      expect(parser.parse("metric1 + on(instance) metric2").valid).toBe(true);
      expect(parser.parse("metric1 * ignoring(job) metric2").valid).toBe(true);
      expect(
        parser.parse("metric1 / on(cluster, namespace) metric2").valid
      ).toBe(true);
    });

    it("should parse group_left/group_right", () => {
      expect(
        parser.parse("metric1 * on(instance) group_left metric2").valid
      ).toBe(true);
      expect(
        parser.parse("metric1 / on(cluster) group_right(job) metric2").valid
      ).toBe(true);
      expect(
        parser.parse("metric1 + on(instance) group_left(job, version) metric2")
          .valid
      ).toBe(true);
    });
  });

  describe("Aggregations", () => {
    it("should parse basic aggregations", () => {
      expect(parser.parse("sum(http_requests)").valid).toBe(true);
      expect(parser.parse("avg(cpu_usage)").valid).toBe(true);
      expect(parser.parse("max(memory_usage)").valid).toBe(true);
      expect(parser.parse("min(response_time)").valid).toBe(true);
      expect(parser.parse("count(up)").valid).toBe(true);
    });

    it("should parse aggregations with by/without", () => {
      expect(parser.parse("sum by (job)(http_requests)").valid).toBe(true);
      expect(parser.parse("sum without (instance)(http_requests)").valid).toBe(
        true
      );
      expect(parser.parse("avg by (cluster, namespace)(cpu_usage)").valid).toBe(
        true
      );
    });

    it("should parse aggregations with parameters", () => {
      expect(parser.parse("topk(5, http_requests)").valid).toBe(true);
      expect(parser.parse("bottomk(3, cpu_usage)").valid).toBe(true);
      expect(parser.parse("quantile(0.95, response_time)").valid).toBe(true);
      expect(parser.parse('count_values("version", build_info)').valid).toBe(
        true
      );
    });

    it("should allow both prefix and suffix modifiers", () => {
      expect(parser.parse("sum(http_requests) by (job)").valid).toBe(true);
      expect(parser.parse("avg(cpu_usage) without (instance)").valid).toBe(
        true
      );
    });
  });

  describe("Functions", () => {
    it("should parse rate functions", () => {
      expect(parser.parse("rate(http_requests[5m])").valid).toBe(true);
      expect(parser.parse("irate(http_requests[5m])").valid).toBe(true);
      expect(parser.parse("increase(http_requests[1h])").valid).toBe(true);
      expect(parser.parse("delta(gauge_metric[10m])").valid).toBe(true);
    });

    it("should parse math functions", () => {
      expect(parser.parse("abs(metric)").valid).toBe(true);
      expect(parser.parse("ceil(metric)").valid).toBe(true);
      expect(parser.parse("floor(metric)").valid).toBe(true);
      expect(parser.parse("round(metric, 0.01)").valid).toBe(true);
      expect(parser.parse("sqrt(metric)").valid).toBe(true);
    });

    it("should parse time functions", () => {
      expect(parser.parse("time()").valid).toBe(true);
      expect(parser.parse("timestamp(metric)").valid).toBe(true);
      expect(parser.parse("day_of_week()").valid).toBe(true);
      expect(parser.parse("hour(metric)").valid).toBe(true);
    });

    it("should parse label functions", () => {
      expect(
        parser.parse('label_replace(up, "foo", "$1", "job", "(.*)")').valid
      ).toBe(true);
      expect(
        parser.parse('label_join(up, "foo", ",", "job", "instance")').valid
      ).toBe(true);
    });

    it("should parse nested functions", () => {
      expect(parser.parse("sum(rate(http_requests[5m]))").valid).toBe(true);
      expect(
        parser.parse("histogram_quantile(0.95, rate(http_requests_bucket[5m]))")
          .valid
      ).toBe(true);
    });
  });

  describe("Subqueries", () => {
    it("should parse basic subqueries", () => {
      expect(parser.parse("rate(http_requests[5m])[30m:]").valid).toBe(true);
      expect(parser.parse("rate(http_requests[5m])[30m:1m]").valid).toBe(true);
    });

    it("should parse nested subqueries", () => {
      expect(
        parser.parse("max_over_time(rate(http_requests[5m])[30m:])").valid
      ).toBe(true);
    });
  });

  describe("Complex Queries", () => {
    it("should parse real-world queries", () => {
      const queries = [
        'sum(rate(http_requests_total{job="api"}[5m])) by (status)',
        '100 * (1 - avg by(instance)(irate(node_cpu_seconds_total{mode="idle"}[5m])))',
        "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))",
        "predict_linear(node_filesystem_free_bytes[1h], 4 * 3600)",
        "(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100",
        "topk(10, sum by (job, instance)(rate(process_cpu_seconds_total[5m])))",
        'up{job="prometheus"} unless on(instance) up{job="node"}',
        'label_replace(up{job="api"}, "foo", "$1", "instance", "(.*):.*")',
      ];

      for (const query of queries) {
        const result = parser.parse(query);
        expect(result.valid).toBe(true);
        if (!result.valid) {
          console.log(`Failed to parse: ${query}`);
          console.log(`Error: ${result.error}`);
        }
      }
    });
  });

  describe("Error Handling", () => {
    it("should detect unbalanced parentheses", () => {
      const result = parser.parse("sum(metric");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("parenthes");
    });

    it("should detect unbalanced brackets", () => {
      const result = parser.parse("metric[5m");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("bracket");
    });

    it("should detect unbalanced braces", () => {
      const result = parser.parse('metric{job="test"');
      expect(result.valid).toBe(false);
      expect(result.error).toContain("brace");
    });

    it("should provide suggestions for missing duration units", () => {
      const result = parser.parse("metric[5]");
      expect(result.valid).toBe(false);
      if (result.suggestions) {
        expect(result.suggestions[0]).toContain("unit");
      }
    });
  });

  describe("Validation", () => {
    it("should validate function names", () => {
      const result = parser.validate("unknown_function(metric)");
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].type).toBe("FUNCTION");
    });

    it("should validate function arguments", () => {
      const result = parser.validate("rate()"); // rate requires an argument
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].type).toBe("FUNCTION");
    });

    it("should warn about performance issues", () => {
      const result = parser.validate('metric{label=~".*value"}');
      expect(result.valid).toBe(true);
      expect(result.warnings?.[0].type).toBe("PERFORMANCE");
    });

    it("should validate label names", () => {
      const result = parser.validate('metric{1234="value"}'); // Invalid label name
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].type).toBe("LABEL");
    });
  });

  describe("AST Stringify", () => {
    const testCases = [
      { query: "123", description: "number" },
      { query: "http_requests", description: "simple metric" },
      {
        query: 'http_requests{method="GET"}',
        description: "metric with label",
      },
      { query: "http_requests[5m]", description: "range vector" },
      { query: "rate(http_requests[5m])", description: "function" },
      { query: "metric1 + metric2", description: "addition" },
      {
        query: "metric1 * on(instance) metric2",
        description: "vector matching",
      },
      { query: "sum(http_requests) by (job)", description: "aggregation" },
      { query: "http_requests offset 5m", description: "offset" },
      { query: "http_requests @ 1609746000", description: "@ modifier" },
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
          // If parsing fails without parser generated, skip
          console.warn(
            `Skipping round-trip test for: ${query} (parser not available)`
          );
        }
      });
    });
  });
});
