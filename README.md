# TimeBridge

**Bridging Observability Data Across Time**

A TypeScript npm package that enables real-time correlation of observability data - logs, metrics, and time-series - from multiple sources using TimeQL, a unified time-focused query language.

## Features

- **Smart Query Execution**: Automatically detects and routes direct vs correlation queries
- **Multi-Instance Support**: Register multiple instances of the same adapter type (e.g., prod, staging, dev)
- **Real-time Stream Processing**: Handle live log streams from multiple sources simultaneously
- **TimeQL Query Language**: Time-focused query language for correlating observability data
- **Native Query Parsers**: Built-in LogQL, PromQL, and InfluxQL parsers with full validation
- **Multiple Data Sources**: Built-in adapters for logs (Loki, Graylog), metrics (Prometheus), and time-series (InfluxDB)
- **SOCKS Proxy Support**: Connect through SOCKS4/SOCKS5 proxies for secure network environments
- **JavaScript-First API**: Easy consumption from vanilla JavaScript/Node.js
- **Memory Efficient**: Bounded buffers with configurable time windows
- **Electron Compatible**: Designed for integration with Electron applications
- **TypeScript Support**: Full type definitions for all query results

## Installation

> ⚠️ **Pre-release Software**: This is version 0.0.7 - API may change significantly before 1.0.0

```bash
npm install @timebridge/core@^0.0.7

# Log Adapters
npm install @timebridge/loki@^0.0.7        # Loki logs
npm install @timebridge/graylog@^0.0.7     # Graylog logs

# Metrics Adapters
npm install @timebridge/prometheus@^0.0.7  # Prometheus metrics
npm install @timebridge/influxdb@^0.0.7    # InfluxDB time-series
```

## Quick Start

### Recommended: Smart Query Execution with TimeQLExecutor

The `TimeQLExecutor` automatically detects query types and routes them appropriately. This is the recommended way to use TimeBridge:

```javascript
const { TimeQLExecutor } = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");
const { LokiAdapter } = require("@timebridge/loki");
const { PrometheusAdapter } = require("@timebridge/prometheus");
const { InfluxDBAdapter } = require("@timebridge/influxdb");

// Create TimeQL executor with correlation settings
const executor = new TimeQLExecutor({
  timeWindow: 30000, // 30 second correlation window
  maxEvents: 10000, // Memory limit per stream
});

// Register adapters - use descriptive names for different instances
executor.addAdapter(
  "graylog-prod",
  new GraylogAdapter({
    url: "https://prod.graylog.com",
    apiToken: "prod-token",
    streamName: "production", // v0.0.7+: Filter by stream name
  })
);

executor.addAdapter(
  "graylog-staging",
  new GraylogAdapter({
    url: "https://staging.graylog.com",
    apiToken: "staging-token",
    streamName: "staging",
  })
);

executor.addAdapter(
  "loki-us",
  new LokiAdapter({
    url: "https://loki-us-east.example.com",
  })
);

// Example 1: Unified execute() method - automatically returns TimeQLResult
// The result has a type discriminator for type-safe processing
for await (const result of executor.execute("graylog-prod(level:error)[5m]")) {
  if (result.type === 'event') {
    // Direct query result - single log event
    const event = result.data;
    console.log(`[${event.timestamp}] ${event.message}`);
    console.log(`Labels:`, event.labels); // { level: "error", service: "api", ... }
    console.log(`Join Keys:`, event.joinKeys); // { request_id: "abc-123", ... }
  }
}

// Example 2: Correlation query - returns correlation results
const correlationQuery = `
  graylog-prod(service:api AND level:error)[5m]
    and on(request_id)
  graylog-staging(service:api)[5m]
`;

for await (const result of executor.execute(correlationQuery)) {
  if (result.type === 'correlation') {
    // Correlation query result - grouped related events
    const correlation = result.data;
    console.log(`Correlation found: ${correlation.correlationId}`);
    console.log(`Joined on: ${correlation.joinKey} = ${correlation.joinValue}`);
    console.log(
      `Time window: ${correlation.timeWindow.start} to ${correlation.timeWindow.end}`
    );
    console.log(`Events correlated: ${correlation.events.length}`);

    // Process each correlated event
    correlation.events.forEach((event) => {
      console.log(`  [${event.source}] ${event.timestamp}: ${event.message}`);
    });
  }
}
```

