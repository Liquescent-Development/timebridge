import { InfluxQLParser } from "./influxql-parser";

describe("InfluxQLParser", () => {
  let parser: InfluxQLParser;

  beforeEach(() => {
    parser = new InfluxQLParser();
  });

  describe("Phase 1: Core Validation", () => {
    describe("Basic Query Structure", () => {
      it("should validate simple SELECT queries", () => {
        const queries = [
          "SELECT value FROM cpu",
          "SELECT * FROM temperature",
          "SELECT field1, field2 FROM measurement",
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should reject invalid query structures", () => {
        const invalidQueries = [
          "",
          "INVALID QUERY",
          "SELECT",
          "SELECT FROM",
          "FROM measurement",
          "SELECT value",
        ];

        invalidQueries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(false);
        });
      });

      it("should validate SHOW statements", () => {
        const queries = [
          "SHOW DATABASES",
          "SHOW MEASUREMENTS",
          "SHOW TAG KEYS",
          "SHOW FIELD KEYS",
          "SHOW SERIES",
          "SHOW RETENTION POLICIES",
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("Identifier Validation", () => {
      it("should validate unquoted identifiers", () => {
        expect(parser.validateIdentifier("field_name")).toBe(true);
        expect(parser.validateIdentifier("measurement123")).toBe(true);
        expect(parser.validateIdentifier("_private")).toBe(true);
      });

      it("should validate quoted identifiers", () => {
        expect(parser.validateIdentifier('"field-name"')).toBe(true);
        expect(parser.validateIdentifier('"measurement.with.dots"')).toBe(true);
        expect(parser.validateIdentifier('"field with spaces"')).toBe(true);
      });

      it("should reject invalid identifiers", () => {
        expect(parser.validateIdentifier("123field")).toBe(false); // Can't start with number
        expect(parser.validateIdentifier("field-name")).toBe(false); // Hyphen not allowed unquoted
        expect(parser.validateIdentifier('"unclosed quote')).toBe(false);
        expect(parser.validateIdentifier('unmatched"quote')).toBe(false);
      });

      it("should handle escaped quotes in identifiers", () => {
        expect(parser.validateIdentifier('"field\\"name"')).toBe(true);
        expect(parser.validateIdentifier('"measurement\\"with\\"quotes"')).toBe(true);
      });
    });

    describe("Duration Validation", () => {
      it("should validate all duration units", () => {
        const durations = [
          "1u",   // microseconds
          "1µ",   // microseconds (unicode)
          "100ms", // milliseconds
          "30s",   // seconds
          "5m",    // minutes
          "2h",    // hours
          "7d",    // days
          "4w",    // weeks
        ];

        durations.forEach(duration => {
          expect(parser.validateDuration(duration)).toBe(true);
        });
      });

      it("should validate compound durations", () => {
        expect(parser.validateDuration("90m")).toBe(true);
        expect(parser.validateDuration("1000ms")).toBe(true);
        expect(parser.validateDuration("168h")).toBe(true); // 1 week in hours
      });

      it("should reject invalid durations", () => {
        expect(parser.validateDuration("1")).toBe(false); // No unit
        expect(parser.validateDuration("m")).toBe(false); // No number
        expect(parser.validateDuration("1x")).toBe(false); // Invalid unit
        expect(parser.validateDuration("1.5h")).toBe(false); // No decimals
        expect(parser.validateDuration("-5m")).toBe(false); // No negative
        expect(parser.validateDuration("5 m")).toBe(false); // No space
      });
    });

    describe("String and Regex Literals", () => {
      it("should parse queries with string literals", () => {
        const query = "SELECT * FROM cpu WHERE host = 'server01'";
        const result = parser.parse(query);
        expect(result.valid).toBe(true);
      });

      it("should parse queries with regex literals", () => {
        const query = "SELECT * FROM /^cpu.*/";
        const result = parser.parse(query);
        expect(result.valid).toBe(true);
      });

      it("should handle escaped characters in strings", () => {
        const query = "SELECT * FROM cpu WHERE message = 'It\\'s working'";
        const result = parser.parse(query);
        expect(result.valid).toBe(true);
      });
    });

    describe("Query Parsing", () => {
      it("should parse SELECT query into AST", () => {
        const query = "SELECT value FROM cpu WHERE host = 'server01'";
        const result = parser.parse(query);
        
        expect(result.valid).toBe(true);
        if (result.ast) {
          expect(result.ast.type).toBe("SELECT");
        }
      });

      it("should extract fields from SELECT query", () => {
        const fields = parser.getSelectedFields("SELECT field1, field2, field3 FROM measurement");
        expect(fields).toEqual(["field1", "field2", "field3"]);
      });

      it("should extract measurements from query", () => {
        const measurements = parser.getMeasurements("SELECT * FROM cpu, memory, disk");
        expect(measurements).toContain("cpu");
        expect(measurements).toContain("memory");
        expect(measurements).toContain("disk");
      });

      it("should detect time constraints in queries", () => {
        expect(parser.hasTimeConstraint("SELECT * FROM cpu WHERE time > now() - 1h")).toBe(true);
        expect(parser.hasTimeConstraint("SELECT * FROM cpu WHERE time > '2021-01-01'")).toBe(true);
        expect(parser.hasTimeConstraint("SELECT * FROM cpu")).toBe(false);
      });
    });

    describe("Error Handling", () => {
      it("should provide helpful error messages", () => {
        const result = parser.parse("SELECT FROM cpu");
        expect(result.valid).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.suggestions).toBeDefined();
      });

      it("should detect unclosed parentheses", () => {
        const result = parser.parse("SELECT COUNT(value FROM cpu");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("parenthes");
      });

      it("should detect unclosed quotes", () => {
        const result = parser.parse("SELECT * FROM cpu WHERE host = 'server");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("quote");
      });
    });

    describe("Performance Warnings", () => {
      it("should warn about SELECT * queries", () => {
        const result = parser.validateDetailed("SELECT * FROM cpu");
        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings?.some(w => w.type === 'PERFORMANCE')).toBe(true);
      });

      it("should warn about missing time constraints", () => {
        const result = parser.validateDetailed("SELECT value FROM cpu");
        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings?.some(w => w.message.includes('time constraint'))).toBe(true);
      });

      it("should warn about missing LIMIT", () => {
        const result = parser.validateDetailed("SELECT value FROM cpu WHERE time > now() - 1h");
        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings?.some(w => w.message.includes('LIMIT'))).toBe(true);
      });
    });

    describe("Query Enhancement", () => {
      it("should add time constraint to queries", () => {
        const original = "SELECT value FROM cpu";
        const enhanced = parser.addTimeConstraint(original, "1h");
        
        expect(enhanced).toContain("time");
        expect(enhanced).toContain("now()");
        expect(enhanced).toContain("1h");
      });

      it("should not duplicate existing time constraints", () => {
        const original = "SELECT value FROM cpu WHERE time > now() - 1h";
        console.log("Test - hasTimeConstraint:", parser.hasTimeConstraint(original));
        const enhanced = parser.addTimeConstraint(original, "2h");
        console.log("Test - Original:", original);
        console.log("Test - Enhanced:", enhanced);
        
        expect(enhanced).toBe(original);
      });

      it("should handle queries with existing WHERE clause", () => {
        const original = "SELECT value FROM cpu WHERE host = 'server01'";
        const enhanced = parser.addTimeConstraint(original, "30m");
        
        expect(enhanced).toContain("host = 'server01'");
        expect(enhanced).toContain("time");
        expect(enhanced).toContain("AND");
      });
    });
  });

  describe("InfluxQL Specification Compliance", () => {
    it("should validate queries from the spec examples", () => {
      const specQueries = [
        // From the spec documentation
        "SELECT mean(\"value\") FROM \"cpu\" WHERE \"region\" = 'uswest' GROUP BY time(10m) fill(0)",
        "SELECT mean(\"value\") INTO \"cpu_1h\".:MEASUREMENT FROM /cpu.*/",
        "SELECT mean(\"value\") FROM \"cpu\" GROUP BY region, time(1d) fill(0) tz(\"America/Chicago\")",
      ];

      specQueries.forEach(query => {
        const result = parser.validate(query);
        if (!result.valid) {
          console.log(`Failed query: ${query}`, result.errors);
        }
        expect(result.valid).toBe(true);
      });
    });

    it("should handle all comparison operators", () => {
      const operators = ["=", "!=", "<", ">", "<=", ">=", "=~", "!~"];
      
      operators.forEach(op => {
        const query = op.includes("~") 
          ? `SELECT * FROM cpu WHERE host ${op} /server.*/`
          : `SELECT * FROM cpu WHERE value ${op} 100`;
        
        const result = parser.validate(query);
        expect(result.valid).toBe(true);
      });
    });

    it("should validate retention policy references", () => {
      const query = 'SELECT * FROM "1h.policy"."measurement"';
      const result = parser.validate(query);
      expect(result.valid).toBe(true);
    });
  });

  describe("Phase 2: Advanced Query Features", () => {
    describe("Aggregate Functions", () => {
      it("should validate all InfluxQL aggregate functions", () => {
        const functions = [
          "COUNT", "DISTINCT", "INTEGRAL", "MEAN", "MEDIAN",
          "MODE", "SPREAD", "STDDEV", "SUM", "BOTTOM",
          "FIRST", "LAST", "MAX", "MIN", "PERCENTILE",
          "SAMPLE", "TOP"
        ];

        functions.forEach(func => {
          const query = `SELECT ${func}(value) FROM cpu`;
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate aggregate functions with parameters", () => {
        const queries = [
          "SELECT PERCENTILE(value, 95) FROM cpu",
          "SELECT TOP(value, 10) FROM cpu",
          "SELECT BOTTOM(field, 5) FROM measurement",
          "SELECT SAMPLE(value, 3) FROM cpu",
          "SELECT MOVING_AVERAGE(value, 10) FROM cpu"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          if (!result.valid) {
            console.log(`Failed: ${query}`, result.errors);
          }
          expect(result.valid).toBe(true);
        });
      });

      it("should detect usage of aggregate functions", () => {
        const query = "SELECT MEAN(value), MAX(value), MIN(value) FROM cpu";
        expect(parser.hasAggregateFunction(query)).toBe(true);
      });

      it("should extract aggregate functions from query", () => {
        const query = "SELECT MEAN(value), MAX(value), COUNT(*) FROM cpu";
        const functions = parser.getAggregateFunctions(query);
        expect(functions).toContain("MEAN");
        expect(functions).toContain("MAX");
        expect(functions).toContain("COUNT");
      });

      it("should validate nested function calls", () => {
        const queries = [
          "SELECT MEAN(ABS(value)) FROM cpu",
          "SELECT SUM(ROUND(value)) FROM measurement",
          "SELECT MAX(FLOOR(temperature)) FROM sensors"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("WHERE Clause Advanced Features", () => {
      it("should validate complex WHERE conditions", () => {
        const queries = [
          "SELECT * FROM cpu WHERE host = 'server01' AND time > now() - 1h",
          "SELECT * FROM cpu WHERE (value > 100 OR value < 10) AND region = 'us-west'",
          "SELECT * FROM cpu WHERE host =~ /^server/ AND cpu = 'cpu-total'",
          "SELECT * FROM cpu WHERE time >= '2021-01-01T00:00:00Z' AND time <= '2021-12-31T23:59:59Z'"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate IN and NOT IN operators", () => {
        const queries = [
          "SELECT * FROM cpu WHERE host IN ('server01', 'server02', 'server03')",
          "SELECT * FROM cpu WHERE region NOT IN ('us-west', 'us-east')",
          "SELECT * FROM cpu WHERE value IN (10, 20, 30, 40)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should extract WHERE clause conditions", () => {
        const query = "SELECT * FROM cpu WHERE host = 'server01' AND value > 100";
        const conditions = parser.getWhereConditions(query);
        expect(conditions).toBeDefined();
        expect(conditions.length).toBeGreaterThan(0);
      });

      it("should validate regex operators in WHERE", () => {
        const queries = [
          "SELECT * FROM cpu WHERE host =~ /server.*/",
          "SELECT * FROM cpu WHERE host !~ /^test/",
          "SELECT * FROM measurement WHERE tag =~ /pattern/"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("GROUP BY Clause", () => {
      it("should validate GROUP BY with tags", () => {
        const queries = [
          "SELECT MEAN(value) FROM cpu GROUP BY host",
          "SELECT SUM(value) FROM cpu GROUP BY region, host",
          "SELECT COUNT(*) FROM measurement GROUP BY tag1, tag2, tag3"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate GROUP BY time intervals", () => {
        const queries = [
          "SELECT MEAN(value) FROM cpu GROUP BY time(10s)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(5m)",
          "SELECT SUM(value) FROM cpu GROUP BY time(1h)",
          "SELECT COUNT(*) FROM cpu GROUP BY time(1d)",
          "SELECT MAX(value) FROM cpu GROUP BY time(1w)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate GROUP BY with fill options", () => {
        const queries = [
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(0)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(null)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(previous)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(linear)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(100)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate GROUP BY with timezone", () => {
        const queries = [
          'SELECT MEAN(value) FROM cpu GROUP BY time(1d) tz("America/New_York")',
          'SELECT SUM(value) FROM cpu GROUP BY time(1h) tz("Europe/London")',
          'SELECT COUNT(*) FROM cpu GROUP BY time(1d) tz("Asia/Tokyo")'
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should extract GROUP BY fields", () => {
        const query = "SELECT MEAN(value) FROM cpu GROUP BY host, region, time(10m)";
        const groups = parser.getGroupByFields(query);
        expect(groups).toContain("host");
        expect(groups).toContain("region");
        expect(groups.some((g: string) => g.includes("time"))).toBe(true);
      });
    });

    describe("ORDER BY, LIMIT, OFFSET", () => {
      it("should validate ORDER BY clauses", () => {
        const queries = [
          "SELECT * FROM cpu ORDER BY time DESC",
          "SELECT * FROM cpu ORDER BY time ASC",
          "SELECT * FROM cpu ORDER BY value DESC",
          "SELECT mean FROM cpu ORDER BY mean DESC"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate LIMIT clauses", () => {
        const queries = [
          "SELECT * FROM cpu LIMIT 10",
          "SELECT * FROM cpu WHERE host = 'server01' LIMIT 100",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) LIMIT 1000"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate OFFSET clauses", () => {
        const queries = [
          "SELECT * FROM cpu LIMIT 10 OFFSET 20",
          "SELECT * FROM cpu OFFSET 100",
          "SELECT * FROM cpu LIMIT 50 OFFSET 10"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate SLIMIT and SOFFSET", () => {
        const queries = [
          "SELECT * FROM cpu GROUP BY * SLIMIT 5",
          "SELECT * FROM cpu GROUP BY * SLIMIT 10 SOFFSET 5",
          "SELECT MEAN(value) FROM cpu GROUP BY host SLIMIT 3"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should extract limit and offset values", () => {
        const result = parser.parse("SELECT * FROM cpu LIMIT 10 OFFSET 20");
        expect(result.valid).toBe(true);
        if (result.ast) {
          expect(parser.getLimit(result.ast)).toBe(10);
          expect(parser.getOffset(result.ast)).toBe(20);
        }
      });
    });

    describe("Math Operations", () => {
      it("should validate arithmetic operations in SELECT", () => {
        const queries = [
          "SELECT value + 10 FROM cpu",
          "SELECT value - baseline FROM cpu",
          "SELECT value * 2 FROM cpu",
          "SELECT value / 100 FROM cpu",
          "SELECT value % 10 FROM cpu",
          "SELECT (value + 10) * 2 FROM cpu",
          "SELECT value1 + value2 AS total FROM measurement"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate math functions", () => {
        const queries = [
          "SELECT ABS(value) FROM cpu",
          "SELECT ACOS(value) FROM cpu",
          "SELECT ASIN(value) FROM cpu",
          "SELECT ATAN(value) FROM cpu",
          "SELECT ATAN2(y, x) FROM cpu",
          "SELECT CEIL(value) FROM cpu",
          "SELECT COS(value) FROM cpu",
          "SELECT EXP(value) FROM cpu",
          "SELECT FLOOR(value) FROM cpu",
          "SELECT LN(value) FROM cpu",
          "SELECT LOG(value, 10) FROM cpu",
          "SELECT LOG2(value) FROM cpu",
          "SELECT LOG10(value) FROM cpu",
          "SELECT POW(value, 2) FROM cpu",
          "SELECT ROUND(value) FROM cpu",
          "SELECT SIN(value) FROM cpu",
          "SELECT SQRT(value) FROM cpu",
          "SELECT TAN(value) FROM cpu"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate complex math expressions", () => {
        const queries = [
          "SELECT SQRT(POW(x, 2) + POW(y, 2)) AS distance FROM vectors",
          "SELECT LOG(value) / LOG(10) AS log10_value FROM measurement",
          "SELECT (MAX(value) - MIN(value)) / 2 AS midpoint FROM cpu GROUP BY time(1h)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("Regex Pattern Support", () => {
      it("should validate regex in measurement names", () => {
        const queries = [
          "SELECT * FROM /^cpu.*/",
          "SELECT * FROM /.*_temp$/",
          "SELECT value FROM /^sensor_[0-9]+$/"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate regex in WHERE clauses", () => {
        const queries = [
          "SELECT * FROM cpu WHERE host =~ /^server[0-9]+$/",
          "SELECT * FROM cpu WHERE region !~ /^test.*/",
          "SELECT * FROM measurement WHERE tag =~ /pattern.*/"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should detect regex patterns in queries", () => {
        expect(parser.hasRegexPattern("SELECT * FROM /^cpu.*/ WHERE host =~ /server/")).toBe(true);
        expect(parser.hasRegexPattern("SELECT * FROM cpu WHERE host = 'server01'")).toBe(false);
      });
    });
  });

  describe("Phase 3: Statement Types & Features", () => {
    describe("SHOW Statements", () => {
      it("should validate SHOW DATABASES", () => {
        const result = parser.validate("SHOW DATABASES");
        expect(result.valid).toBe(true);
      });

      it("should validate SHOW MEASUREMENTS with conditions", () => {
        const queries = [
          "SHOW MEASUREMENTS",
          "SHOW MEASUREMENTS WHERE region = 'us-west'",
          "SHOW MEASUREMENTS ON mydb",
          "SHOW MEASUREMENTS WITH MEASUREMENT =~ /cpu.*/",
          "SHOW MEASUREMENTS WHERE time > now() - 7d"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate SHOW TAG/FIELD KEYS", () => {
        const queries = [
          "SHOW TAG KEYS",
          "SHOW TAG KEYS FROM cpu",
          "SHOW TAG KEYS FROM /.*_sensor/",
          "SHOW TAG KEYS ON mydb",
          "SHOW FIELD KEYS",
          "SHOW FIELD KEYS FROM temperature"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate SHOW SERIES", () => {
        const queries = [
          "SHOW SERIES",
          "SHOW SERIES FROM cpu",
          "SHOW SERIES WHERE host = 'server01'",
          "SHOW SERIES FROM cpu WHERE region = 'us-west' LIMIT 10"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate SHOW RETENTION POLICIES", () => {
        const queries = [
          "SHOW RETENTION POLICIES",
          "SHOW RETENTION POLICIES ON mydb"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should detect statement type", () => {
        expect(parser.getStatementType("SHOW DATABASES")).toBe("SHOW");
        expect(parser.getStatementType("SELECT * FROM cpu")).toBe("SELECT");
      });
    });

    describe("CREATE Statements", () => {
      it("should validate CREATE DATABASE", () => {
        const queries = [
          "CREATE DATABASE mydb",
          "CREATE DATABASE mydb WITH DURATION 30d",
          "CREATE DATABASE mydb WITH DURATION 30d REPLICATION 3",
          "CREATE DATABASE mydb WITH DURATION 30d REPLICATION 3 NAME myrp"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate CREATE RETENTION POLICY", () => {
        const queries = [
          "CREATE RETENTION POLICY myrp ON mydb DURATION 30d REPLICATION 1",
          "CREATE RETENTION POLICY myrp ON mydb DURATION 30d REPLICATION 1 DEFAULT",
          "CREATE RETENTION POLICY myrp ON mydb DURATION INF REPLICATION 1",
          "CREATE RETENTION POLICY myrp ON mydb DURATION 52w REPLICATION 3 SHARD DURATION 1w"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate CREATE CONTINUOUS QUERY", () => {
        const queries = [
          "CREATE CONTINUOUS QUERY cq_mean ON mydb BEGIN SELECT MEAN(value) INTO average FROM cpu GROUP BY time(10m) END",
          "CREATE CONTINUOUS QUERY cq_sum ON mydb RESAMPLE EVERY 10m FOR 2h BEGIN SELECT SUM(value) INTO total FROM cpu GROUP BY time(5m) END"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should extract CQ details", () => {
        const query = "CREATE CONTINUOUS QUERY cq_mean ON mydb BEGIN SELECT MEAN(value) INTO average FROM cpu GROUP BY time(10m) END";
        const details = parser.getContinuousQueryDetails(query);
        expect(details).toBeDefined();
        expect(details?.name).toBe("cq_mean");
        expect(details?.database).toBe("mydb");
      });
    });

    describe("ALTER Statements", () => {
      it("should validate ALTER RETENTION POLICY", () => {
        const queries = [
          "ALTER RETENTION POLICY myrp ON mydb DURATION 60d",
          "ALTER RETENTION POLICY myrp ON mydb REPLICATION 2",
          "ALTER RETENTION POLICY myrp ON mydb DEFAULT",
          "ALTER RETENTION POLICY myrp ON mydb DURATION 90d REPLICATION 3 DEFAULT"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("DROP Statements", () => {
      it("should validate DROP statements", () => {
        const queries = [
          "DROP DATABASE mydb",
          "DROP RETENTION POLICY myrp ON mydb",
          "DROP CONTINUOUS QUERY cq_mean ON mydb",
          "DROP MEASUREMENT cpu",
          "DROP SERIES FROM cpu WHERE host = 'server01'"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("DELETE Statements", () => {
      it("should validate DELETE statements", () => {
        const queries = [
          "DELETE FROM cpu",
          "DELETE FROM cpu WHERE time < '2021-01-01'",
          "DELETE FROM cpu WHERE host = 'server01' AND time < now() - 30d"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("Subqueries", () => {
      it("should validate subqueries in FROM clause", () => {
        const queries = [
          "SELECT MEAN(mean) FROM (SELECT MEAN(value) FROM cpu GROUP BY time(10m))",
          "SELECT MAX(total) FROM (SELECT SUM(value) AS total FROM cpu GROUP BY host)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should detect subqueries", () => {
        const query = "SELECT MEAN(mean) FROM (SELECT MEAN(value) FROM cpu GROUP BY time(10m))";
        expect(parser.hasSubquery(query)).toBe(true);
      });
    });

    describe("Time Literals", () => {
      it("should validate RFC3339 time literals", () => {
        const queries = [
          "SELECT * FROM cpu WHERE time >= '2021-01-01T00:00:00Z'",
          "SELECT * FROM cpu WHERE time >= '2021-01-01T00:00:00.000Z'",
          "SELECT * FROM cpu WHERE time >= '2021-01-01T00:00:00-07:00'",
          "SELECT * FROM cpu WHERE time BETWEEN '2021-01-01T00:00:00Z' AND '2021-12-31T23:59:59Z'"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate relative time expressions", () => {
        const queries = [
          "SELECT * FROM cpu WHERE time > now() - 1h",
          "SELECT * FROM cpu WHERE time > now() - 7d",
          "SELECT * FROM cpu WHERE time > now() - 4w",
          "SELECT * FROM cpu WHERE time >= now() - 30m AND time <= now()"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate timestamp literals", () => {
        const queries = [
          "SELECT * FROM cpu WHERE time > 1609459200000000000",  // nanoseconds
          "SELECT * FROM cpu WHERE time > 1609459200s",          // seconds
          "SELECT * FROM cpu WHERE time > 1609459200000ms"       // milliseconds
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("INTO Clause Features", () => {
      it("should validate INTO clause for downsampling", () => {
        const queries = [
          "SELECT MEAN(value) INTO cpu_1h FROM cpu GROUP BY time(1h)",
          "SELECT MEAN(value) INTO mydb.autogen.cpu_1h FROM cpu GROUP BY time(1h)",
          "SELECT MEAN(value) INTO mydb.\"1year\".cpu_1h FROM cpu GROUP BY time(1h)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should validate INTO clause with backreferences", () => {
        const queries = [
          "SELECT MEAN(value) INTO \"average_$1\" FROM /cpu_(.*)/ GROUP BY time(1h)",
          "SELECT * INTO \"copy_$1\" FROM /^(.*)$/",
          "SELECT MEAN(*) INTO \"$1.downsampled\" FROM /.*/ GROUP BY time(1h)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should extract INTO target", () => {
        const query = "SELECT MEAN(value) INTO cpu_1h FROM cpu GROUP BY time(1h)";
        const result = parser.parse(query);
        expect(result.valid).toBe(true);
        expect(parser.getIntoTarget(result.ast!)).toBe("cpu_1h");
      });
    });

    describe("Advanced GROUP BY Features", () => {
      it("should validate fill() with all options", () => {
        const queries = [
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(null)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(none)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(previous)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(linear)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(0)",
          "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(100.5)"
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });

      it("should extract fill option", () => {
        const query = "SELECT MEAN(value) FROM cpu GROUP BY time(10m) fill(linear)";
        const result = parser.parse(query);
        expect(result.valid).toBe(true);
        expect(parser.getFillOption(result.ast!)).toBe("linear");
      });

      it("should validate timezone in GROUP BY", () => {
        const queries = [
          'SELECT MEAN(value) FROM cpu GROUP BY time(1d) tz("America/New_York")',
          'SELECT MEAN(value) FROM cpu GROUP BY time(1d) tz("Europe/London")',
          'SELECT MEAN(value) FROM cpu GROUP BY time(1d) tz("UTC")',
          'SELECT MEAN(value) FROM cpu GROUP BY time(1d) tz("Asia/Tokyo")'
        ];

        queries.forEach(query => {
          const result = parser.validate(query);
          expect(result.valid).toBe(true);
        });
      });
    });

    describe("Statement Type Detection", () => {
      it("should correctly identify all statement types", () => {
        const cases = [
          { query: "SELECT * FROM cpu", type: "SELECT" },
          { query: "SHOW DATABASES", type: "SHOW" },
          { query: "CREATE DATABASE mydb", type: "CREATE" },
          { query: "ALTER RETENTION POLICY myrp ON mydb", type: "ALTER" },
          { query: "DROP DATABASE mydb", type: "DROP" },
          { query: "DELETE FROM cpu", type: "DELETE" },
          { query: "CREATE CONTINUOUS QUERY cq ON mydb BEGIN SELECT * FROM cpu END", type: "CREATE" }
        ];

        cases.forEach(({ query, type }) => {
          expect(parser.getStatementType(query)).toBe(type);
        });
      });
    });
  });

  describe("Phase 4: Production Readiness", () => {
    describe("Error Recovery and Suggestions", () => {
      it("should provide helpful suggestions for typos", () => {
        const queries = [
          { query: "SELCT * FROM cpu", suggestion: "SELECT" },
          { query: "SELECT * FORM cpu", suggestion: "FROM" },
          { query: "SELECT * FROM cpu WEHRE host = 'server'", suggestion: "WHERE" },
          { query: "SELECT * FROM cpu GROUP BY tim(10m)", suggestion: "time" }
        ];

        queries.forEach(({ query, suggestion }) => {
          const result = parser.validateWithSchema(query);
          expect(result.valid).toBe(false);
          expect(result.suggestions).toBeDefined();
          expect(result.suggestions?.some((s: string) => s.includes(suggestion))).toBe(true);
        });
      });

      it("should suggest missing keywords", () => {
        const queries = [
          { query: "SELECT * cpu", suggestion: "FROM" },
          { query: "SELECT FROM cpu", suggestion: "field" },
          { query: "CREATE DATABASE", suggestion: "name" },
          { query: "DROP RETENTION POLICY myrp", suggestion: "ON" }
        ];

        queries.forEach(({ query, suggestion }) => {
          const result = parser.validateWithSchema(query);
          expect(result.valid).toBe(false);
          expect(result.suggestions).toBeDefined();
        });
      });

      it("should recover from common syntax errors", () => {
        const queries = [
          { 
            query: "SELECT * FROM cpu WHERE host = server01", 
            fixed: "SELECT * FROM cpu WHERE host = 'server01'",
            issue: "unquoted string"
          },
          {
            query: "SELECT * FROM cpu WHERE time > now() - 1",
            fixed: "SELECT * FROM cpu WHERE time > now() - 1h",
            issue: "missing duration unit"
          }
        ];

        queries.forEach(({ query, fixed, issue }) => {
          const result = parser.tryAutoFix(query);
          expect(result.fixed).toBeDefined();
          expect(result.issue).toContain(issue);
        });
      });

      it("should detect unclosed quotes and parentheses", () => {
        const queries = [
          "SELECT * FROM cpu WHERE host = 'server",
          "SELECT COUNT(value FROM cpu",
          "SELECT * FROM cpu WHERE (value > 100"
        ];

        queries.forEach(query => {
          const result = parser.validateDetailed(query);
          expect(result.valid).toBe(false);
          expect(result.errors).toBeDefined();
          expect(result.errors?.[0]?.message.toLowerCase()).toMatch(/unclosed|missing/);
        });
      });
    });

    describe("Schema-Aware Validation", () => {
      const schema = {
        measurements: ["cpu", "memory", "disk", "network"],
        tagKeys: {
          cpu: ["host", "region", "datacenter"],
          memory: ["host", "region"],
          disk: ["host", "device"],
          network: ["host", "interface"]
        },
        fieldKeys: {
          cpu: ["usage_user", "usage_system", "usage_idle"],
          memory: ["used", "free", "total"],
          disk: ["read_bytes", "write_bytes"],
          network: ["bytes_sent", "bytes_recv"]
        },
        retentionPolicies: ["autogen", "one_week", "one_month"]
      };

      beforeEach(() => {
        parser.setSchema(schema);
      });

      afterEach(() => {
        parser.clearSchema();
      });

      it("should validate measurement names against schema", () => {
        const validQuery = "SELECT * FROM cpu";
        const invalidQuery = "SELECT * FROM invalid_measurement";

        expect(parser.validateWithSchema(validQuery).valid).toBe(true);
        
        const result = parser.validateWithSchema(invalidQuery);
        expect(result.valid).toBe(false);
        expect(result.schemaErrors).toBeDefined();
        expect(result.schemaErrors?.[0].type).toBe("UNKNOWN_MEASUREMENT");
      });

      it("should validate field names against schema", () => {
        const validQuery = "SELECT usage_user FROM cpu";
        const invalidQuery = "SELECT invalid_field FROM cpu";

        expect(parser.validateWithSchema(validQuery).valid).toBe(true);
        
        const result = parser.validateWithSchema(invalidQuery);
        expect(result.warnings).toBeDefined();
        const unknownFieldWarning = result.warnings?.find(w => w.type === "UNKNOWN_FIELD");
        expect(unknownFieldWarning).toBeDefined();
        expect(unknownFieldWarning?.type).toBe("UNKNOWN_FIELD");
      });

      it("should validate tag names against schema", () => {
        const validQuery = "SELECT * FROM cpu WHERE host = 'server01'";
        const invalidQuery = "SELECT * FROM cpu WHERE invalid_tag = 'value'";

        expect(parser.validateWithSchema(validQuery).valid).toBe(true);
        
        const result = parser.validateWithSchema(invalidQuery);
        expect(result.warnings).toBeDefined();
        const unknownTagWarning = result.warnings?.find(w => w.type === "UNKNOWN_TAG");
        expect(unknownTagWarning).toBeDefined();
        expect(unknownTagWarning?.type).toBe("UNKNOWN_TAG");
      });

      it("should suggest similar names for typos", () => {
        const query = "SELECT * FROM cpi"; // typo: cpi instead of cpu
        const result = parser.validateWithSchema(query);
        
        expect(result.valid).toBe(false);
        expect(result.suggestions).toContain("Did you mean 'cpu'?");
      });
    });

    describe("Query Optimization Suggestions", () => {
      it("should suggest adding time constraints", () => {
        const query = "SELECT * FROM cpu";
        const result = parser.analyzePerformance(query);
        
        expect(result.suggestions).toBeDefined();
        expect(result.suggestions?.some(s => 
          s.type === "ADD_TIME_CONSTRAINT"
        )).toBe(true);
      });

      it("should suggest using specific fields instead of *", () => {
        const query = "SELECT * FROM cpu WHERE time > now() - 1h";
        const result = parser.analyzePerformance(query);
        
        expect(result.suggestions?.some(s => 
          s.type === "AVOID_SELECT_STAR"
        )).toBe(true);
      });

      it("should suggest adding LIMIT for large queries", () => {
        const query = "SELECT value FROM cpu WHERE time > now() - 7d";
        const result = parser.analyzePerformance(query);
        
        expect(result.suggestions?.some(s => 
          s.type === "ADD_LIMIT"
        )).toBe(true);
      });

      it("should suggest using continuous queries for repeated aggregations", () => {
        const query = "SELECT MEAN(value) FROM cpu WHERE time > now() - 30d GROUP BY time(1h)";
        const result = parser.analyzePerformance(query);
        
        expect(result.suggestions?.some(s => 
          s.type === "USE_CONTINUOUS_QUERY"
        )).toBe(true);
      });

      it("should suggest using retention policies for old data", () => {
        const query = "SELECT * FROM cpu WHERE time > now() - 365d";
        const result = parser.analyzePerformance(query);
        
        expect(result.suggestions?.some(s => 
          s.type === "USE_RETENTION_POLICY"
        )).toBe(true);
      });

      it("should calculate query complexity score", () => {
        const simpleQuery = "SELECT value FROM cpu LIMIT 10";
        const complexQuery = "SELECT MEAN(value) FROM cpu WHERE host =~ /server.*/ GROUP BY time(10m), host, region ORDER BY time DESC LIMIT 1000";
        
        const simpleScore = parser.getComplexityScore(simpleQuery);
        const complexScore = parser.getComplexityScore(complexQuery);
        
        expect(complexScore).toBeGreaterThan(simpleScore);
        expect(simpleScore).toBeLessThan(5);
        expect(complexScore).toBeGreaterThan(10);
      });
    });

    describe("Query Builder Helpers", () => {
      it("should build basic SELECT queries", () => {
        const query = parser.buildQuery({
          fields: ["value", "host"],
          measurement: "cpu",
          where: { host: "server01" },
          limit: 100
        });
        
        expect(query).toBe("SELECT value, host FROM cpu WHERE host = 'server01' LIMIT 100");
      });

      it("should build aggregation queries", () => {
        const query = parser.buildQuery({
          aggregation: "MEAN",
          field: "value",
          measurement: "cpu",
          groupBy: ["time(10m)", "host"],
          where: { time: "> now() - 1h" }
        });
        
        expect(query).toContain("SELECT MEAN(value)");
        expect(query).toContain("GROUP BY time(10m), host");
      });

      it("should escape special characters in identifiers", () => {
        const escaped = parser.escapeIdentifier("measurement-with-dash");
        expect(escaped).toBe('"measurement-with-dash"');
        
        const noEscape = parser.escapeIdentifier("simple_name");
        expect(noEscape).toBe("simple_name");
      });

      it("should format duration values", () => {
        expect(parser.formatDurationSeconds(60)).toBe("1m");
        expect(parser.formatDurationSeconds(3600)).toBe("1h");
        expect(parser.formatDurationSeconds(86400)).toBe("1d");
        expect(parser.formatDurationSeconds(604800)).toBe("1w");
        expect(parser.formatDurationSeconds(90)).toBe("90s");
      });
    });

    describe("Documentation Generation", () => {
      it("should generate query documentation", () => {
        const query = "SELECT MEAN(value) FROM cpu WHERE host = 'server01' GROUP BY time(10m)";
        const docs = parser.documentQuery(query);
        
        expect(docs.description).toBeDefined();
        expect(docs.operations).toContain("aggregation");
        expect(docs.operations).toContain("filtering");
        expect(docs.operations).toContain("grouping");
        expect(docs.timeRange).toBeDefined();
      });

      it("should explain query components", () => {
        const query = "SELECT MEAN(value) FROM cpu WHERE host = 'server01' GROUP BY time(10m) LIMIT 100";
        const explanation = parser.explainQuery(query);
        
        expect(explanation.select).toBe("Calculate the mean of 'value' field");
        expect(explanation.from).toBe("Query data from 'cpu' measurement");
        expect(explanation.where).toBe("Filter where host equals 'server01'");
        expect(explanation.groupBy).toBe("Group results by 10 minutes intervals");
        expect(explanation.limit).toBe("Return at most 100 results");
      });
    });

    describe("Migration Helpers", () => {
      it("should convert Flux queries to InfluxQL", () => {
        const fluxQuery = `from(bucket: "mydb")
          |> range(start: -1h)
          |> filter(fn: (r) => r._measurement == "cpu")
          |> mean()`;
        
        const influxQL = parser.convertFromFlux(fluxQuery);
        expect(influxQL).toContain("SELECT MEAN");
        expect(influxQL).toContain("FROM cpu");
        expect(influxQL).toContain("WHERE time > now() - 1h");
      });

      it("should suggest InfluxQL alternatives for SQL queries", () => {
        const sqlQuery = "SELECT AVG(value) FROM cpu WHERE host = 'server01' AND time > NOW() - INTERVAL 1 HOUR";
        const influxQL = parser.convertFromSQL(sqlQuery);
        
        expect(influxQL).toContain("MEAN(value)"); // AVG -> MEAN in InfluxQL
        expect(influxQL).toContain("WHERE host = 'server01'");
        expect(influxQL).toContain("time > now() - 1h");
      });
    });
  });
});