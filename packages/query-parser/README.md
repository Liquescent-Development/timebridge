# TimeQL Parser

TimeQL (Time Query Language) parser for TimeBridge, providing correlation syntax for observability data across multiple sources including logs, metrics, and time-series.

## Features

- **TimeQL Syntax**: Time-focused query language for observability correlation
- **Multi-Source Support**: Graylog, Loki, Prometheus, InfluxDB query syntax
- **Temporal Correlation**: Advanced time window and alignment operations
- **Flexible Join Types**: Inner, left, anti-join, and temporal joins
- **Parse-time Validation**: Comprehensive syntax error detection
- **Performance Optimized**: Fast parsing with Peggy-generated parser

## Installation

```bash
npm install @timebridge/query-parser@^0.0.7
```

## Usage

```javascript
const { TimeQLParser } = require("@timebridge/query-parser");

const parser = new TimeQLParser();

// Parse a correlation query
const query = `
  graylog(service:frontend AND level:error)[10m]
    and on(request_id)
  prometheus(http_requests_total{status="500"})[10m]
`;
const parsed = parser.parse(query);

// Validate syntax
const validation = parser.validate(query);
if (!validation.valid) {
  console.error("Query error:", validation.error);
}
```

## Query Syntax

### Basic Structure

```
SOURCE(SELECTOR)[TIME_RANGE] [JOIN_OPERATOR SOURCE(SELECTOR)[TIME_RANGE]]*
```

### Supported Sources

- `graylog` - Graylog log source with native query syntax
- `loki` - Loki/Grafana log source with LogQL syntax
- `prometheus` - Prometheus metrics with PromQL syntax
- `influxdb` - InfluxDB time-series with InfluxQL/Flux syntax

### Direct Query Examples

#### Graylog Queries

```timeql
graylog(level:error)[5m]
graylog(service:api AND status:500)[10m]
graylog(message:"connection timeout" AND host:prod-*)[1h]
graylog(_exists_:request_id AND tier:production)[30m]
```

#### Loki Queries

```timeql
loki({job="nginx", level="error"})[5m]
loki({service="api"} |~ "timeout")[10m]
loki({namespace="production"} | json)[30m]
loki({app="frontend"} |= "error" != "debug")[1h]
```

#### Prometheus Queries

```timeql
prometheus(up{job="api"})[5m]
prometheus(rate(http_requests_total[5m]))[10m]
prometheus(histogram_quantile(0.99, http_duration_bucket))[1h]
prometheus(sum by (service)(cpu_usage))[30m]
```

#### InfluxDB Queries

```timeql
influxdb(SELECT mean(cpu) FROM system WHERE host = 'server1')[5m]
influxdb(from(bucket: "metrics") |> filter(fn: (r) => r._measurement == "cpu"))[5m]
```

### Correlation Query Examples

#### Inner Join (AND)

```timeql
graylog(service:frontend AND level:error)[5m]
  and on(request_id)
graylog(service:backend)[5m]
```

#### Left Join (OR)

```timeql
prometheus(http_requests_total{status="500"})[10m]
  or on(trace_id)
loki({service="api"})[10m]
```

#### Anti-Join (UNLESS)

```timeql
graylog(level:error)[5m]
  unless on(error_hash)
graylog(level:error)[5m] timeshift(1d)
```

#### Temporal Correlation

```timeql
prometheus(cpu_usage > 90)[10m]
  and on(instance) within(30s)
graylog(level:error)[10m]
```

#### Multi-Source Correlation

```timeql
graylog(service:api AND level:error)[10m]
  and on(trace_id)
loki({service="api"})[10m]
  and on(trace_id)
prometheus(http_requests_total{status="500"})[10m]
  and on(trace_id)
influxdb(SELECT * FROM api_metrics WHERE latency > 1000)[10m]
```

## Advanced Features

### Field Mapping

Map different field names between sources:

```timeql
graylog(service:api)[5m]
  and on(request_id=req_id, trace_id=tracing_id)
loki({service="api"})[5m]
```

### Time Window Operations

```timeql
# Events must occur within 1 minute of each other
sourceA(query)[10m]
  and on(id) within(1m)
sourceB(query)[10m]

# Compare with historical data
prometheus(errors)[1h]
  and on(service)
prometheus(errors)[1h] timeshift(1d)

# Align events by timestamp
prometheus(cpu)[1h]
  align on(timestamp)
influxdb(SELECT * FROM memory)[1h]
```

### Aggregation Operations

```timeql
# Many-to-one join keeping left labels
prometheus(instance_cpu)[5m]
  and on(instance) group_left(region, zone)
prometheus(instance_metadata)[5m]

# One-to-many join keeping right labels
graylog(service:api)[10m]
  and on(service) group_right()
graylog(service:*)[10m]
```

