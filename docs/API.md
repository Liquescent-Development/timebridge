# API Documentation

## Table of Contents

- [Core Package](#core-package)
- [Query Parser](#query-parser)
- [Loki Adapter](#loki-adapter)
- [Graylog Adapter](#graylog-adapter)
- [Advanced Features](#advanced-features)

## Core Package

### CorrelationEngine

The main entry point for log correlation operations.

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
```

#### Constructor

```javascript
new CorrelationEngine(options?: CorrelationEngineOptions)
```

##### Options

| Parameter            | Type                     | Default | Description                                            |
| -------------------- | ------------------------ | ------- | ------------------------------------------------------ |
| `defaultTimeWindow`  | string                   | '5m'    | Default time window for correlations (PromQL duration) |
| `timeWindow`         | number                   | -       | Time window in milliseconds                            |
| `maxEvents`          | number                   | 10000   | Maximum events to keep in memory per window            |
| `lateTolerance`      | string\|number           | 30000   | How long to wait for late-arriving events              |
| `joinType`           | 'inner'\|'left'\|'outer' | 'inner' | Default join type                                      |
| `bufferSize`         | number                   | 1000    | Event buffer size                                      |
| `processingInterval` | string\|number           | 100     | How often to check for correlations                    |
| `maxMemoryMB`        | number                   | 100     | Maximum memory usage in MB                             |
| `gcInterval`         | string\|number           | 30000   | Garbage collection interval                            |

#### Methods

##### addAdapter(name: string, adapter: DataSourceAdapter): void

Register a data source adapter.

```javascript
engine.addAdapter(
  "loki",
  new LokiAdapter({
    url: "http://localhost:3100",
  })
);
```

##### correlate(query: string): AsyncGenerator<CorrelatedEvent>

Execute a correlation query and stream results.

```javascript
for await (const correlation of engine.correlate(query)) {
  console.log("Found correlation:", correlation);
}
```

##### validateQuery(query: string): boolean

Validate a query without executing it.

```javascript
if (engine.validateQuery(query)) {
  // Query is valid
}
```

##### destroy(): Promise<void>

Clean up resources and shut down the engine.

```javascript
await engine.destroy();
```

#### Events

The CorrelationEngine extends EventEmitter and emits the following events:

| Event                | Payload            | Description                                  |
| -------------------- | ------------------ | -------------------------------------------- |
| `correlationFound`   | CorrelatedEvent    | Emitted when a new correlation is discovered |
| `performanceMetrics` | PerformanceMetrics | Performance metrics update                   |
| `memoryWarning`      | { usedMB: number } | Memory usage exceeds threshold               |
| `adapterAdded`       | string             | New adapter registered                       |

### StreamJoiner

Handles the correlation logic between two streams.

```javascript
const { StreamJoiner } = require("@liquescent/log-correlator-core");
```

#### Constructor

```javascript
new StreamJoiner(options: StreamJoinerOptions)
```

##### Options

| Parameter       | Type     | Description                       |
| --------------- | -------- | --------------------------------- |
| `joinType`      | JoinType | Type of join operation            |
| `joinKeys`      | string[] | Keys to join on                   |
| `timeWindow`    | number   | Time window in milliseconds       |
| `lateTolerance` | number   | Late arrival tolerance            |
| `maxEvents`     | number   | Maximum events per window         |
| `temporal`      | string   | Temporal constraint (e.g., '30s') |
| `labelMappings` | Array    | Label mapping configuration       |
| `filter`        | string   | Post-join filter expression       |

### MultiStreamJoiner

Handles correlation between 3+ streams.

```javascript
const { MultiStreamJoiner } = require("@liquescent/log-correlator-core");
```

#### Methods

##### joinMultiple(streams: Array): AsyncGenerator<CorrelatedEvent>

Join multiple streams together.

```javascript
const streams = [
  { name: "frontend", stream: lokiStream1 },
  { name: "backend", stream: lokiStream2 },
  { name: "database", stream: graylogStream },
];

for await (const correlation of joiner.joinMultiple(streams)) {
  console.log("Multi-stream correlation:", correlation);
}
```

### Performance Optimization Classes

#### EventDeduplicator

Remove duplicate events from streams.

```javascript
const { EventDeduplicator } = require("@liquescent/log-correlator-core");

const dedup = new EventDeduplicator({
  windowSize: 60000, // 1 minute
  hashFields: ["timestamp", "message", "source"],
  maxCacheSize: 10000,
});

// Check single event
if (!dedup.isDuplicate(event)) {
  // Process unique event
}

// Deduplicate stream
for await (const event of dedup.deduplicate(stream)) {
  // All events here are unique
}
```

#### IndexedEventStore

High-performance indexed storage for join key lookups.

```javascript
const { IndexedEventStore } = require("@liquescent/log-correlator-core");

const store = new IndexedEventStore();

// Add events with indexing
store.addEvent(event, ["request_id", "session_id"]);

// O(1) lookup by join key
const events = store.getEventsByJoinKey("request_id", "abc123");

// Binary search for time range
const rangeEvents = store.getEventsByTimeRange(startTime, endTime);

// Find correlations between keys
const correlations = store.findCorrelations("request_id", "trace_id");
```

#### ParallelProcessor

Multi-core parallel processing coordinator.

```javascript
const { ParallelProcessor } = require("@liquescent/log-correlator-core");

const processor = new ParallelProcessor({
  maxWorkers: 4,
  taskQueueSize: 1000,
});

// Process windows in parallel
const results = await processor.processWindows(windows, async (window) => {
  return processWindow(window);
});

// Process streams in parallel
for await (const { name, event } of processor.processStreamsParallel(streams)) {
  console.log(`Event from ${name}:`, event);
}
```

#### BackpressureController

Manage flow control to prevent memory overflow.

```javascript
const { BackpressureController } = require("@liquescent/log-correlator-core");

const controller = new BackpressureController({
  highWaterMark: 1000,
  lowWaterMark: 500,
  maxBufferSize: 2000,
});

for await (const item of controller.controlFlow(source, processor)) {
  // Items are processed with backpressure control
}
```

## Query Parser

### PeggyQueryParser

Parse PromQL-style correlation queries.

```javascript
const { PeggyQueryParser } = require("@liquescent/log-correlator-query-parser");

const parser = new PeggyQueryParser();
```

#### Methods

##### parse(query: string): ParsedQuery

Parse a query string into a structured format.

```javascript
const parsed = parser.parse(`
  loki({service="frontend"})[5m]
    and on(request_id)
    loki({service="backend"})[5m]
`);

// Result:
{
  leftStream: { source: 'loki', selector: '{service="frontend"}', timeRange: '5m' },
  rightStream: { source: 'loki', selector: '{service="backend"}', timeRange: '5m' },
  joinType: 'and',
  joinKeys: ['request_id'],
  temporal: undefined,
  grouping: undefined,
  labelMappings: undefined,
  filter: undefined
}
```

##### validate(query: string): ValidationResult

Validate a query and get detailed information.

```javascript
const result = parser.validate(query);
if (result.valid) {
  console.log("Query details:", result.details);
} else {
  console.error("Parse error:", result.error);
}
```

##### getSuggestions(query: string, position: number): string[]

Get autocomplete suggestions at a cursor position.

```javascript
const suggestions = parser.getSuggestions(
  'loki({service="test"})[5m] and on(',
  35
);
// Returns: ['request_id', 'trace_id', 'session_id', ...]
```

##### formatQuery(query: string): string

Format a query with proper indentation.

```javascript
const formatted = parser.formatQuery(uglyQuery);
```

### QueryBuilder

Programmatically build queries.

```javascript
const { QueryBuilder } = require("@liquescent/log-correlator-query-parser");

const query = new QueryBuilder()
  .addStream("loki", '{service="frontend"}', "5m")
  .join("and", ["request_id"])
  .withTemporal("30s")
  .withGrouping("left", ["session_id"])
  .andStream("loki", '{service="backend"}', "5m")
  .build();
```

## Loki Adapter

### LokiAdapter

Connect to Grafana Loki for log streaming.

```javascript
const { LokiAdapter } = require("@liquescent/log-correlator-loki");
```

#### Constructor

```javascript
new LokiAdapter(options: LokiAdapterOptions)
```

##### Options

| Parameter      | Type    | Default  | Description                                  |
| -------------- | ------- | -------- | -------------------------------------------- |
| `url`          | string  | required | Loki server URL                              |
| `websocket`    | boolean | true     | Use WebSocket for real-time streaming        |
| `pollInterval` | number  | 1000     | Polling interval (ms) if not using WebSocket |
| `timeout`      | number  | 30000    | Request timeout (ms)                         |
| `maxRetries`   | number  | 3        | Maximum retry attempts                       |
| `authToken`    | string  | -        | Bearer token for authentication              |
| `headers`      | object  | {}       | Additional HTTP headers                      |

#### Methods

##### createStream(query: string, options?: any): AsyncIterable<LogEvent>

Create a stream of log events.

```javascript
const stream = adapter.createStream('{service="frontend"}', {
  timeRange: "5m",
});

for await (const event of stream) {
  console.log("Log event:", event);
}
```

##### getAvailableStreams(): Promise<string[]>

Get list of available log streams.

```javascript
const streams = await adapter.getAvailableStreams();
```

## Graylog Adapter

### GraylogAdapter

Connect to Graylog for log streaming.

```javascript
const { GraylogAdapter } = require("@liquescent/log-correlator-graylog");
```

#### Constructor

```javascript
new GraylogAdapter(options: GraylogAdapterOptions)
```

##### Options

| Parameter      | Type             | Default  | Description                                  |
| -------------- | ---------------- | -------- | -------------------------------------------- |
| `url`          | string           | required | Graylog server URL                           |
| `username`     | string           | -        | Username for basic auth                      |
| `password`     | string           | -        | Password for basic auth                      |
| `apiToken`     | string           | -        | API token (alternative to username/password) |
| `apiVersion`   | 'legacy' \| 'v6' | 'legacy' | API version ('v6' for Graylog 6.x+)          |
| `pollInterval` | number           | 2000     | Polling interval (ms)                        |
| `timeout`      | number           | 15000    | Request timeout (ms)                         |
| `maxRetries`   | number           | 3        | Maximum retry attempts                       |
| `streamId`     | string           | -        | Specific stream ID to query                  |

#### Graylog API Versions

**Legacy API (Graylog 2.x-5.x)**:

- Uses Universal Search API (`/api/search/universal/relative`)
- Returns JSON responses
- Simple query parameter structure

**v6 API (Graylog 6.x+)**:

- Uses Views Search API (`/api/views/search/messages`)
- Returns CSV responses exclusively
- Requires nested `query_string.query_string` structure
- Uses relative timerange format (seconds from now)

```javascript
// For Graylog 6.x+
const adapter = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  apiToken: "your-api-token",
  apiVersion: "v6", // Required for Graylog 6.x+
});
```

## Advanced Features

### Custom Error Handling

```javascript
const { CorrelationError } = require("@liquescent/log-correlator-core");

try {
  await engine.correlate(query);
} catch (error) {
  if (error instanceof CorrelationError) {
    switch (error.code) {
      case "QUERY_PARSE_ERROR":
        console.error("Invalid query syntax:", error.message);
        break;
      case "ADAPTER_ERROR":
        console.error("Data source error:", error.details);
        break;
      case "TIMEOUT_ERROR":
        console.error("Query timeout exceeded");
        break;
      case "MEMORY_ERROR":
        console.error("Memory limit exceeded");
        break;
    }
  }
}
```

### Performance Monitoring

```javascript
const { PerformanceMonitor } = require("@liquescent/log-correlator-core");

const monitor = new PerformanceMonitor(5000); // 5 second intervals
monitor.start();

monitor.on("metrics", (metrics) => {
  console.log("Performance metrics:", {
    eventsProcessed: metrics.eventsProcessed,
    throughput: metrics.throughput,
    averageLatency: metrics.averageLatency,
    memoryUsage: metrics.memoryUsage,
  });
});

monitor.on("highLatency", ({ averageMs }) => {
  console.warn(`High latency detected: ${averageMs}ms`);
});

monitor.on("highMemoryUsage", ({ usedMB }) => {
  console.warn(`High memory usage: ${usedMB}MB`);
});
```

### Utility Functions

```javascript
const {
  parseTimeWindow,
  formatDuration,
  generateCorrelationId,
} = require("@liquescent/log-correlator-core");

// Parse time window strings
const ms = parseTimeWindow("5m"); // Returns: 300000

// Format durations
const formatted = formatDuration(300000); // Returns: '5m'

// Generate unique IDs
const id = generateCorrelationId(); // Returns: 'corr_1234567890_abc123'
```

## Type Definitions

All packages include full TypeScript definitions for IDE support:

```typescript
import {
  CorrelationEngine,
  CorrelationEngineOptions,
  LogEvent,
  CorrelatedEvent,
  DataSourceAdapter,
  JoinType,
  ParsedQuery,
  StreamQuery,
} from "@liquescent/log-correlator-core";
```