### Understanding Query Types

The TimeQLExecutor automatically detects the query type based on syntax:

#### Direct Queries

Return `TimeQLResult` objects with `type: 'event'` and `data: LogEvent`:

```javascript
// Simple direct query
"graylog-prod(level:error)[5m]"; // Graylog errors
"loki-us({service=\"api\", level=\"warn\"})[10m]"; // Loki warnings

// Returns TimeQLResult with type: 'event':
// {
//   type: 'event',
//   data: {
//     timestamp: "2025-01-15T14:30:00.000Z",
//     message: "Database connection failed",
//     source: "graylog-prod",
//     labels: { level: "error", service: "api" },
//     joinKeys: { request_id: "req-123", trace_id: "trace-456" }
//   }
// }
```

#### Correlation Queries

Return `TimeQLResult` objects with `type: 'correlation'` and `data: CorrelatedEvent`:

```javascript
// Correlation query with join operator
"graylog-prod(*)[5m] and on(request_id) graylog-staging(*)[5m]";

// Returns TimeQLResult with type: 'correlation':
// {
//   type: 'correlation',
//   data: {
//     correlationId: "corr-001",
//     joinKey: "request_id",
//     joinValue: "req-123",
//     events: [...],  // Array of correlated events
//     metadata: { completeness: "complete", matchedStreams: [...], totalStreams: 2 }
//   }
// }
```

### Query Validation and Type Guards

Always validate queries before execution for better error handling:

```javascript
// Validate a query
const validation = executor.validateQuery("graylog-prod(level:error)[5m]");

if (validation.valid) {
  console.log(`Query type: ${validation.type}`); // "direct" or "correlation"
  console.log(`Data sources: ${validation.sources}`); // ["graylog-prod"]

  // Execute using the unified method with type guards
  for await (const result of executor.execute(query)) {
    // Use type guards for type-safe processing
    if (result.type === 'event') {
      console.log('Single event:', result.data.message);
    } else if (result.type === 'correlation') {
      console.log('Correlated events:', result.data.events.length);
    }
  }
} else {
  console.error(`Invalid query: ${validation.error}`);
}
```

### Alternative: Specific Query Methods

For cases where you know the query type in advance, use specific methods:

```javascript
import { isEventResult, isCorrelationResult } from '@timebridge/core';

// When you know it's a direct query
for await (const event of executor.executeEvents("graylog-prod(level:error)[5m]")) {
  console.log(`Event: ${event.message}`);
}

// When you know it's a correlation query  
for await (const correlation of executor.executeCorrelation(correlationQuery)) {
  console.log(`Correlation: ${correlation.correlationId}`);
}

// Or use type guards with the unified method
for await (const result of executor.execute(anyQuery)) {
  if (isEventResult(result)) {
    // TypeScript knows result.data is LogEvent
    console.log(result.data.message);
  } else if (isCorrelationResult(result)) {
    // TypeScript knows result.data is CorrelatedEvent
    console.log(result.data.correlationId);
  }
}
```

## Advanced Usage

### Multiple Named Instances

Register multiple instances of the same adapter type for different environments:

```javascript
const executor = new TimeQLExecutor();

// Register multiple Graylog instances
executor.addAdapter(
  "graylog",
  new GraylogAdapter({
    url: "https://default.graylog.com",
  }),
  { isDefault: true }
); // This responds to "graylog" queries

executor.addAdapter(
  "graylog-prod",
  new GraylogAdapter({
    url: "https://prod.graylog.com",
  })
);

executor.addAdapter(
  "graylog-dev",
  new GraylogAdapter({
    url: "http://localhost:9000",
  })
);

// Queries automatically route to the right adapter
("graylog(level:error)[5m]"); // Uses default adapter
("graylog-prod(level:error)[5m]"); // Uses prod adapter
("graylog-dev(level:error)[5m]"); // Uses dev adapter
```

### Cross-Platform Correlation

Correlate logs between different logging systems using the new unified API:

```javascript
// Correlate Graylog and Loki logs
const crossPlatformQuery = `
  graylog-prod(application:frontend)[10m]
    and on(trace_id)
  loki-us({service="api"})[10m]
