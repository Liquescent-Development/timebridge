# Troubleshooting Guide

A comprehensive guide to diagnosing and resolving issues with the log-correlator package when integrating it into Electron applications.

## Table of Contents

- [Common Issues](#common-issues)
- [Connection Errors](#connection-errors)
- [Query Errors](#query-errors)
- [Performance Issues](#performance-issues)
- [Memory Management](#memory-management)
- [WebSocket Issues](#websocket-issues)
- [Debugging Correlations](#debugging-correlations)
- [Data Source Adapter Problems](#data-source-adapter-problems)
- [Configuration Issues](#configuration-issues)
- [Error Codes Reference](#error-codes-reference)

## Common Issues

### No Correlations Found

**Problem**: Query returns no correlations despite matching events existing.

**Possible Causes**:

1. Time window too narrow
2. Join keys don't match exactly
3. Events arriving out of order beyond late tolerance
4. Join key extraction patterns not matching your log format

**Solutions**:

```javascript
// 1. Increase time window and late tolerance
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const engine = new CorrelationEngine({
  defaultTimeWindow: "10m", // Increase from default 5m
  lateTolerance: 60000, // Allow 60 seconds for late events
  maxEvents: 20000, // Increase buffer size
});

// 2. Debug join key extraction
const { LokiAdapter } = require("@liquescent/log-correlator-adapters-loki");
const lokiAdapter = new LokiAdapter({ url: "http://localhost:3100" });

for await (const event of lokiAdapter.createStream('{service="frontend"}')) {
  console.log("Event labels:", event.labels);
  console.log("Extracted join keys:", event.joinKeys);
  break; // Just check the first event
}

// 3. Use explicit label mappings if join keys have different names
const query = `
  loki({service="frontend"})[10m] 
    and on(requestId=request_id) 
    loki({service="backend"})[10m]
`;

// 4. Check for case sensitivity
const caseInsensitiveQuery = `
  loki({service="frontend"})[10m] 
    and on(request_id) 
    loki({service="backend"})[10m]
`;
```

### Incomplete Correlations

**Problem**: Some events are missing from correlations.

**Solutions**:

```javascript
// 1. Use left join to see all events from primary stream
const leftJoinQuery = `
  loki({service="frontend"})[5m] 
    or on(request_id) 
    loki({service="backend"})[5m]
`;

// 2. Check metadata for partial correlations
for await (const correlation of engine.correlate(leftJoinQuery)) {
  if (correlation.metadata.completeness === "partial") {
    console.log("Partial correlation found:");
    console.log("- Join value:", correlation.joinValue);
    console.log("- Matched streams:", correlation.metadata.matchedStreams);
    console.log(
      "- Missing streams:",
      correlation.metadata.totalStreams -
        correlation.metadata.matchedStreams.length
    );
  }
}

// 3. Use temporal constraints for time-sensitive correlations
const temporalQuery = `
  loki({service="frontend"})[5m] 
    and on(request_id) 
    within(30s) 
    loki({service="backend"})[5m]
`;

// 4. Use grouping for many-to-many correlations
const groupedQuery = `
  loki({service="api"})[5m] 
    and on(request_id) 
    group_left(session_id) 
    loki({service="auth"})[5m]
`;
```

## Connection Errors

### Loki Connection Failed

**Error**: `WEBSOCKET_MAX_RETRIES` or connection timeouts

**Diagnostics**:

```bash
# Test Loki connectivity
curl http://localhost:3100/ready
curl http://localhost:3100/loki/api/v1/labels
```

**Solutions**:

```javascript
const { LokiAdapter } = require("@liquescent/log-correlator-adapters-loki");

// 1. Configure timeout and retries
const lokiAdapter = new LokiAdapter({
  url: "http://localhost:3100",
  timeout: 60000, // Increase timeout to 60s
  maxRetries: 5, // More retry attempts
  websocket: true, // Use WebSocket for real-time
});

// 2. Use polling for unreliable networks
const pollingAdapter = new LokiAdapter({
  url: "http://localhost:3100",
  websocket: false, // Disable WebSocket
  pollInterval: 2000, // Poll every 2 seconds
});

// 3. Add authentication for secured Loki
const authenticatedAdapter = new LokiAdapter({
  url: "https://loki.example.com",
  authToken: "Bearer <YOUR_API_TOKEN>",
  headers: {
    "X-Scope-OrgID": "your-org-id",
  },
});

// 4. Debug connection issues
const debugAdapter = new LokiAdapter({
  url: "http://localhost:3100",
  timeout: 30000,
});

try {
  const streams = await debugAdapter.getAvailableStreams();
  console.log("Available streams:", streams);
} catch (error) {
  console.error("Connection failed:", error.message);
  console.error("Check if Loki is running and accessible");
}
```

### Graylog Connection Failed

**Error**: `GRAYLOG_SEARCH_ERROR` or `AUTH_REQUIRED`

**Diagnostics**:

```bash
# Test Graylog API access
curl -u <USERNAME>:<PASSWORD> http://localhost:9000/api/system
curl -H "Authorization: Bearer <YOUR_API_TOKEN>" http://localhost:9000/api/streams
```

**Solutions**:

```javascript
const {
  GraylogAdapter,
} = require("@liquescent/log-correlator-adapters-graylog");

// 1. Use API token (recommended)
const graylogAdapter = new GraylogAdapter({
  url: "http://localhost:9000",
  apiToken: "<YOUR_API_TOKEN>", // Create in Graylog System > Users
  timeout: 15000,
  maxRetries: 3,
});

// 2. Use username/password authentication
const basicAuthAdapter = new GraylogAdapter({
  url: "http://localhost:9000",
  username: "<YOUR_USERNAME>",
  password: "<YOUR_PASSWORD>",
  pollInterval: 5000,
});

// 3. Configure for specific stream
const streamAdapter = new GraylogAdapter({
  url: "http://localhost:9000",
  apiToken: "<YOUR_API_TOKEN>",
  streamId: "507f1f77bcf86cd799439011", // Limit to specific stream
});

// 4. Configure for Graylog 6.x+ (Views API)
const v6Adapter = new GraylogAdapter({
  url: "http://localhost:9000",
  apiToken: "<YOUR_API_TOKEN>", // Required for v6
  apiVersion: "v6", // Use Views API instead of Universal Search
  pollInterval: 5000,
});

// 5. Debug authentication
try {
  const streams = await graylogAdapter.getAvailableStreams();
  console.log("Available streams:", streams);
} catch (error) {
  if (error.code === "AUTH_REQUIRED") {
    console.error(
      "Authentication required: provide apiToken or username/password"
    );
  } else if (error.code === "GRAYLOG_SEARCH_ERROR") {
    console.error("Search failed:", error.details?.status);
  }
}
```

## Query Errors

### Parse Errors

**Error**: `QUERY_PARSE_ERROR: Unexpected token`

**Common Issues**:

```javascript
// Missing quotes around label values
// WRONG:
const query = "loki({service=frontend})[5m]";

// CORRECT:
const query = 'loki({service="frontend"})[5m]';

// Missing parentheses around join keys
// WRONG:
const query =
  'loki({service="a"})[5m] and on request_id loki({service="b"})[5m]';

// CORRECT:
const query =
  'loki({service="a"})[5m] and on(request_id) loki({service="b"})[5m]';

// Invalid time range format
// WRONG:
const query = 'loki({service="frontend"})[5 minutes]';

// CORRECT:
const query = 'loki({service="frontend"})[5m]';
```

**Validation Helper**:

```javascript
// Always validate queries before execution
const parser = new PeggyQueryParser();
const result = parser.validate(query);

if (!result.valid) {
  console.error("Query error at position", result.error.location);
  console.error("Expected:", result.error.expected);

  // Show error location
  const lines = query.split("\n");
  const errorLine = lines[result.error.location.line - 1];
  console.error(errorLine);
  console.error(" ".repeat(result.error.location.column - 1) + "^");
}
```

### Unsupported Query Features

**Error**: `QUERY_PARSE_ERROR: Unsupported operation`

**Solutions**:

```javascript
// Use QueryBuilder for complex queries
const { QueryBuilder } = require("@liquescent/log-correlator-query-parser");

const builder = new QueryBuilder();
const query = builder
  .addStream("loki", '{service="frontend"}', "5m")
  .join("and", ["request_id"])
  .withTemporal("30s")
  .andStream("loki", '{service="backend"}', "5m")
  .build();

// This ensures valid syntax
console.log("Generated query:", query);
```

## WebSocket Issues

### WebSocket Connection Drops

**Problem**: Loki WebSocket connections frequently disconnect.

**Solutions**:

```javascript
// 1. Enable connection monitoring
const { LokiAdapter } = require("@liquescent/log-correlator-adapters-loki");
const adapter = new LokiAdapter({
  url: "ws://localhost:3100",
  websocket: true,
  maxRetries: 10, // Allow more reconnection attempts
  timeout: 45000, // Longer timeout for slow networks
});

// 2. Handle reconnection events
let reconnectCount = 0;
try {
  for await (const event of adapter.createStream('{service="frontend"}')) {
    console.log("Received event:", event.message);
    reconnectCount = 0; // Reset on successful message
  }
} catch (error) {
  if (error.code === "WEBSOCKET_MAX_RETRIES") {
    console.log("Switching to polling mode due to connection issues");
    // Fallback to polling
    const pollingAdapter = new LokiAdapter({
      url: "http://localhost:3100",
      websocket: false,
      pollInterval: 2000,
    });
  }
}
```

### WebSocket Behind Proxy/Load Balancer

**Problem**: WebSocket connections fail through proxies.

**Solutions**:

```javascript
// 1. Use polling mode for proxy environments
const proxyAdapter = new LokiAdapter({
  url: "http://loki.company.com", // Through load balancer
  websocket: false, // Disable WebSocket
  pollInterval: 3000,
  headers: {
    "X-Forwarded-For": "your-client-ip",
  },
});

// 2. Configure proxy-friendly headers
const headerAdapter = new LokiAdapter({
  url: "ws://loki.company.com",
  websocket: true,
  headers: {
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Version": "13",
  },
});
```

### WebSocket Memory Leaks

**Problem**: Long-running WebSocket connections consume increasing memory.

**Solutions**:

```javascript
// 1. Implement connection recycling
class ManagedLokiAdapter {
  constructor(options) {
    this.options = options;
    this.adapter = null;
    this.connectionTime = 0;
    this.maxConnectionTime = 300000; // 5 minutes
  }

  async *createStream(query) {
    let eventCount = 0;
    const maxEvents = 10000;

    while (true) {
      // Create new adapter if needed
      if (
        !this.adapter ||
        Date.now() - this.connectionTime > this.maxConnectionTime
      ) {
        if (this.adapter) {
          await this.adapter.destroy();
        }
        this.adapter = new LokiAdapter(this.options);
        this.connectionTime = Date.now();
        eventCount = 0;
      }

      try {
        for await (const event of this.adapter.createStream(query)) {
          yield event;
          eventCount++;

          // Recreate connection after many events
          if (eventCount >= maxEvents) {
            break;
          }
        }
      } catch (error) {
        console.error("Stream error, recreating connection:", error);
        await this.adapter.destroy();
        this.adapter = null;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async destroy() {
    if (this.adapter) {
      await this.adapter.destroy();
    }
  }
}
```

## Performance Issues

### Slow Query Execution

**Problem**: Queries take too long to return results.

**Diagnostics**:

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const { performance } = require("perf_hooks");

// 1. Measure correlation timing
function timeCorrelation(engine, query) {
  return new Promise(async (resolve) => {
    const start = performance.now();
    let count = 0;

    for await (const correlation of engine.correlate(query)) {
      count++;
      if (count === 1) {
        const firstResult = performance.now() - start;
        console.log(`First correlation found in ${firstResult.toFixed(2)}ms`);
      }
    }

    const total = performance.now() - start;
    console.log(`Total time: ${total.toFixed(2)}ms for ${count} correlations`);
    resolve({ totalTime: total, correlationCount: count });
  });
}

// 2. Monitor memory usage during correlation
function monitorMemory(engine) {
  const interval = setInterval(() => {
    const usage = process.memoryUsage();
    console.log(`Memory: ${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
  }, 1000);

  engine.on("memoryWarning", ({ usedMB, maxMB }) => {
    console.warn(`Memory warning: ${usedMB}MB / ${maxMB}MB`);
  });

  return () => clearInterval(interval);
}
```

**Optimizations**:

```javascript
// 1. Optimize engine configuration
const optimizedEngine = new CorrelationEngine({
  defaultTimeWindow: "2m", // Smaller windows = faster processing
  bufferSize: 500, // Smaller buffers = less memory
  processingInterval: 50, // More frequent processing
  maxEvents: 5000, // Limit event accumulation
  gcInterval: 30000, // Regular cleanup
});

// 2. Use specific selectors to reduce data volume
const efficientQuery = `
  loki({service="frontend", level="error", status=~"5.."})[2m] 
    and on(request_id) 
    loki({service="backend", level="error"})[2m]
`;

// 3. Implement query result limiting
async function limitedCorrelation(engine, query, maxResults = 1000) {
  const results = [];
  let count = 0;

  for await (const correlation of engine.correlate(query)) {
    results.push(correlation);
    count++;

    if (count >= maxResults) {
      console.log(`Stopped after ${maxResults} correlations`);
      break;
    }
  }

  return results;
}

// 4. Use streaming for large result sets
async function streamToFile(engine, query, filename) {
  const fs = require("fs");
  const writeStream = fs.createWriteStream(filename);

  try {
    for await (const correlation of engine.correlate(query)) {
      writeStream.write(JSON.stringify(correlation) + "\n");
      // Don't accumulate in memory
    }
  } finally {
    writeStream.end();
  }
}
```

### High CPU Usage

**Problem**: Correlation engine consuming excessive CPU resources.

**Diagnostics**:

```javascript
// Monitor CPU usage
function monitorCPU() {
  const startUsage = process.cpuUsage();

  setInterval(() => {
    const currentUsage = process.cpuUsage(startUsage);
    const userCPU = currentUsage.user / 1000; // Convert to milliseconds
    const systemCPU = currentUsage.system / 1000;

    console.log(`CPU Usage - User: ${userCPU}ms, System: ${systemCPU}ms`);
  }, 5000);
}
```

**Solutions**:

```javascript
// 1. Reduce processing frequency
const lightEngine = new CorrelationEngine({
  processingInterval: 500, // Check less frequently (default: 100ms)
  bufferSize: 200, // Smaller buffers
  maxEvents: 2000, // Fewer events in memory
});

// 2. Implement processing throttling
class ThrottledEngine {
  constructor(options) {
    this.engine = new CorrelationEngine(options);
    this.lastProcessTime = 0;
    this.minProcessInterval = 200; // Minimum 200ms between processing
  }

  async *correlate(query) {
    for await (const correlation of this.engine.correlate(query)) {
      const now = Date.now();
      if (now - this.lastProcessTime < this.minProcessInterval) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            this.minProcessInterval - (now - this.lastProcessTime)
          )
        );
      }

      this.lastProcessTime = Date.now();
      yield correlation;
    }
  }
}

// 3. Use worker threads for CPU-intensive operations
const { Worker, isMainThread, parentPort } = require("worker_threads");

if (isMainThread) {
  // Main thread
  class WorkerBasedEngine {
    constructor() {
      this.worker = new Worker(__filename);
    }

    async correlate(query) {
      return new Promise((resolve) => {
        this.worker.postMessage({ query });
        this.worker.on("message", resolve);
      });
    }
  }
} else {
  // Worker thread
  parentPort?.on("message", async ({ query }) => {
    const engine = new CorrelationEngine({ maxEvents: 1000 });
    const results = [];

    for await (const correlation of engine.correlate(query)) {
      results.push(correlation);
    }

    parentPort?.postMessage(results);
  });
}
```

## Memory Management

### Memory Leak Detection

**Monitoring Memory Usage**:

```javascript
// Track memory over time
setInterval(() => {
  const usage = process.memoryUsage();
  console.log(`
    Heap Used: ${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB
    Heap Total: ${(usage.heapTotal / 1024 / 1024).toFixed(2)}MB
    RSS: ${(usage.rss / 1024 / 1024).toFixed(2)}MB
  `);
}, 5000);

// Set memory limit
const engine = new CorrelationEngine({
  maxMemoryMB: 50, // Limit to 50MB
});

engine.on("memoryWarning", ({ usedMB }) => {
  console.warn(`Memory usage high: ${usedMB}MB`);
  // Consider stopping correlation
});
```

### Out of Memory Errors

**Error**: `MEMORY_ERROR: Heap out of memory`

**Solutions**:

```javascript
// 1. Reduce buffer sizes
const engine = new CorrelationEngine({
  maxEvents: 1000, // Reduce from 10000
  bufferSize: 100, // Smaller buffers
  gcInterval: 10000, // More frequent GC
});

// 2. Enable streaming mode (don't accumulate results)
async function streamResults(query) {
  for await (const correlation of engine.correlate(query)) {
    // Process immediately, don't store
    await sendToDatabase(correlation);

    // Allow GC to clean up
    if (global.gc) global.gc();
  }
}

// 3. Use time-based cleanup
const engine = new CorrelationEngine({
  defaultTimeWindow: "1m", // Smaller windows
  cleanupInterval: 30000, // Clean old windows every 30s
});

// 4. Monitor and abort if needed
let eventCount = 0;
for await (const correlation of engine.correlate(query)) {
  eventCount++;
  if (eventCount > 10000) {
    console.warn("Too many events, aborting");
    break;
  }
}
```

## Data Source Adapter Problems

### Loki Adapter Issues

**Problem**: Events not being extracted properly from Loki streams.

**Solutions**:

```javascript
const { LokiAdapter } = require("@liquescent/log-correlator-adapters-loki");

// 1. Debug join key extraction
const adapter = new LokiAdapter({ url: "http://localhost:3100" });

// Test a single event to see what keys are extracted
for await (const event of adapter.createStream('{service="frontend"}', {
  timeRange: "1m",
})) {
  console.log("Raw message:", event.message);
  console.log("Extracted labels:", event.labels);
  console.log("Extracted join keys:", event.joinKeys);
  break; // Only check first event
}

// 2. Validate query syntax
if (!adapter.validateQuery('{service="frontend"}')) {
  console.error("Invalid Loki query syntax");
}

// 3. Check available streams
const streams = await adapter.getAvailableStreams();
console.log("Available label keys:", streams);
```

### Graylog Adapter Issues

**Problem**: Graylog queries returning unexpected results.

**Solutions**:

```javascript
const {
  GraylogAdapter,
} = require("@liquescent/log-correlator-adapters-graylog");

// 1. Test query conversion
const adapter = new GraylogAdapter({
  url: "http://localhost:9000",
  apiToken: "<YOUR_API_TOKEN>",
});

// Debug internal query conversion
console.log('Original query: service="backend"');
// Internally converts to: service:backend

// 2. Check field extraction
for await (const event of adapter.createStream("service:backend", {
  timeRange: "5m",
})) {
  console.log("Graylog fields:", Object.keys(event.labels));
  console.log("Join keys found:", event.joinKeys);
  break;
}

// 3. Validate stream access
const streams = await adapter.getAvailableStreams();
console.log("Available Graylog streams:", streams);
```

### Graylog 6.x API Issues

**Problem**: Queries fail with `GRAYLOG_SEARCH_ERROR` on Graylog 6.x deployments.

**Cause**: Graylog 6.x requires the Views Search API instead of Universal Search API.

**Solutions**:

```javascript
// 1. Configure for v6 API
const v6Adapter = new GraylogAdapter({
  url: "http://localhost:9000",
  apiToken: "<YOUR_API_TOKEN>", // Required for v6
  apiVersion: "v6", // Critical: Use v6 API
});

// 2. Test v6 API access manually
// The v6 API uses POST with specific JSON structure:
const testV6API = async () => {
  const response = await fetch(
    "http://localhost:9000/api/views/search/messages",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer <YOUR_API_TOKEN>",
        "Content-Type": "application/json",
        Accept: "text/csv", // v6 always returns CSV
        "X-Requested-By": "log-correlator",
      },
      body: JSON.stringify({
        query_string: {
          query_string: "*", // Note: nested structure required
        },
        timerange: {
          type: "relative",
          from: 300, // seconds ago, not milliseconds
        },
        fields_in_order: ["timestamp", "source", "message", "_id"],
        limit: 100,
        chunk_size: 100,
      }),
    }
  );

  if (response.ok) {
    const csvData = await response.text();
    console.log("v6 API working, received CSV data");
  } else {
    console.error("v6 API failed:", response.status, response.statusText);
  }
};

// 3. Common v6 migration issues:
// - Must use API token (username/password may not work)
// - Response is always CSV, never JSON
// - Time range format is different (seconds vs ISO strings)
// - Query structure uses nested query_string.query_string
```

## Configuration Issues

### Invalid Time Window Formats

**Problem**: `QUERY_PARSE_ERROR` when using time windows.

**Solutions**:

```javascript
// Valid time window formats
const validQueries = [
  'loki({service="app"})[5m]', // 5 minutes
  'loki({service="app"})[30s]', // 30 seconds
  'loki({service="app"})[2h]', // 2 hours
  'loki({service="app"})[1d]', // 1 day
];

// Invalid formats that will fail
const invalidQueries = [
  'loki({service="app"})[5 minutes]', // No spaces
  'loki({service="app"})[5min]', // Use 'm' not 'min'
  'loki({service="app"})[300]', // Must specify unit
];

// Test time window parsing
const { parseTimeWindow } = require("@liquescent/log-correlator-core");
try {
  const milliseconds = parseTimeWindow("5m");
  console.log("5m =", milliseconds, "milliseconds");
} catch (error) {
  console.error("Invalid time window:", error.message);
}
```

### Engine Configuration Conflicts

**Problem**: Memory warnings or performance issues due to misconfiguration.

**Solutions**:

```javascript
// 1. Validate configuration before use
function validateConfig(options) {
  const warnings = [];

  if (
    options.maxEvents &&
    options.bufferSize &&
    options.maxEvents < options.bufferSize
  ) {
    warnings.push("bufferSize should not exceed maxEvents");
  }

  if (options.maxMemoryMB && options.maxMemoryMB < 10) {
    warnings.push("maxMemoryMB too low, may cause frequent GC");
  }

  if (options.processingInterval && options.processingInterval < 50) {
    warnings.push("processingInterval too low, may cause high CPU usage");
  }

  return warnings;
}

const config = {
  defaultTimeWindow: "5m",
  maxEvents: 10000,
  bufferSize: 1000,
  maxMemoryMB: 100,
  processingInterval: 100,
};

const warnings = validateConfig(config);
if (warnings.length > 0) {
  console.warn("Configuration warnings:", warnings);
}

// 2. Use environment-appropriate configurations
const developmentConfig = {
  defaultTimeWindow: "2m",
  maxEvents: 1000,
  bufferSize: 100,
  maxMemoryMB: 50,
  processingInterval: 200,
};

const productionConfig = {
  defaultTimeWindow: "5m",
  maxEvents: 10000,
  bufferSize: 1000,
  maxMemoryMB: 200,
  processingInterval: 100,
  gcInterval: 60000,
};

const config =
  process.env.NODE_ENV === "production" ? productionConfig : developmentConfig;

const engine = new CorrelationEngine(config);
```

## Debugging Correlations

### Enable Debug Logging

```javascript
// 1. Set debug environment for detailed logging
process.env.DEBUG = "log-correlator:*";

// 2. Create engine with debug options
const engine = new CorrelationEngine({
  defaultTimeWindow: "5m",
  maxEvents: 1000,
  // Enable performance monitoring
  gcInterval: 30000,
});

// 3. Listen to correlation events
engine.on("correlationFound", (correlation) => {
  console.log("[CORRELATION]", {
    id: correlation.correlationId,
    joinValue: correlation.joinValue,
    eventCount: correlation.events.length,
    timeWindow: correlation.timeWindow,
    completeness: correlation.metadata.completeness,
  });
});

engine.on("memoryWarning", ({ usedMB, maxMB }) => {
  console.warn("[MEMORY]", `Usage: ${usedMB}MB / ${maxMB}MB`);
});

// 4. Add custom debugging
function debugQuery(query) {
  console.log("[DEBUG] Starting correlation for query:", query);

  return {
    async *correlate() {
      let correlationCount = 0;
      const startTime = Date.now();

      for await (const correlation of engine.correlate(query)) {
        correlationCount++;

        if (correlationCount % 100 === 0) {
          const elapsed = Date.now() - startTime;
          console.log(
            `[DEBUG] ${correlationCount} correlations in ${elapsed}ms`
          );
        }

        yield correlation;
      }

      const totalTime = Date.now() - startTime;
      console.log(
        `[DEBUG] Completed: ${correlationCount} correlations in ${totalTime}ms`
      );
    },
  };
}
```

### Trace Correlation Flow

```javascript
// Add trace IDs to track flow
engine.on("eventReceived", (event) => {
  event.traceId = generateTraceId();
  console.log(`[${event.traceId}] Received:`, event.source);
});

engine.on("eventBuffered", (event) => {
  console.log(`[${event.traceId}] Buffered in window`);
});

engine.on("correlationFound", (correlation) => {
  console.log(`Correlation found with ${correlation.events.length} events`);
  correlation.events.forEach((e) => {
    console.log(`  - [${e.traceId}] ${e.source}: ${e.message}`);
  });
});
```

### Inspect Time Windows

```javascript
// Monitor window lifecycle
engine.on("windowCreated", ({ windowId, start, end }) => {
  console.log(`Window ${windowId}: ${start} to ${end}`);
});

engine.on("windowClosed", ({ windowId, eventCount, correlationCount }) => {
  console.log(`Window ${windowId} closed:`, {
    events: eventCount,
    correlations: correlationCount,
  });
});

// Check for timing issues
engine.on("lateEvent", ({ event, windowEnd, delay }) => {
  console.warn(`Late event by ${delay}ms:`, event.timestamp);
});
```

## Error Codes Reference

| Code                    | Description                   | Common Causes                     | Solutions                                 |
| ----------------------- | ----------------------------- | --------------------------------- | ----------------------------------------- |
| `QUERY_PARSE_ERROR`     | Invalid query syntax          | Missing quotes, invalid operators | Validate query syntax, check examples     |
| `WEBSOCKET_MAX_RETRIES` | WebSocket reconnection failed | Network issues, server down       | Use polling mode, check connectivity      |
| `LOKI_QUERY_ERROR`      | Loki API request failed       | Invalid LogQL, server error       | Check query syntax, verify Loki status    |
| `GRAYLOG_SEARCH_ERROR`  | Graylog search failed         | Auth failure, invalid query       | Check credentials, validate query         |
| `AUTH_REQUIRED`         | Authentication missing        | Missing token/credentials         | Provide apiToken or username/password     |
| `ADAPTER_NOT_FOUND`     | Data source adapter missing   | Adapter not registered            | Register adapter with engine.addAdapter() |
| `ADAPTER_EXISTS`        | Adapter already registered    | Duplicate registration            | Use different name or check existing      |
| `MEMORY_ERROR`          | Memory limit exceeded         | Too many events buffered          | Reduce maxEvents, enable streaming        |
| `TIMEOUT_ERROR`         | Operation timeout             | Slow network, large dataset       | Increase timeout, reduce time window      |

### Error Handling Best Practices

```javascript
const { CorrelationError } = require("@liquescent/log-correlator-core");

async function handleCorrelation(engine, query) {
  try {
    const results = [];
    for await (const correlation of engine.correlate(query)) {
      results.push(correlation);
    }
    return results;
  } catch (error) {
    if (error instanceof CorrelationError) {
      switch (error.code) {
        case "QUERY_PARSE_ERROR":
          console.error("Invalid query syntax:", error.message);
          console.error("Details:", error.details);
          break;

        case "WEBSOCKET_MAX_RETRIES":
          console.error("WebSocket connection failed, falling back to polling");
          // Implement fallback logic
          break;

        case "MEMORY_ERROR":
          console.error("Memory limit exceeded, reducing buffer size");
          // Restart with smaller configuration
          break;

        case "AUTH_REQUIRED":
          console.error("Authentication required for data source");
          console.error("Configure apiToken or username/password");
          break;

        default:
          console.error("Correlation error:", error.code, error.message);
      }
    } else {
      console.error("Unexpected error:", error);
    }
    throw error;
  }
}
```

## Getting Help

### Enable Verbose Logging

```javascript
// Maximum verbosity
const engine = new CorrelationEngine({
  logLevel: "debug",
  debug: true,
});

// Custom logger
engine.setLogger({
  debug: (...args) => console.log("[DEBUG]", ...args),
  info: (...args) => console.log("[INFO]", ...args),
  warn: (...args) => console.warn("[WARN]", ...args),
  error: (...args) => console.error("[ERROR]", ...args),
});
```

### Collect Diagnostics

```javascript
// Generate diagnostic report
async function generateReport() {
  const report = {
    timestamp: new Date().toISOString(),
    version: require("@liquescent/log-correlator-core/package.json").version,
    node: process.version,
    memory: process.memoryUsage(),
    adapters: engine.getAdapters().map((a) => ({
      name: a.getName(),
      status: a.getStatus(),
    })),
    config: engine.getConfig(),
    stats: engine.getStatistics(),
  };

  require("fs").writeFileSync(
    "correlation-diagnostics.json",
    JSON.stringify(report, null, 2)
  );

  console.log("Diagnostic report saved");
  return report;
}
```

### Community Support

- GitHub Issues: Report bugs and feature requests
- Stack Overflow: Tag questions with `log-correlator`
- Documentation: Check `/docs` folder for detailed guides
