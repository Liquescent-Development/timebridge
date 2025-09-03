# InfluxDB Adapter for TimeCore

A comprehensive InfluxDB adapter with built-in InfluxQL parser for the TimeCore log correlation system.

## Features

- ✅ **Full InfluxQL Parser**: Complete query validation and syntax checking
- ✅ **InfluxDB 1.x & 2.x Support**: Compatible with both versions
- ✅ **Flux Query Support**: InfluxDB 2.x Flux language
- ✅ **Streaming Results**: Efficient memory usage for large datasets
- ✅ **Authentication**: Token and username/password support
- ✅ **Comprehensive Validation**: SQL-like syntax validation

## Installation

```bash
npm install @timebridge/influxdb
```

## Usage

### Basic Setup

```javascript
const { InfluxDBAdapter } = require('@timebridge/influxdb');

// InfluxDB 2.x
const adapter = new InfluxDBAdapter({
  url: 'http://localhost:8086',
  token: 'your-auth-token',
  org: 'your-org',
  bucket: 'your-bucket',
  version: '2.x'
});

// InfluxDB 1.x
const adapter = new InfluxDBAdapter({
  url: 'http://localhost:8086',
  database: 'mydb',
  username: 'admin',
  password: 'password',
  version: '1.x'
});

// Query data
const stream = adapter.query(
  'SELECT mean("value") FROM "temperature" WHERE time > now() - 1h GROUP BY time(5m)',
  new Date(Date.now() - 3600000),
  new Date()
);

for await (const event of stream) {
  console.log(event);
}
```

### Using the InfluxQL Parser

```javascript
const { InfluxQLParser } = require('@timebridge/influxdb');

const parser = new InfluxQLParser();

// Parse a query
const result = parser.parse('SELECT mean("value") FROM "cpu" WHERE "host" = \'server1\' GROUP BY time(10m)');
if (result.valid) {
  console.log('AST:', result.ast);
} else {
  console.log('Error:', result.error);
  console.log('Suggestions:', result.suggestions);
}

// Validate a query
const validation = parser.validate('SELECT * FROM "measurement" WHERE time > now() - 1d');
if (validation.valid) {
  console.log('Query is valid!');
} else {
  console.log('Validation errors:', validation.errors);
}

// Convert AST back to query string
const queryString = parser.stringify(result.ast);
```

## InfluxQL Query Examples

### SELECT Statements

```sql
-- Simple selection
SELECT "value" FROM "temperature"

-- Multiple fields
SELECT "temperature", "humidity", "pressure" FROM "weather"

-- All fields
SELECT * FROM "cpu"

-- With arithmetic
SELECT ("used" / "total") * 100 AS "usage_percent" FROM "memory"
```

### Aggregation Functions

```sql
-- Mean value
SELECT mean("value") FROM "temperature" WHERE time > now() - 1h

-- Multiple aggregations
SELECT mean("value"), max("value"), min("value") FROM "cpu" GROUP BY time(5m)

-- Count distinct
SELECT count(distinct("host")) FROM "metrics"

-- Percentiles
SELECT percentile("response_time", 95) FROM "http_requests" GROUP BY time(1m)

-- Moving average
SELECT moving_average(mean("value"), 5) FROM "temperature" GROUP BY time(1m)
```

### WHERE Clauses

```sql
-- Time range
SELECT * FROM "events" WHERE time > now() - 24h

-- Tag filters
SELECT * FROM "cpu" WHERE "host" = 'server1' AND "region" = 'us-east'

-- Field comparisons
SELECT * FROM "temperature" WHERE "value" > 25 AND "value" < 30

-- Regex matching
SELECT * FROM "logs" WHERE "message" =~ /error|warning/

-- IN operator
SELECT * FROM "metrics" WHERE "host" IN ('server1', 'server2', 'server3')
```

### GROUP BY

```sql
-- Group by time
SELECT mean("value") FROM "cpu" GROUP BY time(10m)

-- Group by tags
SELECT mean("value") FROM "cpu" GROUP BY "host"

-- Group by time and tags
SELECT mean("value") FROM "cpu" GROUP BY time(5m), "host", "region"

-- Fill missing values
SELECT mean("value") FROM "cpu" GROUP BY time(1m) fill(0)

-- Fill with previous
SELECT mean("value") FROM "cpu" GROUP BY time(1m) fill(previous)
```

### Advanced Features

