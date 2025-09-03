# Migration Guide

## Table of Contents

- [Version Migration](#version-migration)
- [Migrating from Other Tools](#migrating-from-other-tools)
- [Query Language Migration](#query-language-migration)
- [Adapter Migration](#adapter-migration)
- [Breaking Changes](#breaking-changes)
- [Deprecation Notices](#deprecation-notices)

## Version Migration

### Upgrading from v0.0.7 to v0.0.8 (TimeBridge API Changes)

#### New Unified Result Type (TimeQLResult)

The major change in v0.0.8 is the introduction of a unified result type with clear type discrimination:

```javascript
// OLD (v0.0.7 and earlier)
for await (const result of executor.execute(query)) {
  // result was either LogEvent or CorrelatedEvent
  // Required duck typing or instanceof checks
  if ('correlationId' in result) {
    // Handle CorrelatedEvent
    console.log('Correlation:', result.correlationId);
  } else {
    // Handle LogEvent
    console.log('Event:', result.message);
  }
}

// NEW (v0.0.8+)
for await (const result of executor.execute(query)) {
  // result is always TimeQLResult with type discriminator
  if (result.type === 'event') {
    // result.data is LogEvent
    console.log('Event:', result.data.message);
  } else if (result.type === 'correlation') {
    // result.data is CorrelatedEvent
    console.log('Correlation:', result.data.correlationId);
  }
}
```

#### New Type Guards for Better TypeScript Support

```typescript
// Import new type guards
import { isEventResult, isCorrelationResult } from '@timebridge/core';

// Type-safe processing
for await (const result of executor.execute(query)) {
  if (isEventResult(result)) {
    // TypeScript knows result.data is LogEvent
    const event: LogEvent = result.data;
    console.log(event.message);
  } else if (isCorrelationResult(result)) {
    // TypeScript knows result.data is CorrelatedEvent
    const correlation: CorrelatedEvent = result.data;
    console.log(correlation.correlationId);
  }
}
```

#### New Specific Query Methods

When you know the query type in advance, use specific methods for cleaner code:

```javascript
// OLD (v0.0.7) - Always used execute()
for await (const result of executor.execute(directQuery)) {
  // Had to check result type
}

// NEW (v0.0.8) - Use specific methods
// For direct queries (single data source)
for await (const event of executor.executeEvents("graylog(level:error)[5m]")) {
  // Directly returns LogEvent objects
  console.log(event.message);
}

// For correlation queries (multiple data sources)
for await (const correlation of executor.executeCorrelation(correlationQuery)) {
  // Directly returns CorrelatedEvent objects  
  console.log(correlation.correlationId);
}
```

#### Graylog Adapter Behavior Changes

Significant changes to Graylog query behavior:

```javascript
// OLD (v0.0.7) - All queries polled continuously
const adapter = new GraylogAdapter({
  url: "http://graylog.example.com",
  apiToken: "token",
  pollInterval: 2000, // Always used for all queries
});

for await (const event of executor.execute("graylog(level:error)[5m]")) {
  // Would poll forever, never complete
}

// NEW (v0.0.8) - Historical by default, continuous opt-in
const adapter = new GraylogAdapter({
  url: "http://graylog.example.com",
  apiToken: "token",
  maxResults: 5000, // NEW: Configurable result limit (default: 10000)
  pollInterval: 2000, // Only used when continuous: true
});

// Default: Historical snapshot (fetches once and completes)
for await (const result of executor.execute("graylog(level:error)[5m]")) {
  // Fetches last 5 minutes of data once, then completes
  // Perfect for correlation analysis
}

// Explicit continuous mode for real-time monitoring
for await (const result of executor.execute(
  "graylog(level:error)[5m]",
  { continuous: true }
)) {
  // Polls continuously like v0.0.7 behavior
}
```

#### Migration Script for v0.0.8

```javascript
// Automated migration helper for common patterns
function migrateToV008(oldCode) {
  return oldCode
    // Update result handling
    .replace(
      /for await \(const (\w+) of executor\.execute\(([^)]+)\)\) \{\s*if \('correlationId' in \1\)/g,
      'for await (const $1 of executor.execute($2)) {\n  if ($1.type === "correlation")'
    )
    .replace(
      /console\.log\(([^.]+)\.correlationId\)/g,
      'console.log($1.data.correlationId)'
    )
    .replace(
      /console\.log\(([^.]+)\.message\)/g,
      'console.log($1.data.message)'
    )
    // Add maxResults to Graylog adapters
    .replace(
      /(new GraylogAdapter\({[^}]*)(})/g,
      '$1,\n  maxResults: 10000 // Add result limit\n$2'
    );
}

// Example usage
const oldCode = `
for await (const event of executor.execute(query)) {
  if ('correlationId' in event) {
    console.log(event.correlationId);
  } else {
    console.log(event.message);
  }
}
`;

const newCode = migrateToV008(oldCode);
console.log('Migrated code:', newCode);
```

#### Breaking Changes Summary

1. **Result Structure**: All results are now wrapped in `TimeQLResult` with `type` and `data` fields
2. **Graylog Behavior**: Default changed from continuous polling to historical snapshots
3. **Type Checking**: Duck typing with `'correlationId' in result` replaced by `result.type === 'correlation'`
4. **New Required Imports**: Type guards `isEventResult` and `isCorrelationResult` for TypeScript users

#### Backward Compatibility

To maintain compatibility during migration:

```javascript
// Compatibility helper function
function unwrapResult(result) {
  // Handle both old and new result formats
  if (result.type && result.data) {
    // New v0.0.8 format
    return result.data;
  } else {
    // Old v0.0.7 format
    return result;
  }
}

// Use during migration period
for await (const result of executor.execute(query)) {
  const unwrapped = unwrapResult(result);
  
  if ('correlationId' in unwrapped) {
    // Handle correlation
  } else {
    // Handle event
  }
}
```

### Upgrading from 0.x to 1.0

#### Breaking Changes

```javascript
// OLD (0.x)
const engine = new CorrelationEngine();
engine.setTimeWindow(30000);
engine.setMaxEvents(10000);

// NEW (1.0)
const engine = new CorrelationEngine({
  timeWindow: 30000,
  maxEvents: 10000,
});
```

#### Configuration Changes

```javascript
// OLD (0.x)
const config = {
  window: 30000, // Changed
  events_max: 10000, // Changed
  late_tolerance: 5000, // Changed
};

// NEW (1.0)
const config = {
  timeWindow: 30000, // Renamed
  maxEvents: 10000, // Renamed
  lateTolerance: 5000, // Renamed
};
```

#### API Changes

```javascript
// OLD (0.x)
engine.addSource("loki", adapter);
const results = await engine.query(queryString);

// NEW (1.0)
engine.addAdapter("loki", adapter);
for await (const result of engine.correlate(queryString)) {
  // Streaming results
}
```

#### Migration Script

```javascript
// Automated migration helper
const { migrate } = require("@liquescent/log-correlator-core/migration");

// Migrate configuration
const oldConfig = {
  window: 30000,
  events_max: 10000,
  sources: ["loki", "graylog"],
};

const newConfig = migrate.config(oldConfig);
console.log("Migrated config:", newConfig);

// Migrate queries
const oldQuery = "loki.frontend & loki.backend on request_id";
const newQuery = migrate.query(oldQuery);
console.log("Migrated query:", newQuery);
```

### Upgrading from 1.0 to 2.0

#### New Features in 2.0

```javascript
// 1. Performance optimizations
const {
  EventDeduplicator,
  IndexedEventStore,
  ParallelProcessor,
} = require("@liquescent/log-correlator-core");

// 2. Enhanced query syntax
const query = `
  loki({service="frontend"})[5m]
    and on(request_id) within(30s) group_left(session_id)
    loki({service="backend"})[5m]
`;

// 3. Better TypeScript support
import {
  CorrelationEngine,
  CorrelationEngineOptions,
} from "@liquescent/log-correlator-core";

const options: CorrelationEngineOptions = {
  timeWindow: 30000,
  maxEvents: 10000,
};
```

#### Backward Compatibility

```javascript
// Enable v1 compatibility mode
const engine = new CorrelationEngine({
  compatibilityMode: "v1",
  // v1 style configuration still works
  window: 30000,
  events_max: 10000,
});

// Deprecation warnings will be logged
// [DEPRECATION] 'window' is deprecated, use 'timeWindow' instead
// [DEPRECATION] 'events_max' is deprecated, use 'maxEvents' instead
```

## Migrating from Other Tools

### From Splunk

#### Query Translation

```javascript
// Splunk query
const splunkQuery = `
  index=frontend request_id=* 
  | join request_id [search index=backend]
  | stats count by status
`;

// Equivalent log-correlator query
const correlatorQuery = `
  loki({job="frontend"})[5m] 
    and on(request_id) 
    loki({job="backend"})[5m]
`;

// Use migration helper
const { SplunkMigrator } = require("@liquescent/log-correlator-core/migration");
const migrator = new SplunkMigrator();

const translatedQuery = migrator.translateQuery(splunkQuery);
console.log("Translated query:", translatedQuery);
```

#### Data Source Migration

```javascript
// Splunk forwarder replacement
class SplunkForwarderAdapter {
  constructor(splunkConfig) {
    // Map Splunk configuration
    this.lokiAdapter = new LokiAdapter({
      url: this.mapUrl(splunkConfig.serverUrl),
      labels: this.mapIndexToLabels(splunkConfig.index),
    });
  }

  mapUrl(splunkUrl) {
    // Convert Splunk URL to Loki URL
    return splunkUrl
      .replace(":8089", ":3100")
      .replace("/services/collector", "");
  }

  mapIndexToLabels(index) {
    // Map Splunk index to Loki labels
    return {
      job: index,
      source: "splunk-migration",
    };
  }

  async *createStream(query, options) {
    // Translate and forward to Loki
    const lokiQuery = this.translateQuery(query);
    yield* this.lokiAdapter.createStream(lokiQuery, options);
  }
}
```

### From Elasticsearch/Kibana

#### Query Translation

```javascript
// Elasticsearch query
const esQuery = {
  bool: {
    must: [
      { match: { service: "frontend" } },
      { exists: { field: "request_id" } },
    ],
    filter: {
      range: {
        "@timestamp": {
          gte: "now-5m",
        },
      },
    },
  },
};

// Equivalent log-correlator query
const correlatorQuery = `
  loki({service="frontend"})[5m]
`;

// Migration helper
class ElasticsearchMigrator {
  translateQuery(esQuery) {
    const conditions = [];

    if (esQuery.bool?.must) {
      esQuery.bool.must.forEach((clause) => {
        if (clause.match) {
          const [field, value] = Object.entries(clause.match)[0];
          conditions.push(`${field}="${value}"`);
        }
      });
    }

    const timeRange = this.extractTimeRange(esQuery);
    const source = "loki"; // or 'graylog'

    return `${source}({${conditions.join(", ")}})[${timeRange}]`;
  }

  extractTimeRange(esQuery) {
    const range = esQuery.bool?.filter?.range?.["@timestamp"];
    if (range?.gte?.includes("now-")) {
      return range.gte.replace("now-", "");
    }
    return "5m";
  }
}
```

#### Index Pattern Migration

```javascript
// Map Elasticsearch indices to log-correlator streams
const indexMapping = {
  "logstash-frontend-*": 'loki({job="frontend"})',
  "logstash-backend-*": 'loki({job="backend"})',
  "application-*": "graylog(application:*)",
};

function migrateIndexPattern(pattern) {
  return indexMapping[pattern] || `loki({index="${pattern}"})`;
}
```

### From Fluentd/Fluent Bit

#### Configuration Migration

```yaml
# Fluentd configuration
<match app.**>
@type forward
<server>
host localhost
port 24224
</server>
</match>
```

```javascript
// Equivalent log-correlator configuration
const adapter = new LokiAdapter({
  url: "http://localhost:3100",
  labels: {
    source: "fluentd",
    tag: "app",
  },
  batchSize: 1000,
  flushInterval: 1000,
});

// Create Fluentd-compatible adapter
class FluentdAdapter {
  constructor(fluentConfig) {
    this.lokiAdapter = new LokiAdapter({
      url: this.mapFluentdToLoki(fluentConfig),
      transformEvent: this.transformFluentdEvent,
    });
  }

  transformFluentdEvent(fluentdEvent) {
    return {
      timestamp: new Date(fluentdEvent.time * 1000).toISOString(),
      message: fluentdEvent.record.message,
      labels: {
        tag: fluentdEvent.tag,
        ...fluentdEvent.record,
      },
    };
  }
}
```

## Query Language Migration

### LogQL to PromQL-style Joins

```javascript
// Pure LogQL (no correlation)
const logql = '{job="frontend"} |= "error"';

// PromQL-style correlation
const correlation = `
  loki({job="frontend"} |= "error")[5m]
    and on(request_id)
    loki({job="backend"})[5m]
`;

// Migration helper
function addCorrelation(logqlQuery, joinKey, secondStream) {
  return `
    loki(${logqlQuery})[5m]
      and on(${joinKey})
      ${secondStream}
  `;
}
```

### Grafana Query Migration

```javascript
// Grafana explore query
const grafanaQuery = {
  expr: '{job="frontend"} |= "error" | json | line_format "{{.message}}"',
  refId: "A",
  datasource: "Loki",
};

// Convert to correlation query
function migrateGrafanaQuery(grafanaQuery) {
  const baseQuery = grafanaQuery.expr.split("|")[0].trim();

  return {
    source: grafanaQuery.datasource.toLowerCase(),
    selector: baseQuery,
    processors: grafanaQuery.expr
      .split("|")
      .slice(1)
      .map((p) => p.trim()),
    timeRange: "5m", // Default
  };
}

// Build correlation query
const migrated = migrateGrafanaQuery(grafanaQuery);
const correlationQuery = `
  ${migrated.source}(${migrated.selector})[${migrated.timeRange}]
`;
```

## Adapter Migration

### Custom Adapter Migration

```javascript
// OLD: Custom adapter for v0.x
class OldCustomAdapter {
  async fetchLogs(query, startTime, endTime) {
    // Fetch implementation
  }
}

// NEW: Migrated adapter for v1.0+
class NewCustomAdapter {
  constructor(oldAdapter) {
    this.oldAdapter = oldAdapter;
  }

  async *createStream(query, options = {}) {
    const { timeRange = "5m" } = options;
    const endTime = Date.now();
    const startTime = endTime - parseTimeWindow(timeRange);

    // Convert old fetch to streaming
    const logs = await this.oldAdapter.fetchLogs(query, startTime, endTime);

    for (const log of logs) {
      yield this.transformLog(log);
    }
  }

  transformLog(oldLog) {
    return {
      timestamp: oldLog.timestamp || oldLog.time || new Date().toISOString(),
      message: oldLog.message || oldLog.msg || "",
      labels: oldLog.labels || oldLog.fields || {},
      joinKeys: this.extractJoinKeys(oldLog),
      source: "custom",
    };
  }

  extractJoinKeys(log) {
    // Extract potential join keys
    const keys = {};
    const patterns = [
      /request[_-]?id[:=]\s*["']?([^"'\s]+)/i,
      /trace[_-]?id[:=]\s*["']?([^"'\s]+)/i,
      /session[_-]?id[:=]\s*["']?([^"'\s]+)/i,
    ];

    const text = JSON.stringify(log);
    patterns.forEach((pattern, index) => {
      const match = text.match(pattern);
      if (match) {
        const keyName = ["request_id", "trace_id", "session_id"][index];
        keys[keyName] = match[1];
      }
    });

    return keys;
  }

  validateQuery(query) {
    // Add validation
    return true;
  }

  getName() {
    return "custom";
  }

  async destroy() {
    // Cleanup
  }
}
```

### WebSocket to Polling Migration

```javascript
// Graceful degradation from WebSocket to polling
class AdaptiveAdapter {
  constructor(config) {
    this.config = config;
    this.useWebSocket = config.websocket !== false;
    this.wsRetries = 0;
    this.maxWsRetries = 3;
  }

  async *createStream(query, options) {
    if (this.useWebSocket && this.wsRetries < this.maxWsRetries) {
      try {
        yield* this.createWebSocketStream(query, options);
      } catch (error) {
        console.warn("WebSocket failed, falling back to polling:", error);
        this.wsRetries++;

        if (this.wsRetries >= this.maxWsRetries) {
          this.useWebSocket = false;
        }

        yield* this.createPollingStream(query, options);
      }
    } else {
      yield* this.createPollingStream(query, options);
    }
  }

  async *createWebSocketStream(query, options) {
    // WebSocket implementation
  }

  async *createPollingStream(query, options) {
    // Polling implementation
  }
}
```

## Breaking Changes

### Version 2.0 Breaking Changes

```javascript
// 1. Stream interface changes
// OLD
adapter.fetchLogs(query, callback);

// NEW
for await (const log of adapter.createStream(query)) {
  // Process log
}

// 2. Event structure changes
// OLD
{
  time: 1234567890,
  msg: 'Log message',
  fields: { request_id: 'abc' }
}

// NEW
{
  timestamp: '2025-08-10T10:30:00.123Z',
  message: 'Log message',
  labels: { request_id: 'abc' },
  joinKeys: { request_id: 'abc' }
}

// 3. Configuration structure
// OLD
{
  adapters: {
    loki: { url: 'http://localhost:3100' }
  }
}

// NEW
// Adapters are added programmatically
engine.addAdapter('loki', new LokiAdapter({ url: 'http://localhost:3100' }));

// 4. Error handling
// OLD
engine.on('error', (error) => {
  console.error(error.message);
});

// NEW
try {
  for await (const correlation of engine.correlate(query)) {
    // Process
  }
} catch (error) {
  if (error instanceof CorrelationError) {
    // Handle specific error
  }
}
```

### Version 3.0 Planned Changes

```javascript
// Future deprecations (planned for v3.0)
// These will show warnings in v2.x

// 1. Callback-style APIs will be removed
// DEPRECATED
engine.correlate(query, (error, results) => {});

// USE INSTEAD
for await (const result of engine.correlate(query)) {
}

// 2. Synchronous methods will be async
// DEPRECATED
const valid = engine.validateQuery(query);

// USE INSTEAD
const valid = await engine.validateQuery(query);

// 3. Global configuration will be removed
// DEPRECATED
CorrelationEngine.setGlobalConfig({ maxMemoryMB: 100 });

// USE INSTEAD
const engine = new CorrelationEngine({ maxMemoryMB: 100 });
```

## Deprecation Notices

### Current Deprecations

```javascript
// These features are deprecated and will be removed in the next major version

// 1. Old configuration keys (use new names)
const engine = new CorrelationEngine({
  window: 30000, // DEPRECATED: use 'timeWindow'
  events_max: 10000, // DEPRECATED: use 'maxEvents'
  late_tolerance: 5000, // DEPRECATED: use 'lateTolerance'
});

// 2. Synchronous query validation (use async)
if (engine.validateQuery(query)) {
  // DEPRECATED
  // ...
}

// Use async version
if (await engine.validateQuery(query)) {
  // RECOMMENDED
  // ...
}

// 3. Direct event emission for results (use async iteration)
engine.on("correlation", handler); // DEPRECATED

// Use async iteration
for await (const correlation of engine.correlate(query)) {
  // RECOMMENDED
  handler(correlation);
}
```

### Deprecation Timeline

| Feature                  | Deprecated In | Removed In | Alternative         |
| ------------------------ | ------------- | ---------- | ------------------- |
| Direct result unwrapping | v0.0.8        | v0.1.0     | TimeQLResult.data   |
| Duck typing checks       | v0.0.8        | v0.1.0     | result.type checks  |
| Continuous by default    | v0.0.8        | v0.1.0     | { continuous: true }|
| Callback APIs            | v2.0          | v3.0       | Async/await         |
| Old config keys          | v1.0          | v2.0       | New key names       |
| Sync validation          | v2.0          | v3.0       | Async validation    |
| Event-based results      | v2.0          | v3.0       | Async iteration     |
| Global config            | v2.0          | v3.0       | Instance config     |

### Handling Deprecation Warnings

```javascript
// Suppress deprecation warnings (not recommended)
process.env.SUPPRESS_DEPRECATIONS = "true";

// Or selectively
process.env.SUPPRESS_DEPRECATIONS = "validateQuery,window";

// Log deprecations to file
const fs = require("fs");
const deprecationLog = fs.createWriteStream("deprecations.log");

process.on("deprecation", (warning) => {
  deprecationLog.write(`${new Date().toISOString()} - ${warning.message}\n`);
});

// Monitor deprecation usage
const deprecations = new Map();

process.on("deprecation", (warning) => {
  const count = deprecations.get(warning.code) || 0;
  deprecations.set(warning.code, count + 1);
});

process.on("exit", () => {
  console.log("Deprecation usage:");
  for (const [code, count] of deprecations) {
    console.log(`  ${code}: ${count} times`);
  }
});
```

## Migration Checklist

### Pre-Migration

- [ ] Review breaking changes for target version
- [ ] Audit current usage for deprecated features
- [ ] Test in development environment
- [ ] Create rollback plan
- [ ] Document custom modifications

### During Migration

- [ ] Update package versions
- [ ] Run migration scripts
- [ ] Update configuration files
- [ ] Modify query syntax if needed
- [ ] Update adapter implementations
- [ ] Fix TypeScript/ESLint errors
- [ ] Run test suite

### Post-Migration

- [ ] Verify functionality in staging
- [ ] Monitor performance metrics
- [ ] Check for deprecation warnings
- [ ] Update documentation
- [ ] Train team on new features
- [ ] Plan for next version

## Support

### Getting Help

```javascript
// Check current version
const { version } = require("@liquescent/log-correlator-core/package.json");
console.log("Current version:", version);

// Run migration diagnostic
const { runDiagnostic } = require("@liquescent/log-correlator-core/migration");

const report = await runDiagnostic();
console.log("Migration diagnostic:", report);

// Get migration recommendations
if (report.issues.length > 0) {
  console.log("Recommended fixes:");
  report.issues.forEach((issue) => {
    console.log(`- ${issue.description}: ${issue.fix}`);
  });
}
```

### Common Migration Issues

1. **Module not found**: Clear node_modules and reinstall
2. **Type errors**: Update TypeScript to latest version
3. **Query parse errors**: Use query migration helpers
4. **Performance degradation**: Review performance tuning guide
5. **Memory leaks**: Check for old event listeners

### Resources

- [API Documentation](./API.md)
- [Performance Tuning](./PERFORMANCE.md)
- [Troubleshooting Guide](./TROUBLESHOOTING.md)
- [GitHub Issues](https://github.com/liquescent/log-correlator/issues)
- [Migration Examples](../examples/migration/)
