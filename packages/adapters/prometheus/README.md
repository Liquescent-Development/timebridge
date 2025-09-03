# Prometheus Adapter for TimeCore

A comprehensive Prometheus adapter with built-in PromQL parser for the TimeCore log correlation system.

## Features

- ✅ **Full PromQL Parser**: Complete query validation and syntax checking
- ✅ **Instant & Range Queries**: Support for both query types
- ✅ **Streaming Support**: Real-time metric streaming
- ✅ **Authentication**: Bearer token and custom headers support
- ✅ **Comprehensive Validation**: Type checking and function validation
- ✅ **AST Manipulation**: Parse, validate, and reconstruct queries

## Installation

```bash
npm install @timebridge/prometheus
```

## Usage

### Basic Setup

```javascript
const { PrometheusAdapter } = require('@timebridge/prometheus');

const adapter = new PrometheusAdapter({
  url: 'http://localhost:9090',
  authToken: 'your-auth-token',
  headers: {
    'X-Scope-OrgID': 'tenant-1'
  }
});

// Query metrics
const stream = adapter.query(
  'rate(http_requests_total[5m])',
  new Date(Date.now() - 3600000), // 1 hour ago
  new Date()
);

for await (const event of stream) {
  console.log(event);
}
```

### Using the PromQL Parser

```javascript
const { PromQLParser } = require('@timebridge/prometheus');

const parser = new PromQLParser();

// Parse a query
const result = parser.parse('sum(rate(http_requests_total{job="api"}[5m])) by (status)');
if (result.valid) {
  console.log('AST:', result.ast);
} else {
  console.log('Error:', result.error);
  console.log('Suggestions:', result.suggestions);
}

// Validate a query
const validation = parser.validate('rate(http_requests_total[5m])');
if (validation.valid) {
  console.log('Query is valid!');
} else {
  console.log('Validation errors:', validation.errors);
  console.log('Warnings:', validation.warnings);
}

// Convert AST back to query string
const queryString = parser.stringify(result.ast);
```

## PromQL Query Examples

### Instant Vectors

```promql
# Simple metric
http_requests_total

# With label matchers
http_requests_total{job="api", status="200"}

# With regex matcher
http_requests_total{job=~"api|web"}

# Negative matcher
http_requests_total{status!="500"}
```

### Range Vectors

```promql
# 5-minute range
http_requests_total[5m]

# With offset
http_requests_total[5m] offset 1h

# With @ modifier
http_requests_total @ 1609746000
```

### Aggregations

```promql
# Sum by job
sum(http_requests_total) by (job)

# Average without instance
avg without (instance) (cpu_usage)

# Top 5 by value
topk(5, http_requests_total)

# 95th percentile
quantile(0.95, http_request_duration_seconds)
```

### Functions

```promql
# Rate of increase
rate(http_requests_total[5m])

# Instant rate
irate(http_requests_total[5m])

# Increase over time
increase(http_requests_total[1h])

# Histogram quantiles
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# Label manipulation
label_replace(up, "new_label", "$1", "instance", "(.*):.+")
```

### Binary Operators

```promql
# Arithmetic
metric1 + metric2
metric1 * 100

# Comparison
metric1 > 100
metric1 == bool metric2

# Logical
metric1 and metric2
metric1 or metric2
metric1 unless metric2

# Vector matching
metric1 * on(instance) metric2
metric1 / ignoring(job) group_left(version) metric2
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run only parser tests
npm test -- promql-parser.test.ts

# Run with coverage
npm test -- --coverage
```

### Writing Tests

```javascript
describe('My PromQL queries', () => {
  let parser;

  beforeEach(() => {
    parser = new PromQLParser();
  });

  it('should parse my custom query', () => {
    const result = parser.parse('sum(rate(my_metric[5m])) by (label)');
    expect(result.valid).toBe(true);
    expect(result.ast).toBeDefined();
  });

  it('should validate complex queries', () => {
    const validation = parser.validate(
      'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))'
    );
    expect(validation.valid).toBe(true);
  });
});
```

### Integration Testing

```javascript
const { PrometheusAdapter } = require('@timebridge/prometheus');

describe('Prometheus Integration', () => {
  let adapter;

  beforeEach(() => {
    adapter = new PrometheusAdapter({
      url: process.env.PROMETHEUS_URL || 'http://localhost:9090'
    });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('should validate queries before execution', () => {
    const valid = adapter.validateQuery('rate(http_requests_total[5m])');
    expect(valid).toBe(true);

    const invalid = adapter.validateQuery('rate(');
    expect(invalid).toBe(false);
  });

  it('should execute instant queries', async () => {
    const result = await adapter.instantQuery('up');
    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
  });

  it('should stream range queries', async () => {
    const events = [];
    const stream = adapter.query(
      'http_requests_total',
      new Date(Date.now() - 300000), // 5 minutes ago
      new Date()
    );

    for await (const event of stream) {
      events.push(event);
      if (events.length >= 10) break;
    }

    expect(events.length).toBeGreaterThan(0);
  });
});
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | required | Prometheus server URL |
| `timeout` | number | `30000` | Request timeout in ms |
| `authToken` | string | - | Bearer authentication token |
| `headers` | object | `{}` | Additional HTTP headers |
| `step` | string | `'15s'` | Query resolution step |

## Error Handling

The adapter and parser provide detailed error information:

```javascript
// Parser errors with suggestions
const result = parser.parse('sum(metric');
if (!result.valid) {
  console.error('Parse error:', result.error);
  // "Unclosed parentheses - missing ')' at line 1, column 11"
  console.log('Suggestions:', result.suggestions);
  // ["Add closing parenthesis"]
}

