# Type Reference Guide

This document provides comprehensive documentation of all types returned by the TimeBridge library, with detailed explanations and examples.

## Table of Contents

- [Core Types](#core-types)
  - [LogEvent](#logevent)
  - [CorrelatedEvent](#correlatedevent)
- [Query Validation Types](#query-validation-types)
- [Adapter Types](#adapter-types)
- [Type Guards and Helpers](#type-guards-and-helpers)
- [Complete Examples](#complete-examples)

## Core Types

### LogEvent

The `LogEvent` type represents a single log entry from any data source (Graylog, Loki, etc.). This is the fundamental unit of data in the system.

```typescript
interface LogEvent {
  timestamp: string; // ISO 8601 timestamp (e.g., "2025-01-15T14:30:00.000Z")
  source: string; // Data source identifier (e.g., "graylog", "loki", "nginx")
  stream?: string; // Optional stream/channel name
  message: string; // The actual log message content
  labels: Record<string, string>; // Key-value pairs of metadata
  joinKeys?: Record<string, string>; // Extracted correlation identifiers
}
```

#### LogEvent Fields Explained

##### `timestamp`

- **Type**: `string`
- **Format**: ISO 8601 timestamp
- **Example**: `"2025-01-15T14:30:00.123Z"`
- **Usage**: Used for temporal correlation and event ordering

##### `source`

- **Type**: `string`
- **Description**: Identifies where the log came from
- **Examples**:
  - From adapters: `"graylog"`, `"loki"`
  - From services: `"nginx"`, `"api-service"`, `"database"`

##### `stream` (optional)

- **Type**: `string | undefined`
- **Description**: Stream or channel within the source
- **Examples**: `"production-logs"`, `"error-stream"`, `"audit-trail"`

##### `message`

- **Type**: `string`
- **Description**: The actual log message content
- **Examples**:
  - `"User authentication successful for user@example.com"`
  - `"Database query executed in 45ms"`
  - `"HTTP 500 Internal Server Error"`

##### `labels`

- **Type**: `Record<string, string>`
- **Description**: Metadata associated with the log event
- **Examples**:
  ```typescript
  {
    level: "error",
    service: "api",
    environment: "production",
    region: "us-east-1",
    pod: "api-deployment-7b9c5d4f6-xkz9m"
  }
  ```

##### `joinKeys` (optional)

- **Type**: `Record<string, string> | undefined`
- **Description**: Correlation identifiers extracted from the log
- **Purpose**: Used for joining events in correlation queries
- **Examples**:
  ```typescript
  {
    request_id: "abc-123-def-456",
    trace_id: "xyz-789",
    session_id: "sess-001",
    correlation_id: "corr-2025-01-15-001"
  }
  ```

#### LogEvent Examples

```typescript
// Example 1: Simple application log
const appLog: LogEvent = {
  timestamp: "2025-01-15T14:30:00.123Z",
  source: "api-service",
  message: "Processing payment for order #12345",
  labels: {
    level: "info",
    service: "payment",
    environment: "production",
  },
  joinKeys: {
    order_id: "12345",
    transaction_id: "tx-98765",
  },
};

// Example 2: Error log with stack trace
const errorLog: LogEvent = {
  timestamp: "2025-01-15T14:30:05.456Z",
  source: "backend",
  stream: "error-logs",
  message: "NullPointerException at PaymentService.process()",
  labels: {
    level: "error",
    service: "payment",
    exception: "NullPointerException",
    file: "PaymentService.java",
    line: "142",
  },
  joinKeys: {
    request_id: "req-001",
    trace_id: "trace-xyz",
  },
};

// Example 3: Infrastructure log
const infraLog: LogEvent = {
  timestamp: "2025-01-15T14:30:10.789Z",
  source: "kubernetes",
  message: "Pod api-deployment-7b9c5d4f6-xkz9m started successfully",
  labels: {
    namespace: "production",
    deployment: "api-deployment",
    pod: "api-deployment-7b9c5d4f6-xkz9m",
    node: "node-01",
  },
};
```

### CorrelatedEvent

The `CorrelatedEvent` type represents a group of related log events that have been joined together based on common identifiers.

```typescript
interface CorrelatedEvent {
  correlationId: string; // Unique ID for this correlation
  timestamp: string; // When the correlation was created
  timeWindow: {
    start: string; // Earliest event timestamp
    end: string; // Latest event timestamp
  };
  joinKey: string; // Field name used for correlation (e.g., "request_id")
  joinValue: string; // Value that matched (e.g., "abc-123")
  events: Array<{
    alias?: string; // Optional alias for the source
    source: string; // Data source
    timestamp: string; // Event timestamp
    message: string; // Log message
    labels: Record<string, string>; // Event metadata
  }>;
  metadata: {
    completeness: "complete" | "partial"; // Whether all streams matched
    matchedStreams: string[]; // Which streams had matches
    totalStreams: number; // Total expected streams
  };
}
```

#### CorrelatedEvent Fields Explained

##### `correlationId`

- **Type**: `string`
- **Description**: Unique identifier for this correlation result
- **Format**: Usually UUID or timestamp-based ID
- **Example**: `"corr-2025-01-15-14-30-00-001"`

##### `timestamp`

- **Type**: `string`
- **Description**: When the correlation was performed
- **Example**: `"2025-01-15T14:30:15.000Z"`

##### `timeWindow`

- **Type**: `{ start: string; end: string }`
- **Description**: Time range of all correlated events
- **Example**:
  ```typescript
  {
    start: "2025-01-15T14:30:00.000Z",
    end: "2025-01-15T14:30:10.000Z"
  }
  ```

##### `joinKey` and `joinValue`

- **Type**: `string`
- **Description**: The field and value used to correlate events
- **Examples**:
  - `joinKey: "request_id"`, `joinValue: "req-abc-123"`
  - `joinKey: "trace_id"`, `joinValue: "trace-xyz-789"`
  - `joinKey: "session_id"`, `joinValue: "sess-001"`

##### `events`

- **Type**: `Array<Event>`
- **Description**: All events that were correlated
- **Minimum**: 2 events (for a valid correlation)
- **Each event contains**:
  - `alias`: Optional source alias
  - `source`: Where the event came from
  - `timestamp`: When it occurred
  - `message`: Log content
  - `labels`: Metadata

##### `metadata`

- **Type**: Complex metadata object
- **`completeness`**: Whether all expected streams had matching events
  - `"complete"`: All streams in the query had matches
  - `"partial"`: Some streams were missing matches
- **`matchedStreams`**: Array of stream names that had matches
- **`totalStreams`**: Total number of streams in the query

#### CorrelatedEvent Examples

```typescript
// Example 1: Complete correlation between frontend and backend
const completeCorrelation: CorrelatedEvent = {
  correlationId: "corr-001",
  timestamp: "2025-01-15T14:30:15.000Z",
  timeWindow: {
    start: "2025-01-15T14:30:00.000Z",
    end: "2025-01-15T14:30:05.000Z",
  },
  joinKey: "request_id",
  joinValue: "req-abc-123",
  events: [
    {
      source: "frontend",
      timestamp: "2025-01-15T14:30:00.000Z",
      message: "User clicked submit button",
      labels: { level: "info", component: "ui" },
    },
    {
      source: "backend",
      timestamp: "2025-01-15T14:30:05.000Z",
      message: "Processing user request",
      labels: { level: "info", service: "api" },
    },
  ],
  metadata: {
    completeness: "complete",
    matchedStreams: ["frontend", "backend"],
    totalStreams: 2,
  },
};

// Example 2: Partial correlation (missing one stream)
const partialCorrelation: CorrelatedEvent = {
  correlationId: "corr-002",
  timestamp: "2025-01-15T14:30:20.000Z",
  timeWindow: {
    start: "2025-01-15T14:30:00.000Z",
    end: "2025-01-15T14:30:10.000Z",
  },
  joinKey: "trace_id",
  joinValue: "trace-xyz-789",
  events: [
    {
      source: "api-gateway",
      timestamp: "2025-01-15T14:30:00.000Z",
      message: "Incoming request",
      labels: { level: "info" },
    },
    {
      source: "auth-service",
      timestamp: "2025-01-15T14:30:02.000Z",
      message: "Authentication successful",
      labels: { level: "info" },
    },
    // Missing: database service event
  ],
  metadata: {
    completeness: "partial",
    matchedStreams: ["api-gateway", "auth-service"],
    totalStreams: 3,
  },
};

// Example 3: Multi-service trace correlation
const traceCorrelation: CorrelatedEvent = {
  correlationId: "corr-003",
  timestamp: "2025-01-15T14:30:30.000Z",
  timeWindow: {
    start: "2025-01-15T14:30:00.000Z",
    end: "2025-01-15T14:30:15.000Z",
  },
  joinKey: "trace_id",
  joinValue: "distributed-trace-001",
  events: [
    {
      alias: "gateway",
      source: "api-gateway",
      timestamp: "2025-01-15T14:30:00.000Z",
      message: "Request received: POST /api/orders",
      labels: { method: "POST", path: "/api/orders" },
    },
    {
      alias: "auth",
      source: "auth-service",
      timestamp: "2025-01-15T14:30:02.000Z",
      message: "User authenticated: user@example.com",
      labels: { user: "user@example.com" },
    },
    {
      alias: "inventory",
      source: "inventory-service",
      timestamp: "2025-01-15T14:30:05.000Z",
      message: "Stock check: Product SKU-123 available",
      labels: { sku: "SKU-123", available: "true" },
    },
    {
      alias: "payment",
      source: "payment-service",
      timestamp: "2025-01-15T14:30:10.000Z",
      message: "Payment processed: $99.99",
      labels: { amount: "99.99", currency: "USD" },
    },
    {
      alias: "notification",
      source: "notification-service",
      timestamp: "2025-01-15T14:30:15.000Z",
      message: "Order confirmation email sent",
      labels: { type: "email", template: "order-confirmation" },
    },
  ],
  metadata: {
    completeness: "complete",
    matchedStreams: [
      "api-gateway",
      "auth-service",
      "inventory-service",
      "payment-service",
      "notification-service",
    ],
    totalStreams: 5,
  },
};
```

## Query Validation Types

### Query Validation Result

Returned by `TimeQLExecutor.validateQuery()`:

```typescript
interface QueryValidationResult {
  valid: boolean;
  type?: "direct" | "correlation";
  sources?: string[];
  error?: string;
}
```

#### Examples

```typescript
// Valid direct query
const validation1 = executor.validateQuery("graylog(level:error)[5m]");
// Result: { valid: true, type: 'direct', sources: ['graylog'] }

// Valid correlation query
const validation2 = executor.validateQuery(
  "graylog-prod(service:api)[5m] and on(request_id) graylog-staging(service:api)[5m]"
);
// Result: { valid: true, type: 'correlation', sources: ['graylog-prod', 'graylog-staging'] }

// Invalid query - missing adapter
const validation3 = executor.validateQuery("unknown-source(test)[5m]");
// Result: { valid: false, error: 'Missing adapters for sources: unknown-source' }

// Invalid query - malformed syntax
const validation4 = executor.validateQuery("not a valid query");
// Result: { valid: false, error: 'Invalid direct query format: not a valid query' }
```

## Adapter Types

### Adapter Info

Returned by `TimeQLExecutor.getAdapterInfo()`:

```typescript
interface AdapterInfo {
  name: string; // Adapter name (e.g., "graylog-prod")
  baseType: string; // Base type (e.g., "graylog")
  isDefault: boolean; // Whether this is the default for its base type
}
```

#### Examples

```typescript
const executor = new TimeQLExecutor();
executor.addAdapter("graylog", graylogAdapter, { isDefault: true });
executor.addAdapter("graylog-prod", graylogProdAdapter);
executor.addAdapter("loki-us", lokiAdapter);

const info = executor.getAdapterInfo();
// Result:
// [
//   { name: 'graylog', baseType: 'graylog', isDefault: true },
//   { name: 'graylog-prod', baseType: 'graylog', isDefault: false },
//   { name: 'loki-us', baseType: 'loki', isDefault: true }
// ]
```

## Type Guards and Helpers

### Distinguishing Between LogEvent and CorrelatedEvent

Since `TimeQLExecutor.execute()` returns either `LogEvent` or `CorrelatedEvent`, you may need to distinguish between them:

```typescript
// Type guard function
function isCorrelatedEvent(
  event: LogEvent | CorrelatedEvent
): event is CorrelatedEvent {
  return "correlationId" in event && "joinKey" in event && "events" in event;
}

// Using the type guard
async function processQueryResults(executor: TimeQLExecutor, query: string) {
  for await (const result of executor.execute(query)) {
    if (isCorrelatedEvent(result)) {
      // TypeScript knows this is CorrelatedEvent
      console.log(`Correlation found: ${result.correlationId}`);
      console.log(`Joined on: ${result.joinKey} = ${result.joinValue}`);
      console.log(`Events correlated: ${result.events.length}`);
    } else {
      // TypeScript knows this is LogEvent
      console.log(`Log event: ${result.timestamp} - ${result.message}`);
      console.log(`Labels: ${JSON.stringify(result.labels)}`);
    }
  }
}
```

### Using Query Validation for Type Safety

```typescript
async function safeExecuteQuery(executor: TimeQLExecutor, query: string) {
  // Always validate first
  const validation = executor.validateQuery(query);

  if (!validation.valid) {
    throw new Error(`Invalid query: ${validation.error}`);
  }

  // Use validation.type to determine expected return type
  if (validation.type === "direct") {
    // We know we'll get LogEvents
    const events: LogEvent[] = [];
    for await (const event of executor.execute(query)) {
      events.push(event as LogEvent);
    }
    return { type: "direct", events };
  } else {
    // We know we'll get CorrelatedEvents
    const correlations: CorrelatedEvent[] = [];
    for await (const correlation of executor.execute(query)) {
      correlations.push(correlation as CorrelatedEvent);
    }
    return { type: "correlation", correlations };
  }
}
```

## Complete Examples

### Example 1: Processing Direct Query Results

```typescript
import { QueryExecutor, LogEvent } from "@liquescent/log-correlator-core";
import { GraylogAdapter } from "@liquescent/log-correlator-graylog";

async function analyzeErrors() {
  const executor = new TimeQLExecutor();
  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      url: "http://graylog.example.com",
      apiToken: "token",
    })
  );

  const query = "graylog(level:error)[1h]";
  const errorsByService = new Map<string, number>();

  for await (const event of executor.execute(query)) {
    const logEvent = event as LogEvent;

    // Count errors by service
    const service = logEvent.labels.service || "unknown";
    errorsByService.set(service, (errorsByService.get(service) || 0) + 1);

    // Extract error details
    console.log(`Error at ${logEvent.timestamp}:`);
    console.log(`  Service: ${service}`);
    console.log(`  Message: ${logEvent.message}`);

    // Check for critical errors
    if (logEvent.labels.severity === "critical") {
      console.error("CRITICAL ERROR DETECTED!");
      // Send alert...
    }
  }

  // Report summary
  console.log("\nError Summary:");
  for (const [service, count] of errorsByService) {
    console.log(`  ${service}: ${count} errors`);
  }
}
```

### Example 2: Processing Correlation Results

```typescript
import {
  QueryExecutor,
  CorrelatedEvent,
} from "@liquescent/log-correlator-core";
import { GraylogAdapter } from "@liquescent/log-correlator-graylog";

async function analyzeRequestFlow() {
  const executor = new TimeQLExecutor();

  // Register multiple environments
  executor.addAdapter(
    "graylog-prod",
    new GraylogAdapter({
      url: "http://prod.graylog.example.com",
      apiToken: "prod-token",
    })
  );

  executor.addAdapter(
    "graylog-staging",
    new GraylogAdapter({
      url: "http://staging.graylog.example.com",
      apiToken: "staging-token",
    })
  );

  // Correlate requests across environments
  const query = `
    graylog-prod(service:api AND level:error)[30m]
    and on(request_id)
    graylog-staging(service:api)[30m]
  `;

  const problematicRequests: string[] = [];

  for await (const correlation of executor.execute(query)) {
    const corr = correlation as CorrelatedEvent;

    console.log(`\nCorrelation found for ${corr.joinKey}: ${corr.joinValue}`);
    console.log(
      `Time window: ${corr.timeWindow.start} to ${corr.timeWindow.end}`
    );

    // Analyze the correlation
    const prodEvents = corr.events.filter((e) => e.source === "graylog-prod");
    const stagingEvents = corr.events.filter(
      (e) => e.source === "graylog-staging"
    );

    console.log(`  Production events: ${prodEvents.length}`);
    console.log(`  Staging events: ${stagingEvents.length}`);

    // Check if error exists in prod but not staging
    const prodError = prodEvents.find((e) => e.labels.level === "error");
    const stagingError = stagingEvents.find((e) => e.labels.level === "error");

    if (prodError && !stagingError) {
      console.warn("  ⚠️ Error in production but not in staging!");
      problematicRequests.push(corr.joinValue);
    }

    // Show event timeline
    console.log("  Event timeline:");
    const sortedEvents = [...corr.events].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    for (const event of sortedEvents) {
      const time = new Date(event.timestamp).toISOString().substring(11, 23);
      console.log(
        `    ${time} [${event.source}] ${event.message.substring(0, 50)}...`
      );
    }

    // Calculate latency between environments
    if (prodEvents.length > 0 && stagingEvents.length > 0) {
      const prodTime = new Date(prodEvents[0].timestamp).getTime();
      const stagingTime = new Date(stagingEvents[0].timestamp).getTime();
      const latency = Math.abs(prodTime - stagingTime);
      console.log(`  Latency between environments: ${latency}ms`);
    }
  }

  if (problematicRequests.length > 0) {
    console.log("\n🔴 Requests with production-only errors:");
    problematicRequests.forEach((id) => console.log(`  - ${id}`));
  }
}
```

### Example 3: Mixed Query Processing

```typescript
import { TimeQLExecutor, LogEvent, CorrelatedEvent } from "@timebridge/core";
import { GraylogAdapter } from "@timebridge/graylog";
import { LokiAdapter } from "@timebridge/loki";

async function processMultipleQueries() {
  const executor = new TimeQLExecutor();

  // Register different adapters
  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      /* config */
    })
  );
  executor.addAdapter(
    "loki",
    new LokiAdapter({
      /* config */
    })
  );

  const queries = [
    { name: "Graylog Errors", query: "graylog(level:error)[5m]" },
    { name: "Loki Warnings", query: 'loki({level="warn"})[5m]' },
    {
      name: "Cross-Platform Correlation",
      query:
        'graylog(service:api)[5m] and on(trace_id) loki({service="api"})[5m]',
    },
  ];

  for (const { name, query } of queries) {
    console.log(`\nProcessing: ${name}`);

    const validation = executor.validateQuery(query);
    if (!validation.valid) {
      console.error(`Invalid query: ${validation.error}`);
      continue;
    }

    console.log(`Query type: ${validation.type}`);
    console.log(`Sources: ${validation.sources?.join(", ")}`);

    let count = 0;
    const maxResults = 10;

    for await (const result of executor.execute(query)) {
      count++;

      if (validation.type === "direct") {
        const event = result as LogEvent;
        console.log(
          `  [${event.timestamp}] ${event.message.substring(0, 50)}...`
        );
      } else {
        const correlation = result as CorrelatedEvent;
        console.log(
          `  Correlation: ${correlation.events.length} events on ${correlation.joinKey}`
        );
      }

      if (count >= maxResults) {
        console.log(`  ... (limited to ${maxResults} results)`);
        break;
      }
    }

    if (count === 0) {
      console.log("  No results found");
    }
  }
}
```

## Type Reference Summary

| Type                    | Returned By         | Description               | Key Fields                                     |
| ----------------------- | ------------------- | ------------------------- | ---------------------------------------------- |
| `LogEvent`              | Direct queries      | Single log entry          | `timestamp`, `message`, `labels`, `joinKeys`   |
| `CorrelatedEvent`       | Correlation queries | Group of related logs     | `events[]`, `joinKey`, `joinValue`, `metadata` |
| `QueryValidationResult` | `validateQuery()`   | Query validation info     | `valid`, `type`, `sources`, `error`            |
| `AdapterInfo`           | `getAdapterInfo()`  | Adapter registration info | `name`, `baseType`, `isDefault`                |

## Best Practices

1. **Always validate queries** before execution to ensure type safety
2. **Use type guards** when processing mixed query results
3. **Check `metadata.completeness`** to understand correlation quality
4. **Leverage `joinKeys`** for understanding event relationships
5. \*\*Use `labels` for filtering and categorization
6. **Monitor `timeWindow`** for understanding event timing
7. **Handle both empty results and errors gracefully**
8. **Type your variables explicitly** for better IDE support
