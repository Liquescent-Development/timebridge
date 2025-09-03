# TimeBridge Core

The core engine for TimeBridge, providing unified observability data correlation with the TimeQLExecutor for smart query handling and TimeBridgeEngine for correlation processing.

## Installation

```bash
npm install @timebridge/core@^0.0.7
```

## Features

- **TimeQLExecutor**: Smart query execution with automatic detection of direct vs correlation queries
- **TimeBridgeEngine**: Advanced correlation engine for multi-source data joining
- **Real-time Processing**: Stream-based architecture with AsyncIterables
- **Memory Efficient**: Bounded buffers with configurable time windows and event limits
- **Multi-Instance Support**: Register multiple adapters with descriptive names
- **Type Safety**: Full TypeScript support with comprehensive type definitions
- **Performance Monitoring**: Built-in performance tracking and optimization
- **Back-pressure Handling**: Automatic flow control for high-volume data streams

## Quick Start

### Recommended: TimeQLExecutor (Smart Query Handling)

The `TimeQLExecutor` automatically detects whether you're making a direct query or correlation query:

```javascript
const { TimeQLExecutor } = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");
const { LokiAdapter } = require("@timebridge/loki");

// Create executor with correlation settings
const executor = new TimeQLExecutor({
  timeWindow: 30000, // 30 second correlation window
  maxEvents: 10000, // Memory limit per stream
  enablePerformanceMonitoring: true,
});

// Register data source adapters
executor.addAdapter(
  "graylog-prod",
  new GraylogAdapter({
    url: "https://prod.graylog.com",
    apiToken: "prod-token",
    streamName: "production",
  })
);

executor.addAdapter(
  "loki-us",
  new LokiAdapter({
    url: "https://loki-us-east.example.com",
  })
);

// Direct query - returns LogEvent objects
for await (const event of executor.execute("graylog-prod(level:error)[5m]")) {
  console.log(`[${event.timestamp}] ${event.message}`);
  console.log(`Join keys:`, event.joinKeys);
}

// Correlation query - returns CorrelatedEvent objects
const correlationQuery = `
  graylog-prod(service:api AND level:error)[5m]
    and on(request_id)
  loki-us({service="api"})[5m]
`;

for await (const correlation of executor.execute(correlationQuery)) {
  console.log(`Correlation: ${correlation.correlationId}`);
  console.log(
    `Joined ${correlation.events.length} events on ${correlation.joinKey}=${correlation.joinValue}`
  );
}
```

### Advanced: TimeBridgeEngine (Correlation Only)

For correlation-specific use cases, use the TimeBridgeEngine directly:

```javascript
const { TimeBridgeEngine } = require("@timebridge/core");

const engine = new TimeBridgeEngine({
  timeWindow: 30000,
  maxEvents: 10000,
  enableDuplicateDetection: true,
});

engine.addAdapter("graylog", graylogAdapter);
engine.addAdapter("loki", lokiAdapter);

// Correlation query only
const query = `
  graylog(service:api AND level:error)[5m]
    and on(request_id)
  loki({service="api"})[5m]
`;

for await (const event of engine.correlate(query)) {
  console.log("Correlated event:", event);
}
```

## Core Components

### TimeQLExecutor

The main interface for TimeBridge, providing intelligent query routing:

```javascript
const executor = new TimeQLExecutor({
  timeWindow: 30000, // Correlation window (ms)
  maxEvents: 10000, // Max events per stream
  enablePerformanceMonitoring: true,
  enableDuplicateDetection: true,
  backPressureThreshold: 1000,
});

// Add adapters with optional configuration
executor.addAdapter("source-name", adapter, {
  isDefault: false, // Make this the default for its type
  alias: "custom-alias",
});

// Query validation
const validation = executor.validateQuery("graylog(level:error)[5m]");
if (validation.valid) {
  console.log(`Query type: ${validation.type}`);
  console.log(`Data sources: ${validation.sources}`);
}

// Get adapter information
const adapters = executor.getAdapterInfo();
console.log(adapters); // [{ name, baseType, isDefault }]
```

### TimeBridgeEngine

The correlation engine for advanced use cases:

