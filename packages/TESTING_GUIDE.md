# Unified Testing Guide for TimeCore Query Parsers

This guide provides comprehensive testing strategies and best practices for all TimeCore query language parsers (LogQL, PromQL, and InfluxQL).

## Overview

TimeCore includes three specialized query parsers, each generated from Peggy grammar definitions:

- **LogQL Parser** (Loki) - Log query language with streaming operators
- **PromQL Parser** (Prometheus) - Metric query language with time series functions
- **InfluxQL Parser** (InfluxDB) - SQL-like query language for time series data

## Testing Architecture

### Parser Testing Stack

```
┌─────────────────────────────────┐
│      Integration Tests          │  - End-to-end adapter testing
├─────────────────────────────────┤
│      Validation Tests           │  - Semantic validation
├─────────────────────────────────┤
│        Parser Tests             │  - AST generation
├─────────────────────────────────┤
│      Grammar Tests              │  - Peggy grammar validation
└─────────────────────────────────┘
```

## Running Tests

### All Parsers

```bash
# From workspace root - run all tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run tests in watch mode
npm test -- --watch
```

### Individual Parser Tests

```bash
# Test LogQL Parser
cd packages/adapters/loki
npm test -- logql-parser.test.ts

# Test PromQL Parser
cd packages/adapters/prometheus
npm test -- promql-parser.test.ts

# Test InfluxQL Parser
cd packages/adapters/influxdb
npm test -- influxql-parser.test.ts
```

## Unit Testing Parsers

### Test Structure Template

```javascript
describe('QueryParser', () => {
  let parser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('parse()', () => {
    it('should parse valid queries', () => {
      const result = parser.parse('valid query');
      expect(result.valid).toBe(true);
      expect(result.ast).toBeDefined();
    });

    it('should handle parse errors', () => {
      const result = parser.parse('invalid query');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.suggestions).toBeInstanceOf(Array);
    });
  });

  describe('validate()', () => {
    it('should validate semantics', () => {
      const validation = parser.validate('query');
      expect(validation.valid).toBeDefined();
      expect(validation.errors).toBeInstanceOf(Array);
      expect(validation.warnings).toBeInstanceOf(Array);
    });
  });

  describe('stringify()', () => {
    it('should reconstruct queries from AST', () => {
      const result = parser.parse('query');
      const reconstructed = parser.stringify(result.ast);
      expect(reconstructed).toBe('query');
    });
  });
});
```

### LogQL Parser Testing

#### Key Test Categories

1. **Stream Selectors**
```javascript
describe('Stream Selectors', () => {
  test.each([
    ['{job="nginx"}', true],
    ['{job="nginx", env="prod"}', true],
    ['{job=~"nginx|apache"}', true],
    ['{job!="test"}', true],
    ['{}', false], // Empty selector
  ])('parse("%s") => valid: %s', (query, expected) => {
    const result = parser.parse(query);
    expect(result.valid).toBe(expected);
  });
});
```

2. **Line Filters**
```javascript
describe('Line Filters', () => {
  test.each([
    ['{job="nginx"} |= "error"', 'contains'],
    ['{job="nginx"} != "debug"', 'not_contains'],
    ['{job="nginx"} |~ "\\d+"', 'regex'],
    ['{job="nginx"} !~ "test"', 'not_regex'],
  ])('parse("%s") => filter type: %s', (query, filterType) => {
    const result = parser.parse(query);
    expect(result.ast.filters[0].type).toBe(filterType);
  });
});
```

3. **Parser Stages**
```javascript
describe('Parser Stages', () => {
  it('should parse JSON stage', () => {
    const result = parser.parse('{job="nginx"} | json');
    expect(result.ast.pipeline[0].type).toBe('json');
  });

  it('should parse pattern stage', () => {
    const result = parser.parse('{job="nginx"} | pattern "<ip> <method>"');
    expect(result.ast.pipeline[0].type).toBe('pattern');
  });
});
```

### PromQL Parser Testing

#### Key Test Categories

1. **Vector Types**
```javascript
describe('Vector Types', () => {
  it('should identify instant vectors', () => {
    const result = parser.parse('http_requests_total');
    expect(result.ast.type).toBe('instant_vector');
  });

  it('should identify range vectors', () => {
    const result = parser.parse('http_requests_total[5m]');
    expect(result.ast.type).toBe('range_vector');
  });

  it('should identify scalar values', () => {
    const result = parser.parse('42');
    expect(result.ast.type).toBe('scalar');
  });
});
```