```sql
-- Subqueries
SELECT mean("max") FROM (
  SELECT max("value") FROM "cpu" GROUP BY time(1m), "host"
) GROUP BY time(1h)

-- Continuous queries (stored)
CREATE CONTINUOUS QUERY "cq_5m_mean" ON "mydb" 
BEGIN
  SELECT mean("value") INTO "cpu_5m_mean" 
  FROM "cpu" 
  GROUP BY time(5m), *
END

-- Show measurements
SHOW MEASUREMENTS

-- Show tag keys
SHOW TAG KEYS FROM "cpu"

-- Show field keys
SHOW FIELD KEYS FROM "cpu"
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run only parser tests
npm test -- influxql-parser.test.ts

# Run with coverage
npm test -- --coverage
```

### Writing Tests

```javascript
describe('My InfluxQL queries', () => {
  let parser;

  beforeEach(() => {
    parser = new InfluxQLParser();
  });

  it('should parse SELECT statements', () => {
    const result = parser.parse('SELECT mean("value") FROM "cpu" WHERE time > now() - 1h');
    expect(result.valid).toBe(true);
    expect(result.ast.type).toBe('select');
  });

  it('should validate GROUP BY clauses', () => {
    const validation = parser.validate(
      'SELECT mean("value") FROM "temperature" GROUP BY time(5m), "location"'
    );
    expect(validation.valid).toBe(true);
  });
});
```

### Integration Testing

```javascript
const { InfluxDBAdapter } = require('@timebridge/influxdb');

describe('InfluxDB Integration', () => {
  let adapter;

  beforeEach(() => {
    adapter = new InfluxDBAdapter({
      url: process.env.INFLUXDB_URL || 'http://localhost:8086',
      token: process.env.INFLUXDB_TOKEN,
      org: 'test-org',
      bucket: 'test-bucket'
    });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('should validate queries before execution', () => {
    const valid = adapter.validateQuery('SELECT * FROM "cpu" WHERE time > now() - 1h');
    expect(valid).toBe(true);

    const invalid = adapter.validateQuery('SELECT FROM WHERE');
    expect(invalid).toBe(false);
  });

  it('should execute queries', async () => {
    const events = [];
    const stream = adapter.query(
      'SELECT mean("value") FROM "cpu" WHERE time > now() - 5m GROUP BY time(1m)',
      new Date(Date.now() - 300000),
      new Date()
    );

    for await (const event of stream) {
      events.push(event);
      if (events.length >= 5) break;
    }

    expect(events.length).toBeGreaterThan(0);
  });

  it('should write data points', async () => {
    const point = {
      measurement: 'temperature',
      tags: { location: 'room1' },
      fields: { value: 23.5 },
      timestamp: new Date()
    };

    await adapter.write(point);
    
    // Verify write
    const result = await adapter.query(
      'SELECT * FROM "temperature" WHERE "location" = \'room1\' ORDER BY time DESC LIMIT 1'
    );
    
    const events = [];
    for await (const event of result) {
      events.push(event);
    }
    
    expect(events[0].fields.value).toBe(23.5);
  });
});
```

## Configuration Options

### InfluxDB 2.x

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | required | InfluxDB server URL |
| `token` | string | required | Authentication token |
| `org` | string | required | Organization name |
| `bucket` | string | required | Default bucket |
| `timeout` | number | `30000` | Request timeout in ms |
| `version` | string | `'2.x'` | InfluxDB version |

### InfluxDB 1.x

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | required | InfluxDB server URL |
| `database` | string | required | Database name |
| `username` | string | - | Username for authentication |
| `password` | string | - | Password for authentication |
| `retentionPolicy` | string | `'autogen'` | Default retention policy |
| `timeout` | number | `30000` | Request timeout in ms |
| `version` | string | `'1.x'` | InfluxDB version |

## Error Handling

```javascript
// Parser errors
const result = parser.parse('SELECT FROM WHERE');
if (!result.valid) {
  console.error('Parse error:', result.error);
  // "Expected field list after SELECT at line 1, column 8"
  console.log('Suggestions:', result.suggestions);
  // ["Add field names or * after SELECT"]
}

// Validation errors
const validation = parser.validate('SELECT mean() FROM "cpu"');
if (!validation.valid) {
  validation.errors.forEach(error => {
    console.error(`${error.type}: ${error.message}`);
    // "FUNCTION: mean() requires at least one argument"
  });
}

// Query execution errors
try {
  const stream = adapter.query('INVALID QUERY', start, end);
  for await (const event of stream) {
    // process events
  }
} catch (error) {
  if (error.code === 'INFLUXDB_QUERY_ERROR') {
    console.error('Query error:', error.message);
  }
}
```