```javascript
const engine = new TimeBridgeEngine({
  timeWindow: 30000,
  maxEvents: 10000,
  parallelStreams: true,
  enableIndexing: true,
});

// Multi-stream correlation
const threeWayQuery = `
  sourceA(query)[10m]
    and on(trace_id)
  sourceB(query)[10m]
    and on(trace_id)
  sourceC(query)[10m]
`;

for await (const correlation of engine.correlate(threeWayQuery)) {
  console.log(`Three-way correlation: ${correlation.events.length} events`);
}
```

## Configuration Options

### TimeQLExecutor Options

| Option                        | Type    | Default | Description                  |
| ----------------------------- | ------- | ------- | ---------------------------- |
| `timeWindow`                  | number  | 30000   | Correlation time window (ms) |
| `maxEvents`                   | number  | 10000   | Maximum events per stream    |
| `enablePerformanceMonitoring` | boolean | false   | Track query performance      |
| `enableDuplicateDetection`    | boolean | true    | Remove duplicate events      |
| `backPressureThreshold`       | number  | 1000    | Back-pressure trigger point  |
| `queryTimeout`                | number  | 60000   | Query timeout (ms)           |

### TimeBridgeEngine Options

| Option                     | Type    | Default | Description                         |
| -------------------------- | ------- | ------- | ----------------------------------- |
| `timeWindow`               | number  | 30000   | Correlation time window (ms)        |
| `maxEvents`                | number  | 10000   | Maximum events per stream           |
| `parallelStreams`          | boolean | true    | Enable parallel processing          |
| `enableIndexing`           | boolean | true    | Use indexed event storage           |
| `indexingStrategy`         | string  | 'hash'  | Indexing strategy ('hash', 'btree') |
| `enableDuplicateDetection` | boolean | true    | Remove duplicate events             |

## Query Language Support

### Direct Queries

Query a single data source:

```javascript
// Graylog
executor.execute("graylog(level:error)[5m]");
executor.execute("graylog-prod(service:api AND status:500)[10m]");

// Loki
executor.execute('loki({job="nginx", level="error"})[5m]');
executor.execute('loki-us({service="api"} |~ "timeout")[10m]');

// Prometheus
executor.execute('prometheus(up{job="api"})[5m]');

// InfluxDB
executor.execute("influxdb(SELECT * FROM cpu WHERE usage > 90)[5m]");
```

### Correlation Queries

Join data across multiple sources:

```javascript
// Inner join (and)
"sourceA(query)[5m] and on(request_id) sourceB(query)[5m]";

// Left join (or)
"sourceA(query)[5m] or on(trace_id) sourceB(query)[5m]";

// Anti-join (unless)
"sourceA(query)[5m] unless on(session_id) sourceB(query)[5m]";

// Temporal correlation
"sourceA(query)[5m] and on(id) within(30s) sourceB(query)[5m]";

// Multi-field correlation
"sourceA(query)[5m] and on(req_id, trace_id) sourceB(query)[5m]";
```

## Event Types

### LogEvent (Direct Queries)

```typescript
interface LogEvent {
  timestamp: string; // ISO 8601 timestamp
  source: string; // Data source identifier
  stream?: string; // Optional stream name
  message: string; // Log message content
  labels: Record<string, string>; // Metadata key-value pairs
  joinKeys?: Record<string, string>; // Correlation identifiers
}
```

### CorrelatedEvent (Correlation Queries)

```typescript
interface CorrelatedEvent {
  correlationId: string; // Unique correlation ID
  timestamp: string; // Correlation timestamp
  timeWindow: {
    start: string; // Earliest event
    end: string; // Latest event
  };
  joinKey: string; // Correlation field
  joinValue: string; // Matched value
  events: Array<{
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

## Performance Monitoring

Enable performance monitoring to track query execution:

```javascript
const executor = new TimeQLExecutor({
  enablePerformanceMonitoring: true,
});

// Performance data is logged automatically
// Access via internal performance monitor:
const stats = executor._performanceMonitor?.getStats();
console.log(`Queries processed: ${stats?.queriesProcessed}`);
console.log(`Average query time: ${stats?.averageQueryTime}ms`);
```

## Memory Management

The core engine includes sophisticated memory management:

```javascript
const executor = new TimeQLExecutor({
  maxEvents: 5000, // Events per stream
  backPressureThreshold: 1000, // Trigger flow control
  enableDuplicateDetection: true, // Remove duplicates
});