`;

// Method 1: Use unified execute() with type discrimination
for await (const result of executor.execute(crossPlatformQuery)) {
  if (result.type === 'correlation') {
    const correlation = result.data;
    console.log(`Found ${correlation.events.length} correlated events`);

    const graylogEvents = correlation.events.filter((e) =>
      e.source.startsWith("graylog")
    );
    const lokiEvents = correlation.events.filter((e) =>
      e.source.startsWith("loki")
    );

    console.log(`Graylog events: ${graylogEvents.length}`);
    console.log(`Loki events: ${lokiEvents.length}`);
  }
}

// Method 2: Use specific correlation method
for await (const correlation of executor.executeCorrelation(crossPlatformQuery)) {
  // Directly returns CorrelatedEvent objects
  console.log(`Found ${correlation.events.length} correlated events`);
  
  const graylogEvents = correlation.events.filter((e) =>
    e.source.startsWith("graylog")
  );
  const lokiEvents = correlation.events.filter((e) =>
    e.source.startsWith("loki")
  );

  console.log(`Graylog events: ${graylogEvents.length}`);
  console.log(`Loki events: ${lokiEvents.length}`);
}
```

### Three-Way Correlation

Correlate across three or more data sources with type guards:

```javascript
import { isCorrelationResult } from '@timebridge/core';

const multiCorrelation = `
  graylog-dev(feature:experimental)[1h]
    and on(feature_flag_id)
  graylog-staging(feature:experimental)[1h]
    and on(feature_flag_id)
  graylog-prod(feature:experimental)[1h]
`;

// Using type guard for type safety
for await (const result of executor.execute(multiCorrelation)) {
  if (isCorrelationResult(result)) {
    // TypeScript knows result.data is CorrelatedEvent
    const correlation = result.data;
    console.log(
      `Feature flag ${correlation.joinValue} found in ${correlation.metadata.matchedStreams.length} environments`
    );
  }
}

// Or use specific method when you know it's a correlation
for await (const correlation of executor.executeCorrelation(multiCorrelation)) {
  console.log(
    `Feature flag ${correlation.joinValue} found in ${correlation.metadata.matchedStreams.length} environments`
  );
}
```

### Type Safety with TypeScript

```typescript
import { 
  TimeQLExecutor, 
  TimeQLResult,
  LogEvent, 
  CorrelatedEvent,
  isEventResult,
  isCorrelationResult 
} from "@timebridge/core";

async function processResults(executor: TimeQLExecutor, query: string) {
  const validation = executor.validateQuery(query);

  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Method 1: Use the unified execute() with type discrimination
  for await (const result of executor.execute(query)) {
    if (result.type === 'event') {
      // TypeScript knows result.data is LogEvent
      console.log('Direct query result:', result.data.timestamp, result.data.message);
    } else if (result.type === 'correlation') {
      // TypeScript knows result.data is CorrelatedEvent
      console.log('Correlation result:', result.data.correlationId, result.data.events.length);
    }
  }

  // Method 2: Use type guards for even better type safety
  for await (const result of executor.execute(query)) {
    if (isEventResult(result)) {
      // result.data is strongly typed as LogEvent
      console.log(result.data.message);
    } else if (isCorrelationResult(result)) {
      // result.data is strongly typed as CorrelatedEvent
      console.log(result.data.correlationId);
    }
  }

  // Method 3: Use specific methods when query type is known
  if (validation.type === "direct") {
    for await (const event of executor.executeEvents(query)) {
      // Directly returns LogEvent objects
      console.log(event.timestamp, event.message);
    }
  } else {
    for await (const correlation of executor.executeCorrelation(query)) {
      // Directly returns CorrelatedEvent objects
      console.log(correlation.correlationId, correlation.events.length);
    }
  }
}
```

## Query Language Reference

### Basic Query Structure

```
SOURCE(SELECTOR)[TIME_RANGE] [JOIN_OPERATOR SOURCE(SELECTOR)[TIME_RANGE]]*
```

- **SOURCE**: Adapter name (e.g., `graylog`, `graylog-prod`, `loki-us`)
- **SELECTOR**: Query syntax specific to the data source
- **TIME_RANGE**: Time window (e.g., `5m`, `1h`, `30s`)
- **JOIN_OPERATOR**: Correlation operator (`and on`, `or on`, `unless on`)

### Direct Query Examples