## Performance Optimization

### 1. Use Appropriate Time Ranges

```sql
-- Good - specific time range
SELECT * FROM "cpu" WHERE time > now() - 1h

-- Avoid - no time boundary
SELECT * FROM "cpu"
```

### 2. Leverage Indexes

```sql
-- Tags are indexed - fast
SELECT * FROM "cpu" WHERE "host" = 'server1'

-- Fields are not indexed - slower
SELECT * FROM "cpu" WHERE "value" > 100
```

### 3. Optimize GROUP BY

```sql
-- Group by appropriate intervals
SELECT mean("value") FROM "cpu" 
WHERE time > now() - 24h 
GROUP BY time(1h)  -- Hourly for daily data

-- Avoid small intervals for large ranges
-- This creates too many groups
SELECT mean("value") FROM "cpu" 
WHERE time > now() - 30d 
GROUP BY time(1s)  -- Too granular!
```

### 4. Use Continuous Queries

```sql
-- Pre-aggregate data with continuous queries
CREATE CONTINUOUS QUERY "hourly_mean" ON "mydb"
BEGIN
  SELECT mean(*) INTO "cpu_hourly" 
  FROM "cpu" 
  GROUP BY time(1h), *
END

-- Then query pre-aggregated data
SELECT * FROM "cpu_hourly" WHERE time > now() - 7d
```

## API Reference

### InfluxDBAdapter

#### Methods

- `query(query: string, start?: Date, end?: Date): AsyncIterable<DataPoint>`
- `write(point: DataPoint | DataPoint[]): Promise<void>`
- `validateQuery(query: string): boolean`
- `connect(): Promise<void>`
- `disconnect(): Promise<void>`
- `getDatabases(): Promise<string[]>` (1.x only)
- `getBuckets(): Promise<string[]>` (2.x only)
- `getMeasurements(db?: string): Promise<string[]>`

### InfluxQLParser

#### Methods

- `parse(query: string): ParseResult`
- `validate(query: string): ValidationResult`
- `stringify(ast: InfluxQLAST): string`

#### Supported Statements

- SELECT (with all clauses)
- SHOW (measurements, databases, etc.)
- CREATE/DROP database
- CREATE/DROP measurement
- CREATE/DROP continuous query
- CREATE/DROP retention policy

## Flux Support (InfluxDB 2.x)

For Flux queries in InfluxDB 2.x:

```javascript
// Use Flux language
const fluxQuery = `
  from(bucket: "example-bucket")
    |> range(start: -1h)
    |> filter(fn: (r) => r._measurement == "cpu")
    |> mean()
    |> yield(name: "mean")
`;

// Execute Flux query
const stream = adapter.queryFlux(fluxQuery);

for await (const record of stream) {
  console.log(record);
}
```

## Troubleshooting

### Connection Issues

```javascript
// Test connection
try {
  await adapter.connect();
  const databases = await adapter.getDatabases();
  console.log('Available databases:', databases);
} catch (error) {
  console.error('Connection failed:', error);
}
```

### Time Precision

```javascript
// Specify time precision
const adapter = new InfluxDBAdapter({
  url: 'http://localhost:8086',
  precision: 'ns',  // ns, u, ms, s, m, h
  // ... other options
});
```

### Debug Mode

```javascript
// Enable debug logging
const adapter = new InfluxDBAdapter({
  url: 'http://localhost:8086',
  debug: true,  // Logs all queries
  // ... other options
});
```

## Migration Guide

### From InfluxDB 1.x to 2.x

```javascript
// 1.x query
const oldQuery = 'SELECT mean("value") FROM "cpu" WHERE time > now() - 1h GROUP BY time(5m)';

// Equivalent 2.x Flux query
const fluxQuery = `
  from(bucket: "mybucket")
    |> range(start: -1h)
    |> filter(fn: (r) => r._measurement == "cpu")
    |> aggregateWindow(every: 5m, fn: mean)
`;
```

## Contributing

See the main [TimeCore Contributing Guide](../../../CONTRIBUTING.md).

## License

AGPL-3.0