// Memory usage is automatically controlled
// Large result sets are streamed efficiently
// Back-pressure prevents memory exhaustion
```

## Error Handling

```javascript
try {
  for await (const result of executor.execute(query)) {
    // Process results
  }
} catch (error) {
  if (error.code === "QUERY_VALIDATION_ERROR") {
    console.error("Invalid query:", error.message);
  } else if (error.code === "ADAPTER_CONNECTION_ERROR") {
    console.error("Connection failed:", error.details);
  } else if (error.code === "CORRELATION_TIMEOUT") {
    console.error("Query timed out:", error.timeout);
  }
}
```

## Multi-Instance Patterns

Register multiple instances of the same adapter type:

```javascript
const executor = new TimeQLExecutor();

// Register multiple environments
executor.addAdapter("graylog", defaultGraylogAdapter, { isDefault: true });
executor.addAdapter("graylog-prod", prodGraylogAdapter);
executor.addAdapter("graylog-staging", stagingGraylogAdapter);
executor.addAdapter("graylog-dev", devGraylogAdapter);

// Queries route automatically
executor.execute("graylog(level:error)[5m]"); // Uses default
executor.execute("graylog-prod(level:error)[5m]"); // Uses prod
executor.execute("graylog-staging(level:error)[5m]"); // Uses staging
```

## Advanced Correlation Examples

### Cross-Environment Error Analysis

```javascript
// Find errors that exist in production but not staging
const prodOnlyErrors = `
  graylog-prod(level:error)[1h]
    unless on(error_hash)
  graylog-staging(level:error)[1h]
`;

for await (const event of executor.execute(prodOnlyErrors)) {
  console.log("Production-only error:", event.message);
}
```

### Multi-Service Request Tracing

```javascript
// Trace a request across all services
const fullTrace = `
  graylog(service:gateway)[10m]
    and on(trace_id)
  graylog(service:auth)[10m]
    and on(trace_id)
  graylog(service:api)[10m]
    and on(trace_id)
  graylog(service:database)[10m]
`;

for await (const correlation of executor.execute(fullTrace)) {
  const duration =
    new Date(correlation.timeWindow.end) -
    new Date(correlation.timeWindow.start);
  console.log(`Request ${correlation.joinValue} took ${duration}ms`);
}
```

### Performance Issue Correlation

```javascript
// Correlate slow database queries with API timeouts
const perfIssues = `
  influxdb(SELECT * FROM db_queries WHERE latency > 1000)[5m]
    and on(request_id)
  graylog(service:api AND message:"timeout")[5m]
`;

for await (const correlation of executor.execute(perfIssues)) {
  console.log("Performance issue detected:", correlation.joinValue);
}
```

## Integration with TimeBuddy

TimeBridge core is designed for seamless integration with TimeBuddy:

```javascript
// TimeBuddy-compatible event streaming
const stream = executor.execute("graylog(level:error)[5m]");

// Can be consumed by TimeBuddy components
await timeBuddy.processStream(stream, {
  visualizations: ["timeline", "heatmap"],
  alerting: true,
});
```

## TypeScript Usage

```typescript
import {
  TimeQLExecutor,
  TimeBridgeEngine,
  LogEvent,
  CorrelatedEvent,
  TimeQLExecutorOptions,
} from "@timebridge/core";

const options: TimeQLExecutorOptions = {
  timeWindow: 30000,
  maxEvents: 10000,
  enablePerformanceMonitoring: true,
};

const executor = new TimeQLExecutor(options);

// Type-safe query execution
async function processEvents(query: string) {
  const validation = executor.validateQuery(query);

  if (validation.type === "direct") {
    for await (const event of executor.execute(query)) {
      const logEvent = event as LogEvent;
      console.log(logEvent.timestamp, logEvent.message);
    }
  } else {
    for await (const correlation of executor.execute(query)) {
      const corrEvent = correlation as CorrelatedEvent;
      console.log(corrEvent.correlationId, corrEvent.events.length);
    }
  }
}
```

## Development

```bash
# Build the package
npm run build

# Run tests
npm test

# Run integration tests
npm run test:integration

# Type checking
npm run typecheck

# Performance benchmarks
npm run bench
```

## License

AGPLv3