```javascript
// Graylog direct queries
"graylog(level:error)[5m]";
"graylog-prod(service:api AND level:error)[10m]";
"graylog(message:\"failed to process\" AND status:[500 TO 599])[1h]";

// Loki direct queries
"loki({job=\"nginx\"})[5m]";
"loki-us({service=\"api\", level=\"error\"})[10m]";
"loki({namespace=\"production\"} |~ \"error|Error|ERROR\")[30m]";
```

### Correlation Query Examples

#### Inner Join (AND)

Find events that exist in both streams:

```javascript
`graylog-prod(service:frontend)[5m]
  and on(request_id)
 graylog-prod(service:backend)[5m]`;
```

#### Left Join (OR)

Include all events from the left stream, with matching events from the right:

```javascript
`graylog(service:payment)[10m]
  or on(transaction_id)
 graylog(service:notification)[10m]`;
```

#### Anti-Join (UNLESS)

Events from the left stream that have no match in the right:

```javascript
`loki({service=\"api\"})[5m]
  unless on(request_id)
 loki({service=\"database\"})[5m]`;
```

#### Temporal Join

Events must occur within a specific time window:

```javascript
`graylog(service:frontend)[5m]
  and on(session_id) within(30s)
 graylog(service:backend)[5m]`;
```

## Graylog-Specific Features

### Historical vs Continuous Queries (v0.0.8+)

By default, Graylog queries now fetch historical data once (like PromQL/LogQL):

```javascript
const adapter = new GraylogAdapter({
  url: "http://graylog:9000",
  apiToken: "token",
  maxResults: 5000, // New: limit results per query (default: 10000)
});

// Default behavior: historical snapshot
for await (const result of executor.execute("graylog(level:error)[5m]")) {
  // Fetches last 5 minutes of data once and completes
  // Perfect for correlation queries and analysis
}

// For real-time monitoring: explicit continuous mode
for await (const result of executor.execute(
  "graylog(level:error)[5m]", 
  { continuous: true }
)) {
  // Polls continuously for new data
  // Use for live monitoring and alerting
}
```

### Stream Filtering (v0.0.7+)

Filter logs by human-readable stream names:

```javascript
const adapter = new GraylogAdapter({
  url: "http://graylog:9000",
  apiToken: "token",
  streamName: "Production Logs", // Filter by stream name instead of ID
  maxResults: 5000, // Limit results for better performance
});
```

### Graylog Query Syntax

```javascript
// Field queries
"graylog(level:error)[5m]";
"graylog(service:api AND level:error)[5m]";

// Wildcard queries
"graylog(message:failed*)[5m]";
"graylog(service:api-*)[5m]";

// Range queries
"graylog(status:[400 TO 499])[5m]";
"graylog(response_time:>1000)[5m]";

// Complex queries
"graylog(level:error AND service:api AND _exists_:request_id)[5m]";
```

## Loki-Specific Features

### LogQL Parser

Full LogQL parser with validation and AST manipulation:

```javascript
const { LogQLParser } = require('@timebridge/loki');

const parser = new LogQLParser();

// Parse and validate LogQL queries
const result = parser.parse('{job="nginx"} |= "error" | json | status >= 400');
if (result.valid) {
  console.log('AST:', result.ast);
  console.log('Query type:', parser.getQueryType(result.ast)); // 'log' or 'metric'
}

// Validate queries before execution
const validation = parser.validate(query);
if (validation.valid) {
  // Query is syntactically and semantically valid
}
```

### LogQL Support

```javascript
// Label matchers
"loki({job=\"nginx\", level=\"error\"})[5m]";

// Regex matchers
"loki({service=~\"api.*\", level!=\"debug\"})[5m]";

// Line filters
"loki({job=\"nginx\"} |= \"error\")[5m]";
"loki({app=\"api\"} |~ \"failed|error|Error\")[5m]";

// JSON parsing
"loki({job=\"nginx\"} | json)[5m]";

// Pattern parsing
"loki({job=\"nginx\"} | pattern \"<ip> <method> <path>\" | method=\"GET\")[5m]";

// Metric queries
"loki(rate({job=\"nginx\"}[5m]))[10m]";
"loki(count_over_time({job=\"nginx\"} |= \"error\" [5m]))[10m]";
```

## SOCKS Proxy Configuration

All adapters support connecting through SOCKS4/SOCKS5 proxies:

```javascript
const adapter = new GraylogAdapter({
  url: "http://graylog.internal:9000",
  apiToken: "token",
  proxy: {
    host: "127.0.0.1",
    port: 1080,
    type: 5, // SOCKS5 (use 4 for SOCKS4)
    username: "proxyuser", // Optional
    password: "proxypass", // Optional
  },
});
```

## Metrics and Time-Series Correlation

The library now supports correlating metrics and time-series data alongside logs, enabling powerful observability workflows.

### Prometheus Integration

```javascript
const { PromQLParser } = require('@timebridge/prometheus');

// Register Prometheus adapter
executor.addAdapter(
  "prometheus",
  new PrometheusAdapter({
    url: "http://prometheus:9090",
    apiToken: "bearer-token",
  })
);

// Use the built-in PromQL parser
const parser = new PromQLParser();
const result = parser.parse('sum(rate(http_requests_total[5m])) by (status)');
if (result.valid) {
  console.log('AST:', result.ast);
  // Manipulate AST if needed
  const modified = parser.stringify(result.ast);
}

// Query metrics directly
for await (const metric of executor.execute('prometheus(up{job="api"})[5m]')) {
  console.log(`${metric.labels.instance}: ${metric.labels.__value__}`);
}

// Correlate metrics with logs
const errorCorrelation = `
  prometheus(http_requests_total{status="500"})[10m]
    and on(request_id)
  graylog(level:error AND service:api)[10m]
`;

for await (const correlation of executor.execute(errorCorrelation)) {
  console.log(`HTTP 500 correlated with error log: ${correlation.joinValue}`);
}
```

### InfluxDB Integration

```javascript
const { InfluxQLParser } = require('@timebridge/influxdb');

// Register InfluxDB adapter
executor.addAdapter(
  "influxdb",
  new InfluxDBAdapter({
    url: "http://influxdb:8086",
    database: "metrics", // For 1.x
    version: "1.x",
  })
);

// Use the built-in InfluxQL parser
const parser = new InfluxQLParser();
const result = parser.parse('SELECT mean("value") FROM "cpu" WHERE time > now() - 1h GROUP BY time(5m)');
if (result.valid) {
  console.log('AST:', result.ast);
  // Query is valid InfluxQL
}

// Query time-series data
for await (const point of executor.execute("influxdb(SELECT * FROM cpu)[5m]")) {
  console.log(`CPU usage: ${point.message}`);
}

// Correlate database metrics with application logs
const dbCorrelation = `
  influxdb(SELECT * FROM db_query WHERE duration > 1000)[5m]
    and on(request_id)
  loki({service="api"} |= "timeout")[5m]
`;
```

### Cross-Platform Observability

Combine logs, metrics, and time-series for complete observability:

```javascript
// Three-way correlation: metrics, time-series, and logs
const fullStackCorrelation = `
  prometheus(http_request_duration_seconds{quantile="0.99"})[10m]
    and on(trace_id)
  influxdb(SELECT * FROM database_queries WHERE latency > 100)[10m]
    and on(trace_id)
  graylog(level:error OR level:warn)[10m]
`;

for await (const correlation of executor.execute(fullStackCorrelation)) {
  console.log(`Performance issue detected across stack:`);
  console.log(`  Trace ID: ${correlation.joinValue}`);
  console.log(`  Sources: ${correlation.metadata.matchedStreams.join(", ")}`);
  console.log(
    `  Time window: ${correlation.timeWindow.start} to ${correlation.timeWindow.end}`
  );
}
```

### Use Cases

1. **SLO Monitoring**: Correlate SLI metrics with error logs
2. **Performance Analysis**: Link slow database queries with API timeouts
3. **Incident Investigation**: Trace issues across metrics, logs, and time-series
4. **Capacity Planning**: Correlate resource metrics with application behavior
5. **Cost Optimization**: Link cloud metrics with application usage patterns

## Type Reference

The library now uses a unified result type system with clear type discrimination:

### TimeQLResult (Unified Result Type)

```typescript
interface TimeQLResult {
  type: 'event' | 'correlation';
  data: LogEvent | CorrelatedEvent;
}

// Type guards for safe type narrowing
function isEventResult(result: TimeQLResult): result is TimeQLResult & { 
  type: 'event'; 
  data: LogEvent 
} {
  return result.type === 'event';
}

function isCorrelationResult(result: TimeQLResult): result is TimeQLResult & { 
  type: 'correlation'; 
  data: CorrelatedEvent 
} {
  return result.type === 'correlation';
}
```

### LogEvent (Direct Query Data)

```typescript
interface LogEvent {
  timestamp: string; // ISO 8601 timestamp
  source: string; // Data source identifier
  stream?: string; // Optional stream/channel
  message: string; // Log message content
  labels: Record<string, string>; // Metadata key-value pairs
  joinKeys?: Record<string, string>; // Correlation identifiers
}
```

### CorrelatedEvent (Correlation Query Data)

```typescript
interface CorrelatedEvent {
  correlationId: string; // Unique correlation ID
  timestamp: string; // When correlation was performed
  timeWindow: {
    start: string; // Earliest event
    end: string; // Latest event
  };
  joinKey: string; // Field used for correlation
  joinValue: string; // Value that matched
  events: Array<{
    // Correlated events
    alias?: string;
    source: string;
    timestamp: string;
    message: string;
    labels: Record<string, string>;
  }>;
  metadata: {
    completeness: "complete" | "partial";
    matchedStreams: string[];
    totalStreams: number;
  };
}
```

### Migration from Previous Versions

The unified API simplifies result handling while maintaining full type safety:

```typescript
// Before (v0.0.7 and earlier)
for await (const result of executor.execute(query)) {
  // result was directly LogEvent or CorrelatedEvent
  if ('correlationId' in result) {
    // Handle correlation
  } else {
    // Handle event
  }
}

// After (v0.0.8+)
for await (const result of executor.execute(query)) {
  // result is always TimeQLResult with clear type discrimination
  if (result.type === 'event') {
    // result.data is LogEvent
  } else if (result.type === 'correlation') {
    // result.data is CorrelatedEvent  
  }
}
```

For complete type documentation, see [Type Reference Guide](./docs/TYPE_REFERENCE.md).

## Examples

### Error Analysis Across Environments

```javascript
const executor = new TimeQLExecutor();

// Register environments
executor.addAdapter("graylog-prod", prodAdapter);
executor.addAdapter("graylog-staging", stagingAdapter);

// Find errors that exist in prod but not staging
const query = `
  graylog-prod(level:error)[1h]
    unless on(error_hash)
  graylog-staging(level:error)[1h]
`;

// Using unified API with type discrimination
for await (const result of executor.execute(query)) {
  if (result.type === 'correlation') {
    // Unless queries still return correlations (with missing events)
    const correlation = result.data;
    console.log("Production-only error analysis:", correlation.events.length);
  } else if (result.type === 'event') {
    // Individual uncorrelated events
    const event = result.data;
    console.log("Production-only error:", event.message);
    // Alert on errors not caught in staging
  }
}

// Alternative: Use specific method if you know the query type
for await (const correlation of executor.executeCorrelation(query)) {
  // Direct access to correlation results
  console.log("Production-only errors:", correlation.events.length);
}
```

### Request Tracing

```javascript
import { isCorrelationResult } from '@timebridge/core';

// Trace a request across all services
const traceQuery = `
  graylog(service:gateway AND trace_id:${traceId})[10m]
    and on(trace_id)
  graylog(service:auth AND trace_id:${traceId})[10m]
    and on(trace_id)
  graylog(service:api AND trace_id:${traceId})[10m]
    and on(trace_id)
  graylog(service:database AND trace_id:${traceId})[10m]
`;

// Method 1: Use type guard for type safety
for await (const result of executor.execute(traceQuery)) {
  if (isCorrelationResult(result)) {
    // TypeScript knows result.data is CorrelatedEvent
    const correlation = result.data;
    const services = correlation.events.map((e) => e.labels.service);
    const duration =
      new Date(correlation.timeWindow.end) -
      new Date(correlation.timeWindow.start);
    console.log(`Request touched ${services.length} services in ${duration}ms`);
  }
}

// Method 2: Use specific method when you know it's a correlation
for await (const correlation of executor.executeCorrelation(traceQuery)) {
  // Direct access to CorrelatedEvent
  const services = correlation.events.map((e) => e.labels.service);
  const duration =
    new Date(correlation.timeWindow.end) -
    new Date(correlation.timeWindow.start);
  console.log(`Request touched ${services.length} services in ${duration}ms`);
}
```

### Performance Monitoring

```javascript
// Correlate slow queries with API timeouts
const perfQuery = `
  graylog(service:database AND query_time:>1000)[5m]
    and on(request_id)
  graylog(service:api AND message:"timeout")[5m]
`;

// Method 1: Check result type explicitly
for await (const result of executor.execute(perfQuery)) {
  if (result.type === 'correlation') {
    const correlation = result.data;
    const dbEvent = correlation.events.find(
      (e) => e.labels.service === "database"
    );
    const apiEvent = correlation.events.find((e) => e.labels.service === "api");

    console.log(`Slow query caused timeout:`);
    console.log(`  Query time: ${dbEvent?.labels.query_time}ms`);
    console.log(`  API timeout: ${apiEvent?.message}`);
  }
}

// Method 2: Use executeCorrelation for cleaner code
for await (const correlation of executor.executeCorrelation(perfQuery)) {
  const dbEvent = correlation.events.find(
    (e) => e.labels.service === "database"
  );
  const apiEvent = correlation.events.find((e) => e.labels.service === "api");

  console.log(`Slow query caused timeout:`);
  console.log(`  Query time: ${dbEvent?.labels.query_time}ms`);
  console.log(`  API timeout: ${apiEvent?.message}`);
}
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm run test

# Run integration tests
npm run test:integration

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Documentation

- [Type Reference Guide](./docs/TYPE_REFERENCE.md) - Complete type documentation
- [Architecture Overview](./docs/architecture-multi-source.md) - System design and patterns
- [Unified Testing Guide](./packages/TESTING_GUIDE.md) - Comprehensive testing strategies for all parsers
- [Project Rename Proposal](./PROJECT_RENAME_PROPOSAL.md) - Future naming considerations

### Adapter Documentation

- [Graylog Adapter](./packages/adapters/graylog/README.md) - Graylog logs
- [Loki Adapter](./packages/adapters/loki/README.md) - Loki logs with LogQL parser
- [Prometheus Adapter](./packages/adapters/prometheus/README.md) - Prometheus metrics with PromQL parser
- [InfluxDB Adapter](./packages/adapters/influxdb/README.md) - InfluxDB time-series with InfluxQL parser
- [Query Parser](./packages/query-parser/README.md) - TimeQL grammar for correlation queries

### Parser Documentation

Each adapter includes a native query parser with full validation:

- **LogQL Parser** - Complete Loki query language support with AST manipulation
- **PromQL Parser** - Full Prometheus query validation and type checking
- **InfluxQL Parser** - SQL-like query parser for InfluxDB 1.x and 2.x

## Migration Guide

### From v0.0.7 to v0.0.8

Major API changes for better type safety and simplified usage:

#### 1. Unified Result Type

```javascript
// Before (v0.0.7)
for await (const result of executor.execute(query)) {
  // result was either LogEvent or CorrelatedEvent
  if ('correlationId' in result) {
    // Correlation result
  } else {
    // Event result
  }
}

// After (v0.0.8)
for await (const result of executor.execute(query)) {
  // result is always TimeQLResult with type discriminator
  if (result.type === 'event') {
    const event = result.data; // LogEvent
  } else if (result.type === 'correlation') {
    const correlation = result.data; // CorrelatedEvent
  }
}
```

#### 2. New Type Guards

```javascript
import { isEventResult, isCorrelationResult } from '@timebridge/core';

for await (const result of executor.execute(query)) {
  if (isEventResult(result)) {
    // TypeScript knows result.data is LogEvent
    console.log(result.data.message);
  } else if (isCorrelationResult(result)) {
    // TypeScript knows result.data is CorrelatedEvent
    console.log(result.data.correlationId);
  }
}
```

#### 3. Specific Query Methods

```javascript
// New methods for when you know the query type
for await (const event of executor.executeEvents(directQuery)) {
  // Directly returns LogEvent objects
}

for await (const correlation of executor.executeCorrelation(correlationQuery)) {
  // Directly returns CorrelatedEvent objects
}
```

#### 4. Graylog Adapter Changes

```javascript
// Historical queries (default) - fetch once and complete
const adapter = new GraylogAdapter({
  url: "http://graylog.example.com",
  apiToken: "token",
  maxResults: 5000, // New option, defaults to 10000
});

// For continuous polling (real-time monitoring)
for await (const result of executor.execute("graylog(*)[5m]", { continuous: true })) {
  // Polls continuously
}

// Default behavior - historical snapshots
for await (const result of executor.execute("graylog(*)[5m]")) {
  // Fetches once and completes
}
```

## License

AGPLv3