2. **Functions**
```javascript
describe('Functions', () => {
  test.each([
    ['rate(metric[5m])', 'rate', 'range_vector'],
    ['sum(metric)', 'sum', 'instant_vector'],
    ['histogram_quantile(0.95, metric)', 'histogram_quantile', 'scalar'],
  ])('parse("%s") => function: %s, arg_type: %s', (query, func, argType) => {
    const result = parser.parse(query);
    expect(result.ast.function).toBe(func);
    // Additional type checking
  });
});
```

3. **Binary Operations**
```javascript
describe('Binary Operations', () => {
  it('should parse arithmetic operations', () => {
    const result = parser.parse('metric1 + metric2');
    expect(result.ast.operator).toBe('+');
  });

  it('should parse vector matching', () => {
    const result = parser.parse('metric1 * on(label) metric2');
    expect(result.ast.matching.on).toContain('label');
  });
});
```

### InfluxQL Parser Testing

#### Key Test Categories

1. **SELECT Statements**
```javascript
describe('SELECT Statements', () => {
  it('should parse basic SELECT', () => {
    const result = parser.parse('SELECT * FROM "cpu"');
    expect(result.ast.type).toBe('select');
    expect(result.ast.from).toBe('cpu');
  });

  it('should parse aggregations', () => {
    const result = parser.parse('SELECT mean("value") FROM "cpu"');
    expect(result.ast.fields[0].function).toBe('mean');
  });
});
```

2. **WHERE Clauses**
```javascript
describe('WHERE Clauses', () => {
  test.each([
    ['WHERE time > now() - 1h', 'time_range'],
    ['WHERE "tag" = \'value\'', 'tag_filter'],
    ['WHERE "field" > 100', 'field_filter'],
  ])('parse("SELECT * FROM \"m\" %s")', (where, filterType) => {
    const result = parser.parse(`SELECT * FROM "measurement" ${where}`);
    // Validate filter type
  });
});
```

3. **GROUP BY**
```javascript
describe('GROUP BY', () => {
  it('should parse time grouping', () => {
    const result = parser.parse('SELECT mean("value") FROM "cpu" GROUP BY time(5m)');
    expect(result.ast.groupBy.time).toBe('5m');
  });

  it('should parse tag grouping', () => {
    const result = parser.parse('SELECT * FROM "cpu" GROUP BY "host", "region"');
    expect(result.ast.groupBy.tags).toEqual(['host', 'region']);
  });
});
```

## Integration Testing

### Testing with Adapters

```javascript
describe('Adapter Integration', () => {
  let adapter;

  beforeEach(() => {
    adapter = new Adapter({
      url: 'http://localhost:port'
    });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('Query Validation', () => {
    it('should validate before execution', () => {
      expect(adapter.validateQuery('valid query')).toBe(true);
      expect(adapter.validateQuery('invalid')).toBe(false);
    });
  });

  describe('Query Execution', () => {
    it('should execute valid queries', async () => {
      const stream = adapter.query('valid query', startTime, endTime);
      const events = [];
      
      for await (const event of stream) {
        events.push(event);
        if (events.length >= 10) break;
      }
      
      expect(events).toHaveLength(10);
    });

    it('should handle query errors', async () => {
      await expect(async () => {
        const stream = adapter.query('invalid query', startTime, endTime);
        for await (const event of stream) {
          // Should throw before yielding
        }
      }).rejects.toThrow();
    });
  });
});
```

### Mock Data Testing

```javascript
// Create mock responses for testing
function createMockLokiResponse(entries) {
  return {
    status: 'success',
    data: {
      result: [{
        stream: { job: 'test' },
        values: entries.map(e => [e.timestamp, e.line])
      }]
    }
  };
}

function createMockPrometheusResponse(series) {
  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: series
    }
  };
}

function createMockInfluxResponse(points) {
  return {
    results: [{
      series: [{
        name: 'measurement',
        columns: ['time', 'value'],
        values: points
      }]
    }]
  };
}
```

## Performance Testing

### Parser Benchmarks

```javascript
describe('Parser Performance', () => {
  const iterations = 1000;
  
  it('should parse queries efficiently', () => {
    const query = 'complex query here';
    const start = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      parser.parse(query);
    }
    
    const duration = Date.now() - start;
    const avgTime = duration / iterations;
    
    expect(avgTime).toBeLessThan(10); // < 10ms per query
    console.log(`Average parse time: ${avgTime.toFixed(2)}ms`);
  });
});
```

### Memory Testing