## Parser API

### TimeQLParser Methods

```javascript
const parser = new TimeQLParser();

// Parse a query into AST
const ast = parser.parse(query);

// Validate query syntax
const validation = parser.validate(query);
// Returns: { valid: boolean, error?: string }

// Get query metadata
const metadata = parser.getQueryMetadata(query);
// Returns: { type: 'direct' | 'correlation', sources: string[] }

// Extract time ranges
const timeRanges = parser.extractTimeRanges(query);
// Returns: { source: string, range: string }[]
```

### AST Structure

The parser returns an Abstract Syntax Tree (AST) with the following structure:

```javascript
{
  type: "correlation" | "direct",
  queries: [
    {
      source: "graylog",
      selector: "level:error",
      timeRange: "5m"
    }
  ],
  operators: [
    {
      type: "and",
      joinKeys: ["request_id"],
      temporal: { within: "30s" }
    }
  ]
}
```

## Error Handling

The parser provides detailed error messages for syntax issues:

```javascript
const validation = parser.validate("invalid query syntax");
if (!validation.valid) {
  console.error(validation.error);
  // Output: "Invalid query format: Expected source(...) at position 0"
}
```

## Grammar Definition

The TimeQL grammar is defined in `grammar/timeql.peggy` using Peggy (PEG.js). Key grammar rules:

- **Query**: Top-level rule for complete queries
- **DirectQuery**: Single-source queries
- **CorrelationQuery**: Multi-source correlation queries
- **Source**: Data source identifiers
- **Selector**: Source-specific query syntax
- **TimeRange**: Duration specifications
- **JoinOperator**: Correlation operations

## Integration with TimeBridge

The parser is designed for seamless integration with TimeBridge:

```javascript
import { TimeQLExecutor } from "@timebridge/core";
import { TimeQLParser } from "@timebridge/query-parser";

const executor = new TimeQLExecutor();
const parser = new TimeQLParser();

// Parse and execute
const query =
  "graylog(level:error)[5m] and on(request_id) loki({service='api'})[5m]";
const validation = parser.validate(query);

if (validation.valid) {
  for await (const result of executor.execute(query)) {
    console.log(result);
  }
}
```

## Performance Considerations

- The parser is optimized for fast parsing with linear complexity
- AST generation is minimal to reduce memory overhead
- Query validation is performed without full parsing when possible
- Caching is used for repeated query patterns

## Contributing

The grammar file is located at `grammar/timeql.peggy`. To modify the parser:

1. Edit the grammar file
2. Regenerate the parser: `npm run generate-parser`
3. Run tests: `npm test`
4. Update documentation

## Migration Guide

### From log-correlator-query-parser

```javascript
// Old
const { PeggyQueryParser } = require("@liquescent/log-correlator-query-parser");
const parser = new PeggyQueryParser();

// New
const { TimeQLParser } = require("@timebridge/query-parser");
const parser = new TimeQLParser();

// API is compatible - just update imports
```

## Development

```bash
# Generate parser from grammar
npm run generate-parser

# Build TypeScript
npm run build

# Run tests
npm test

# Run grammar tests
npm run test:grammar

# Watch for changes
npm run dev
```

## Grammar Testing

The parser includes comprehensive grammar tests:

```bash
# Test specific query patterns
npm run test:grammar -- --pattern="correlation"

# Test error handling
npm run test:grammar -- --pattern="errors"

# Generate test coverage
npm run test:coverage
```

## Complete Example

```javascript
const { TimeQLParser } = require("@timebridge/query-parser");
const { TimeQLExecutor } = require("@timebridge/core");

const parser = new TimeQLParser();
const executor = new TimeQLExecutor();

// Complex multi-source query
const complexQuery = `
  graylog(service:frontend AND level:error)[10m]
    and on(trace_id) within(30s)
  loki({service="backend"})[10m]
    and on(trace_id)
  prometheus(http_requests_total{status="500"})[10m]
    and on(trace_id)
  influxdb(SELECT * FROM api_latency WHERE p99 > 1000)[10m]
`;

// Parse and validate
const validation = parser.validate(complexQuery);
console.log("Query valid:", validation.valid);

if (validation.valid) {
  const metadata = parser.getQueryMetadata(complexQuery);
  console.log("Query type:", metadata.type);
  console.log("Data sources:", metadata.sources);

  // Execute with TimeBridge
  for await (const correlation of executor.execute(complexQuery)) {
    console.log(`Found correlation: ${correlation.correlationId}`);
    console.log(`Events: ${correlation.events.length}`);
  }
}
```

## License

AGPLv3