// Validation with warnings
const validation = parser.validate('metric{label=~".*value"}');
if (validation.warnings) {
  validation.warnings.forEach(warning => {
    console.warn(`${warning.type}: ${warning.message}`);
    // "PERFORMANCE: Leading .* in regex pattern can be slow"
  });
}

// Query execution errors
try {
  const stream = adapter.query('invalid query', start, end);
  for await (const event of stream) {
    // process events
  }
} catch (error) {
  if (error.code === 'PROMETHEUS_QUERY_ERROR') {
    console.error('Query error:', error.message);
  }
}
```

## Performance Best Practices

### 1. Use Recording Rules

Instead of complex queries at query time, pre-calculate with recording rules:

```promql
# Instead of this at query time:
sum(rate(http_requests_total[5m])) by (job, instance)

# Use a recording rule:
job_instance:http_requests:rate5m
```

### 2. Optimize Label Matchers

```promql
# Good - specific matchers
http_requests_total{job="api", method="GET"}

# Avoid - regex on high-cardinality labels
http_requests_total{instance=~".*"}

# Avoid - negative regex matchers
http_requests_total{job!~"test.*"}
```

### 3. Limit Aggregation Scope

```promql
# Better - aggregate after filtering
sum(rate(http_requests_total{job="api"}[5m])) by (status)

# Worse - filter after aggregation
sum(rate(http_requests_total[5m])) by (job, status)
```

### 4. Use Appropriate Functions

```promql
# For counters that rarely increase - use increase()
increase(errors_total[1h])

# For frequently changing counters - use rate()
rate(http_requests_total[5m])

# For spiky metrics - use irate()
irate(http_requests_total[5m])
```

## API Reference

### PrometheusAdapter

#### Methods

- `query(query: string, start: Date, end: Date, step?: string): AsyncIterable<LogEvent>`
- `instantQuery(query: string, time?: Date): Promise<QueryResult>`
- `validateQuery(query: string): boolean`
- `connect(): Promise<void>`
- `disconnect(): Promise<void>`
- `getMetadata(metric?: string): Promise<MetricMetadata[]>`

### PromQLParser

#### Methods

- `parse(query: string): ParseResult`
- `validate(query: string): ValidationResult`
- `stringify(ast: PromQLAST): string`

#### Validation Features

- Function argument validation
- Type checking (scalar vs vector vs matrix)
- Label name validation
- Duration format validation
- Performance warnings

## Troubleshooting

### Common Parse Errors

1. **Unbalanced brackets/parentheses**
   ```javascript
   parser.parse('sum(metric');  // Missing closing parenthesis
   ```

2. **Invalid duration units**
   ```javascript
   parser.parse('metric[5]');   // Missing unit (should be [5m])
   ```

3. **Invalid function usage**
   ```javascript
   parser.parse('rate(metric)'); // rate() requires range vector
   ```

### Query Performance Issues

If queries are slow:

1. Check query complexity with `parser.validate()`
2. Look for performance warnings
3. Consider using recording rules
4. Reduce time range or increase step

### Connection Issues

```javascript
// Test connection
try {
  await adapter.connect();
  console.log('Connected successfully');
} catch (error) {
  console.error('Connection failed:', error);
}
```

## Advanced Features

### AST Manipulation

```javascript
// Parse a query
const result = parser.parse('sum(rate(metric[5m]))');

// Modify the AST
if (result.ast.operation === 'sum') {
  result.ast.grouping = {
    type: 'by',
    labels: ['job', 'instance']
  };
}

// Reconstruct the query
const newQuery = parser.stringify(result.ast);
// "sum by (job, instance) (rate(metric[5m]))"
```

### Custom Validation Rules

```javascript
function validateCustomRules(query) {
  const result = parser.parse(query);
  
  if (!result.valid) return false;
  
  // Add custom validation
  if (query.includes('production') && !query.includes('job="prod"')) {
    console.warn('Production queries should filter by job="prod"');
  }
  
  return true;
}
```

## Contributing

See the main [TimeCore Contributing Guide](../../../CONTRIBUTING.md).

## License

AGPL-3.0