```javascript
describe('Memory Usage', () => {
  it('should not leak memory', () => {
    const initialMemory = process.memoryUsage().heapUsed;
    
    // Parse many queries
    for (let i = 0; i < 10000; i++) {
      const result = parser.parse(`{job="test${i}"} |= "error"`);
      // Result should be garbage collected
    }
    
    global.gc(); // Requires --expose-gc flag
    const finalMemory = process.memoryUsage().heapUsed;
    const memoryGrowth = finalMemory - initialMemory;
    
    expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024); // < 10MB
  });
});
```

## Error Testing

### Comprehensive Error Cases

```javascript
describe('Error Handling', () => {
  describe('Parse Errors', () => {
    test.each([
      ['', 'Empty query'],
      ['{', 'Unclosed brace'],
      ['SELECT', 'Incomplete statement'],
      ['rate(', 'Unclosed parenthesis'],
    ])('should handle: %s (%s)', (query, description) => {
      const result = parser.parse(query);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.suggestions).toHaveLength.greaterThan(0);
    });
  });

  describe('Validation Errors', () => {
    test.each([
      ['rate(instant_vector)', 'Type mismatch'],
      ['sum()', 'Missing arguments'],
      ['{job="}', 'Invalid label value'],
    ])('should catch: %s (%s)', (query, description) => {
      const validation = parser.validate(query);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength.greaterThan(0);
    });
  });
});
```

## Test Coverage Requirements

### Minimum Coverage Targets

| Component | Line Coverage | Branch Coverage | Function Coverage |
|-----------|--------------|----------------|-------------------|
| Parser Core | 90% | 85% | 95% |
| Grammar Rules | 100% | 95% | 100% |
| Validation | 85% | 80% | 90% |
| Error Handling | 95% | 90% | 100% |
| Integration | 80% | 75% | 85% |

### Coverage Commands

```bash
# Generate coverage report
npm test -- --coverage

# Generate HTML coverage report
npm test -- --coverage --coverageReporters=html

# Check coverage thresholds
npm test -- --coverage --coverageThreshold='{
  "global": {
    "branches": 85,
    "functions": 90,
    "lines": 90,
    "statements": 90
  }
}'
```

## Continuous Integration Testing

### GitHub Actions Configuration

```yaml
name: Parser Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]
        parser: [loki, prometheus, influxdb]
    
    steps:
      - uses: actions/checkout@v3
      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node-version }}
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run parser tests
        run: |
          cd packages/adapters/${{ matrix.parser }}
          npm test -- --coverage
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage/lcov.info
          flags: ${{ matrix.parser }}
```

## Debugging Tests

### Using Node Inspector

```bash
# Debug tests with Chrome DevTools
node --inspect-brk ./node_modules/.bin/jest --runInBand

# Debug specific test file
node --inspect-brk ./node_modules/.bin/jest logql-parser.test.ts --runInBand
```

### Verbose Output

```bash
# Show all test output
npm test -- --verbose

# Show test names only
npm test -- --listTests

# Run tests matching pattern
npm test -- --testNamePattern="should parse SELECT"
```

## Best Practices

### 1. Test Organization

- Group related tests using `describe` blocks
- Use descriptive test names that explain the scenario
- Keep tests focused on single behaviors
- Use `test.each` for parameterized testing

### 2. Test Data

- Use realistic query examples
- Include edge cases and boundary conditions
- Test both valid and invalid inputs
- Maintain test fixtures in separate files for complex data

### 3. Assertions

- Be specific with assertions
- Test the entire AST structure when relevant
- Verify error messages and suggestions
- Check for performance regressions

### 4. Mocking

- Mock external dependencies (HTTP calls, WebSocket)
- Use consistent mock data structures
- Test both success and failure scenarios
- Verify mock interactions

### 5. Maintenance

- Keep tests synchronized with grammar changes
- Update tests when adding new features
- Remove obsolete tests
- Document complex test scenarios

## Troubleshooting

### Common Issues

1. **Grammar Regeneration**
   ```bash
   # Regenerate parser from grammar
   npm run generate-parser
   ```

2. **Test Timeout**
   ```javascript
   jest.setTimeout(10000); // Increase timeout for slow tests
   ```

3. **Memory Issues**
   ```bash
   # Run with increased memory
   NODE_OPTIONS="--max-old-space-size=4096" npm test
   ```

4. **Debugging Parser Output**
   ```javascript
   console.log(JSON.stringify(result.ast, null, 2));
   ```

## Contributing Tests

When adding new parser features:

1. Write grammar tests first (TDD approach)
2. Add parser unit tests
3. Add validation tests
4. Add integration tests
5. Update this guide with new test patterns

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Peggy Testing Guide](https://peggyjs.org/documentation.html#testing)
- [TimeCore Contributing Guide](../CONTRIBUTING.md)