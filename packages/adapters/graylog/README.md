# Graylog Adapter for TimeBridge

This adapter enables TimeBridge to connect to and consume logs from Graylog instances.

## Installation

```bash
npm install @timebridge/graylog@^0.0.7
```

## What's New in v0.0.8

- **Unified TimeQLResult API**: All queries now return `TimeQLResult` with clear type discrimination
- **Historical vs Continuous Queries**: Default behavior changed to historical snapshots for better correlation
- **maxResults Option**: Configurable result limits (default: 10000) for better performance
- **Type Guards**: New `isEventResult()` and `isCorrelationResult()` for type-safe processing
- **Specific Query Methods**: New `executeEvents()` and `executeCorrelation()` methods

### Previous Updates (v0.0.7)

- **Stream Name Support**: Filter logs by human-readable stream names instead of IDs
- **Enhanced Security**: Complete elimination of ReDoS vulnerabilities
- **Improved Query Sanitization**: Robust handling of malformed queries without regex
- **Universal Field Extraction**: Compatible with multiple Graylog response structures for reliable field extraction

## Supported Graylog Versions

The adapter supports multiple Graylog versions through configurable API endpoints:

- **Graylog 2.x - 5.x**: Uses the Universal Search API (`/api/search/universal/relative`)
- **Graylog 6.x+**: Uses the Views Search API (`/api/views/search/messages`)

## Configuration

```javascript
const { GraylogAdapter } = require("@timebridge/graylog");

// For Graylog 2.x - 5.x (default)
const legacyAdapter = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  username: "admin",
  password: "password",
  apiVersion: "legacy", // Optional, this is the default
  maxResults: 5000, // New: Maximum results per query (default: 10000)
  pollInterval: 2000, // Poll every 2 seconds (only used for continuous queries)
  timeout: 15000, // 15 second timeout
});

// For Graylog 6.x+ with enhanced options (Updated in v0.0.8!)
const v6Adapter = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  apiToken: "your-api-token", // API token recommended for v6
  apiVersion: "v6", // Required for Graylog 6.x
  maxResults: 8000, // NEW: Configurable result limit (default: 10000)
  pollInterval: 2000, // Only used when continuous: true is specified
  streamName: "Application Logs", // Filter by human-readable stream name
});

// Or use stream ID directly if you know it (24-char MongoDB ObjectId)
const v6AdapterWithId = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  apiToken: "your-api-token",
  apiVersion: "v6",
  streamId: "507f1f77bcf86cd799439011", // Must be valid 24-char hex string
});
```

## Authentication

The adapter supports two authentication methods:

1. **Basic Authentication** (username/password)
2. **API Token Authentication** (recommended for production)

```javascript
// Basic auth
const adapter = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  username: "admin",
  password: "password",
});

// API token
const adapter = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  apiToken: "your-api-token",
});
```

## API Endpoints Used

### Legacy API (Graylog 2.x - 5.x)

- `GET /api/search/universal/relative` - Search for log messages
- `GET /api/streams` - List available streams

### Views API (Graylog 6.x+)

- `POST /api/views/search/messages` - Search for log messages with CSV response
- `GET /api/streams` - List available streams

The v6 API requires a specific nested request structure with these key differences:

- Uses `query_string.query_string` (nested structure) instead of a simple query parameter
- Timerange uses `type: "relative"` with `from: <seconds>` format
- Uses `fields_in_order` instead of `fields` for field specification
- Always returns CSV format (Accept: "text/csv") instead of JSON
- Supports optional `streams` array for filtering by stream IDs

#### Graylog v6 API Request Structure

The adapter sends requests to `/api/views/search/messages` with this exact structure:

```json
{
  "query_string": {
    "query_string": "*"
  },
  "timerange": {
    "type": "relative",
    "from": 300
  },
  "fields_in_order": ["timestamp", "source", "message", "_id"],
  "limit": 1000,
  "chunk_size": 1000,
  "streams": ["optional-stream-id"]
}
```

**Key Requirements:**

- The `query_string.query_string` nesting is required (not a typo)
- `timerange.from` must be in seconds (e.g., 300 for last 5 minutes)
- `timerange.type` must be "relative" for relative time queries
- Response is always in CSV format regardless of Accept header
- Stream filtering is done via the `streams` array, not query parameters

## Query Behavior: Historical vs Continuous (v0.0.8+)

The adapter now has two distinct modes to match PromQL/LogQL semantics:

### Historical Queries (Default)

By default, queries fetch a snapshot of historical data and complete:

```javascript
// Fetches last 5 minutes of error logs once and completes
for await (const result of executor.execute("graylog(level:error)[5m]")) {
  // Processes historical data, then stream ends
  console.log('Historical event:', result.data.message);
}

// Perfect for:
// - Correlation analysis across time windows
// - Batch processing of historical data  
// - One-time analysis and reporting
// - Integration with correlation engines
```

### Continuous Queries (Explicit Opt-in)

For real-time monitoring, explicitly enable continuous polling:

```javascript
// Continuously polls for new data every pollInterval
for await (const result of executor.execute(
  "graylog(level:error)[5m]",
  { continuous: true }
)) {
  // Stream never ends, keeps polling for new data
  console.log('Live event:', result.data.message);
}

// Perfect for:
// - Real-time monitoring and alerting
// - Live dashboards
// - Continuous event processing
// - Long-running monitoring processes
```

### Why This Change?

- **Consistent with PromQL/LogQL**: Time ranges like `[5m]` now mean "data from the last 5 minutes" (snapshot)
- **Better for Correlation**: Historical queries work better with correlation engines
- **Predictable Resource Usage**: Historical queries have bounded memory usage
- **Explicit Intent**: Continuous polling requires explicit opt-in

## Query Syntax

The adapter converts simplified query syntax to Graylog query format:

```javascript
// Simple field queries
"service:frontend";
"level:error";

// Quoted values
'service="frontend"';
'message="error occurred"';

// Boolean operators
"service:frontend AND level:error";
"service:frontend OR service:backend";
```

## Usage Example

### Recommended: Using TimeQLExecutor (Updated for v0.0.8)

The `TimeQLExecutor` now returns unified `TimeQLResult` objects with clear type discrimination:

```javascript
const { TimeQLExecutor } = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");

const executor = new TimeQLExecutor({
  timeWindow: 30000,
  maxEvents: 10000,
});

// Register multiple Graylog instances with enhanced options
executor.addAdapter(
  "graylog-prod",
  new GraylogAdapter({
    url: "http://prod.graylog.example.com:9000",
    apiToken: "prod-token",
    apiVersion: "v6",
    streamName: "Production Logs", // v0.0.7+: Use stream names!
    maxResults: 5000, // v0.0.8+: Configurable result limit
  })
);

executor.addAdapter(
  "graylog-staging",
  new GraylogAdapter({
    url: "http://staging.graylog.example.com:9000",
    apiToken: "staging-token",
    apiVersion: "v6",
    streamName: "Staging Logs",
    maxResults: 3000, // Different limits per environment
  })
);

// Historical query (default) - fetches data once and completes
for await (const result of executor.execute("graylog-prod(level:error)[5m]")) {
  if (result.type === 'event') {
    const event = result.data;
    console.log(`[${event.timestamp}] ${event.message}`);
    console.log(`Join Keys:`, event.joinKeys); // Contains request_id, trace_id, etc.
  }
}

// Continuous query - polls for new data (explicit opt-in)
for await (const result of executor.execute(
  "graylog-prod(level:critical)[1m]",
  { continuous: true }
)) {
  if (result.type === 'event') {
    console.log(`🚨 Critical alert: ${result.data.message}`);
  }
}

// Correlation query - returns correlated events
const correlationQuery = `
  graylog-prod(service:api AND level:error)[5m]
    and on(request_id)
  graylog-staging(service:api)[5m]
`;

for await (const result of executor.execute(correlationQuery)) {
  if (result.type === 'correlation') {
    const correlation = result.data;
    console.log(`Correlation: ${correlation.correlationId}`);
    console.log(
      `Joined ${correlation.events.length} events on ${correlation.joinKey}=${correlation.joinValue}`
    );

    correlation.events.forEach((event) => {
      console.log(`  [${event.source}] ${event.message}`);
    });
  }
}

// Alternative: Use specific methods when query type is known
for await (const event of executor.executeEvents("graylog-prod(level:error)[5m]")) {
  // Directly returns LogEvent objects
  console.log(event.message);
}

for await (const correlation of executor.executeCorrelation(correlationQuery)) {
  // Directly returns CorrelatedEvent objects
  console.log(correlation.correlationId);
}
```

### Advanced: Using TimeBridgeEngine

For correlation-specific use cases, you can use `TimeBridgeEngine` directly:

```javascript
const { TimeBridgeEngine } = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");

const engine = new TimeBridgeEngine();

engine.addAdapter(
  "graylog",
  new GraylogAdapter({
    url: "http://graylog.example.com:9000",
    apiToken: "your-token",
    apiVersion: "v6",
    streamName: "Production Logs",
  })
);

// Correlation query only
const correlationQuery = `
  graylog(traceId:trace_12345)[1h] 
  and on(traceId) 
  graylog(service:database)[1h]
`;

for await (const event of engine.correlate(correlationQuery)) {
  console.log("Correlated event:", event);
}
```

## Features

- **Unified TimeQLResult API**: Returns `TimeQLResult` objects with clear type discrimination (v0.0.8+)
- **Historical vs Continuous**: Default historical snapshots with optional continuous polling (v0.0.8+)
- **Configurable Result Limits**: `maxResults` option for performance tuning (v0.0.8+)
- **Smart Query Support**: Works with TimeQLExecutor for automatic query type detection
- **Multi-Instance Support**: Register multiple Graylog instances with different names
- **Type Guards**: Built-in `isEventResult()` and `isCorrelationResult()` functions (v0.0.8+)
- **Specific Query Methods**: `executeEvents()` and `executeCorrelation()` for known query types (v0.0.8+)
- **Automatic retry**: Handles transient failures with exponential backoff
- **Join key extraction**: Automatically extracts correlation IDs from log messages
- **Stream filtering**: Filter logs by stream name or ID (v0.0.7+ supports names!)
- **Time window support**: Configure time ranges for log queries
- **Stream name resolution**: Automatically converts stream names to IDs (v0.0.7+)
- **Type-safe results**: Full TypeScript support with discriminated unions

## Stream Name Support (v0.0.7+)

The adapter now supports filtering by human-readable stream names instead of MongoDB ObjectIDs:

```javascript
// Before v0.0.7 - required stream ID
const adapter = new GraylogAdapter({
  streamId: "507f1f77bcf86cd799439011", // Hard to remember!
});

// v0.0.7+ - use stream names
const adapter = new GraylogAdapter({
  streamName: "Production Logs", // Much better!
});

// The adapter automatically resolves the name to ID
// If multiple streams have the same name, the first match is used
// Stream resolution happens once at adapter initialization
```

## Correlation Query Support

The Graylog adapter fully supports correlation queries when used with the TimeBridgeEngine. This enables powerful log correlation scenarios:

### Basic Correlation

```javascript
// Find all logs with a specific trace ID across services
const query = `
  graylog(traceId:abc123)[1h] 
  and on(traceId) 
  graylog(service:backend)[1h]
`;
```

### Multi-Service Correlation

```javascript
// Correlate errors across frontend and backend by request ID
const query = `
  graylog(service:frontend AND level:error)[30m]
  and on(request_id)
  graylog(service:backend)[30m]
`;
```

### Time Window Correlation

```javascript
// Different time windows for different services
const query = `
  graylog(service:loadbalancer)[5m]
  and on(session_id)
  graylog(service:application)[1h]
`;
```

### How It Works

1. **Query Parsing**: The TimeBridgeEngine parses the correlation query syntax
2. **Adapter Calls**: Each `graylog()` segment calls the adapter's `createStream()` method
3. **Join Key Extraction**: The adapter automatically extracts correlation IDs (request_id, trace_id, etc.) as `joinKeys`
4. **Correlation**: The engine correlates events based on matching join keys
5. **Result Stream**: Correlated events are returned as an async iterable

### Field Extraction and Label Mapping

The adapter automatically extracts all Graylog fields into labels for correlation and filtering. The field extraction is compatible with different Graylog response structures:

**Supported Response Structures:**
1. **Standard Structure**: Fields in `message.fields` object (most common)
2. **Direct Structure**: Fields directly on `message` object (some Graylog configurations)

**Field Processing:**
- All custom fields become available as `labels` in LogEvent objects
- System fields are excluded (`_id`, `gl2_message_id`, `streams`, `decoration_stats`)
- Field values are converted to strings for consistent correlation
- Empty or null fields are skipped

**Example Field Extraction:**
```javascript
// Graylog message with fields in message.fields
{
  "_id": "abc123",
  "timestamp": "2023-04-05T10:15:00.000Z",
  "message": "User login successful",
  "source": "auth-service",
  "fields": {
    "user_id": "user123",
    "session_id": "sess456",
    "client_ip": "192.168.1.100",
    "level": "info"
  }
}

// Graylog message with fields directly on message object
{
  "_id": "def456", 
  "timestamp": "2023-04-05T10:15:00.000Z",
  "message": "Database query executed",
  "source": "db-service",
  "user_id": "user123",
  "request_id": "req789",
  "query_time": 150,
  "level": "debug"
}

// Both structures result in LogEvent with extracted labels:
{
  "timestamp": "2023-04-05T10:15:00.000Z",
  "source": "graylog",
  "stream": "auth-service",
  "message": "User login successful",
  "labels": {
    "user_id": "user123",
    "session_id": "sess456", // or "request_id": "req789" 
    "client_ip": "192.168.1.100", // or "query_time": "150"
    "level": "info" // or "level": "debug"
  },
  "joinKeys": {
    "user_id": "user123",
    "session_id": "sess456" // or "request_id": "req789"
  }
}
```

### Join Key Detection

The adapter automatically detects and extracts common correlation IDs from extracted fields:

- Fields ending with `_id` (e.g., `request_id`, `trace_id`, `session_id`)
- Fields containing `correlation` or `trace`
- Pattern matching in message content (e.g., `request-id=abc123`)

These are exposed in the `joinKeys` property of each LogEvent for correlation.

## Options

| Option         | Type             | Default  | Description                                |
| -------------- | ---------------- | -------- | ------------------------------------------ |
| `url`          | string           | required | Graylog server URL                         |
| `username`     | string           | -        | Username for basic auth                    |
| `password`     | string           | -        | Password for basic auth                    |
| `apiToken`     | string           | -        | API token for token auth                   |
| `apiVersion`   | 'legacy' \| 'v6' | 'legacy' | API version to use                         |
| `maxResults`   | number           | 10000    | **NEW v0.0.8**: Maximum results per query |
| `pollInterval` | number           | 2000     | Polling interval (only for continuous queries) |
| `timeout`      | number           | 15000    | Request timeout in milliseconds            |
| `maxRetries`   | number           | 3        | Maximum retry attempts                     |
| `streamId`     | string           | -        | Stream ID (24-char MongoDB ObjectId)       |
| `streamName`   | string           | -        | Stream name (automatically resolved to ID) |
| `proxy`        | object           | -        | SOCKS proxy configuration                  |

## SOCKS Proxy Support

The Graylog adapter supports connecting through SOCKS4/SOCKS5 proxies, which is useful for accessing Graylog instances in restricted network environments:

```javascript
const adapter = new GraylogAdapter({
  url: "http://graylog.internal:9000",
  apiToken: "your-token",
  apiVersion: "v6",
  proxy: {
    host: "127.0.0.1",
    port: 1080,
    type: 5, // SOCKS5 (default) or 4 for SOCKS4
    username: "proxyuser", // Optional
    password: "proxypass", // Optional
  },
});
```

### Proxy Configuration Options

| Option           | Type   | Default  | Description                       |
| ---------------- | ------ | -------- | --------------------------------- |
| `proxy.host`     | string | required | SOCKS proxy hostname or IP        |
| `proxy.port`     | number | required | SOCKS proxy port                  |
| `proxy.type`     | 4 \| 5 | 5        | SOCKS protocol version            |
| `proxy.username` | string | -        | Username for proxy authentication |
| `proxy.password` | string | -        | Password for proxy authentication |

### Use Cases

- Accessing internal Graylog instances from external networks
- Connecting through bastion hosts or jump servers
- Complying with enterprise security policies
- Tunneling through firewalls in restricted environments

## Version-Specific Notes

### Graylog 6.x Permissions

For Graylog 6.x, ensure your user has access to:

- The Views Search API (`/api/views/search/messages`)
- Read permissions on the streams you want to query
- Export permissions if your Graylog deployment restricts CSV exports

The v6 API is significantly different from the legacy Universal Search API:

- It only returns CSV data (not JSON)
- The request structure uses nested `query_string.query_string` format
- Timerange format is different (relative seconds vs. absolute timestamps)
- Field selection uses `fields_in_order` array instead of comma-separated string
- Query parser is stricter:
  - Wildcard `*` cannot be the first character in a query
  - Empty field queries (e.g., `field:`) must be written as `field:*`
  - Invalid query syntax will result in parse errors

The adapter automatically handles these differences, including query sanitization for v6 compatibility.

### Migration from Legacy to v6

When upgrading from legacy to v6 API, simply change the `apiVersion` setting:

```javascript
// Before (Graylog 2.x-5.x)
apiVersion: "legacy";

// After (Graylog 6.x+)
apiVersion: "v6";
```

The adapter handles all the underlying API differences automatically.

## Integration Testing

The Graylog adapter includes comprehensive integration tests that can be run against a live Graylog instance to verify functionality.

### Setting Up Integration Tests

1. **Copy the environment template:**

   ```bash
   cp .env.example .env
   ```

2. **Configure your Graylog connection:**
   Edit `.env` with your Graylog instance details:

   ```bash
   GRAYLOG_URL=http://your-graylog-server:9000
   GRAYLOG_API_VERSION=v6  # or 'legacy' for older versions
   GRAYLOG_USERNAME=your-username
   GRAYLOG_PASSWORD=your-password
   # Or use API token instead:
   # GRAYLOG_API_TOKEN=your-api-token
   ```

3. **Optional: Configure SOCKS proxy (for restricted networks):**

   ```bash
   SOCKS_PROXY_HOST=127.0.0.1
   SOCKS_PROXY_PORT=1080
   SOCKS_PROXY_TYPE=5
   SOCKS_PROXY_USERNAME=proxyuser
   SOCKS_PROXY_PASSWORD=proxypass
   ```

4. **Customize test queries for your data:**
   Update the query environment variables to match your log data:
   ```bash
   GRAYLOG_QUERY_ERRORS=level:error
   GRAYLOG_QUERY_SERVICE=source:your-service
   GRAYLOG_CORRELATION_FIELD=your_correlation_field
   ```

### Running Integration Tests

```bash
# Run integration tests
npm run test:integration

# Run with verbose output
GRAYLOG_TEST_VERBOSE=true npm run test:integration

# Save test results to file
GRAYLOG_SAVE_RESULTS=true npm run test:integration
```

### Test Configuration Options

The integration tests support extensive configuration through environment variables:

- **Connection Settings:** Server URL, API version, authentication
- **Query Customization:** Define test queries that match your data
- **Field Mappings:** Map Graylog fields to standard names
- **Test Behavior:** Timeouts, result limits, verbose logging
- **Debug Options:** Save results, log raw responses

See `.env.example` for the complete list of configuration options.

### Test Coverage

The integration tests verify:

- ✅ Connection and authentication (basic auth and API tokens)
- ✅ Simple and complex query execution
- ✅ Field extraction and correlation ID detection
- ✅ Time range filtering
- ✅ Stream filtering by name or ID
- ✅ Error handling and timeout scenarios
- ✅ Performance with large result sets
- ✅ SOCKS proxy connectivity

### Using a Local Configuration

For local development, create `graylog.config.local.js` (gitignored) to override the default configuration:

```javascript
module.exports = {
  connection: {
    url: "http://localhost:9000",
    username: "admin",
    password: "admin",
    apiVersion: "v6",
    streamName: "My Test Stream",
  },
  queries: {
    simple: {
      errorLogs: "level:error",
      warningLogs: "level:warn",
    },
  },
  testConfig: {
    verbose: true,
    maxEventsPerTest: 50,
  },
};
```

### Troubleshooting Integration Tests

1. **Connection errors:** Verify your Graylog URL and network connectivity
2. **Authentication failures:** Check your credentials or API token
3. **No results returned:** Adjust your test queries to match existing data
4. **Stream not found:** Verify the stream name or ID exists in Graylog
5. **Proxy issues:** Ensure your SOCKS proxy is running and accessible

## Troubleshooting Field Extraction

### Issue: Fields Not Appearing in Labels

If expected fields are not showing up in the `labels` property of LogEvent objects, check the following:

**Problem:** Missing custom fields in correlation queries
```javascript
// Fields not available for correlation
const event = {
  labels: {}, // Empty - fields not extracted
  joinKeys: {} // No join keys available
};
```

**Solution 1:** Verify Graylog Response Structure
```javascript
// Check your Graylog version and configuration
// Some Graylog instances return fields differently:

// Structure 1 (Standard): message.fields contains custom fields
{
  "_id": "abc123",
  "message": "Log message",  
  "timestamp": "2023-04-05T10:15:00.000Z",
  "source": "service-name",
  "fields": {          // ← Custom fields here
    "user_id": "123",
    "level": "info"
  }
}

// Structure 2 (Direct): custom fields directly on message object  
{
  "_id": "abc123",
  "message": "Log message",
  "timestamp": "2023-04-05T10:15:00.000Z", 
  "source": "service-name",
  "user_id": "123",    // ← Custom fields here
  "level": "info"      // ← Custom fields here
}
```

**Solution 2:** Check Field Names
Ensure field names don't conflict with system fields that are excluded:
- `_id`, `gl2_message_id`, `streams`, `decoration_stats` are always excluded
- `message`, `timestamp`, `source`, `fields` are handled separately

**Solution 3:** Verify Field Types
Only string, number, and boolean values are extracted as labels:
```javascript
// These field types are extracted:
{
  "user_id": "string_value",     // ✅ Extracted
  "count": 42,                   // ✅ Extracted (converted to "42")
  "enabled": true,               // ✅ Extracted (converted to "true") 
  "metadata": { "nested": "object" }, // ❌ Skipped (object)
  "tags": ["tag1", "tag2"],      // ❌ Skipped (array)
  "empty_field": null            // ❌ Skipped (null)
}
```

**Solution 4:** Enable Debug Logging
Add debug logging to inspect raw Graylog responses:
```javascript
const adapter = new GraylogAdapter({
  url: 'http://graylog.example.com:9000',
  apiToken: 'your-token',
  // Add debug option if available in your version
});

// Check the actual response structure from your Graylog instance
// Look for how fields are organized in the JSON response
```

### Issue: Correlation Not Finding Matches

**Problem:** Events don't correlate even when they should have matching fields

**Solution:** Verify join keys are being extracted
```javascript
// Check that your correlation fields are being detected as joinKeys
for await (const event of executor.execute('graylog(service:api)[5m]')) {
  console.log('Available labels:', Object.keys(event.labels));
  console.log('Join keys:', Object.keys(event.joinKeys));
  
  // Look for your correlation field:
  if (!event.joinKeys.request_id) {
    console.log('request_id not found in joinKeys');
    console.log('Check if field name matches pattern:', event.labels.request_id);
  }
}
```

**Fields automatically detected as join keys:**
- Fields ending with `_id`: `request_id`, `trace_id`, `session_id`, etc.
- Fields containing `correlation`: `correlation_id`, `correlation_token`
- Fields containing `trace`: `trace_id`, `trace_token`
- Pattern matches in message content: `request-id=abc123`

**Solution:** If your correlation field doesn't match these patterns, it will only be available in `labels`, not `joinKeys`. You can still correlate using custom logic:

```javascript
// Manual correlation using labels instead of automatic joinKeys
const correlationQuery = `
  graylog(service:frontend)[5m]
    and on(custom_correlation_field)  
  graylog(service:backend)[5m]
`;

// The adapter will look for custom_correlation_field in labels
```

### Issue: Performance Problems with Large Field Sets

**Problem:** Slow processing when Graylog messages have many fields

**Solution 1:** Use stream filtering to reduce data volume
```javascript
const adapter = new GraylogAdapter({
  url: 'http://graylog.example.com:9000',
  apiToken: 'your-token',
  streamName: 'Application Logs', // Filter to specific stream
});
```

**Solution 2:** Use more specific queries
```javascript
// Instead of broad queries that return many messages:
'graylog(*)[1h]'  // ❌ Returns everything

// Use specific field filters:
'graylog(service:api AND level:error)[5m]'  // ✅ More targeted
```

**Solution 3:** Limit time ranges for correlation queries
```javascript
// Shorter time windows reduce memory usage:
'graylog(service:api)[1m]'   // ✅ Better performance
'graylog(service:api)[1h]'   // ❌ May cause memory issues
```

## Developer Guide

### Understanding Unit vs Integration Tests

The Graylog adapter includes both types of tests to ensure comprehensive coverage:

**Unit Tests** (`src/*.test.ts`):

- Test individual functions and methods in isolation
- Use mocked HTTP responses and dependencies
- Run quickly as part of the standard test suite
- Verify logic, error handling, and edge cases
- Run with: `npm test`

**Integration Tests** (`test/integration/*.test.ts`):

- Test against live Graylog instances
- Verify real API compatibility and data flow
- Require actual Graylog server and configuration
- Test end-to-end functionality and performance
- Run with: `npm run test:integration`

### Customizing Tests for Your Environment

The integration tests are designed to be adaptable to different Graylog setups:

1. **Field Names**: Configure field mappings in your environment variables to match your log format
2. **Query Syntax**: Update test queries to match your actual log data
3. **Expected Results**: Set minimum expected counts to validate tests are finding real data
4. **Stream Configuration**: Test with specific streams or across all streams
5. **Proxy Setup**: Test through corporate proxies or secure networks

## Comprehensive Examples

### Example 1: Multi-Environment Error Tracking (Updated for v0.0.8)

```javascript
const { TimeQLExecutor, isEventResult } = require("@timebridge/core");
const { GraylogAdapter } = require("@timebridge/graylog");

async function trackErrorsAcrossEnvironments() {
  const executor = new TimeQLExecutor();

  // Register all environments with enhanced options
  executor.addAdapter(
    "graylog-prod",
    new GraylogAdapter({
      url: "https://prod.graylog.com",
      apiToken: process.env.PROD_TOKEN,
      streamName: "production",
      maxResults: 5000, // Limit results for better performance
    })
  );

  executor.addAdapter(
    "graylog-staging",
    new GraylogAdapter({
      url: "https://staging.graylog.com",
      apiToken: process.env.STAGING_TOKEN,
      streamName: "staging",
      maxResults: 3000, // Lower limit for staging
    })
  );

  // Find errors unique to production (not in staging)
  const prodOnlyErrors = `
    graylog-prod(level:error)[1h]
      unless on(error_signature)
    graylog-staging(level:error)[1h]
  `;

  const criticalErrors = [];
  
  // Method 1: Use unified API with type discrimination
  for await (const result of executor.execute(prodOnlyErrors)) {
    if (isEventResult(result)) {
      // TypeScript knows result.data is LogEvent
      const event = result.data;
      console.log(`Production-only error: ${event.message}`);

      if (event.labels.severity === "critical") {
        criticalErrors.push(event);
      }
    }
  }

  // Alternative: Use specific method (unless queries can return both events and correlations)
  // for await (const event of executor.executeEvents(prodOnlyErrors)) {
  //   console.log(`Production-only error: ${event.message}`);
  //   if (event.labels.severity === "critical") {
  //     criticalErrors.push(event);
  //   }
  // }

  if (criticalErrors.length > 0) {
    // Send alerts for critical production-only errors
    console.log(
      `ALERT: ${criticalErrors.length} critical errors in production!`
    );
  }
}
```

### Example 2: Request Flow Analysis

```javascript
async function analyzeRequestFlow(requestId) {
  const executor = new TimeQLExecutor();

  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      url: "https://graylog.example.com",
      apiToken: process.env.GRAYLOG_TOKEN,
    })
  );

  // Trace request through all services
  const traceQuery = `
    graylog(service:gateway AND request_id:${requestId})[10m]
      and on(request_id)
    graylog(service:auth AND request_id:${requestId})[10m]  
      and on(request_id)
    graylog(service:api AND request_id:${requestId})[10m]
      and on(request_id)
    graylog(service:database AND request_id:${requestId})[10m]
  `;

  for await (const correlation of executor.execute(traceQuery)) {
    console.log(`Request ${requestId} flow:`);

    // Sort events by timestamp
    const timeline = correlation.events.sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    // Calculate service latencies
    let previousTime = null;
    timeline.forEach((event) => {
      const currentTime = new Date(event.timestamp);
      const latency = previousTime ? currentTime - previousTime : 0;

      console.log(`  ${event.labels.service}: ${event.message}`);
      if (latency > 0) {
        console.log(`    └─ Latency: ${latency}ms`);
      }

      previousTime = currentTime;
    });

    // Total request duration
    const totalDuration =
      new Date(correlation.timeWindow.end) -
      new Date(correlation.timeWindow.start);
    console.log(`Total duration: ${totalDuration}ms`);
  }
}
```

### Example 3: Performance Monitoring (Updated for v0.0.8)

```javascript
const { isCorrelationResult } = require("@timebridge/core");

async function monitorPerformance() {
  const executor = new TimeQLExecutor();

  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      url: "https://graylog.example.com",
      apiToken: process.env.GRAYLOG_TOKEN,
      apiVersion: "v6",
      maxResults: 8000, // Increased limit for performance analysis
    })
  );

  // Find slow database queries that caused API timeouts
  const performanceQuery = `
    graylog(service:database AND query_time:>1000)[5m]
      and on(request_id)
    graylog(service:api AND message:"timeout")[5m]
  `;

  const slowQueries = new Map();

  // Method 1: Use type guard for type safety
  for await (const result of executor.execute(performanceQuery)) {
    if (isCorrelationResult(result)) {
      // TypeScript knows result.data is CorrelatedEvent
      const correlation = result.data;
      const dbEvents = correlation.events.filter(
        (e) => e.labels.service === "database"
      );
      const apiEvents = correlation.events.filter(
        (e) => e.labels.service === "api"
      );

      dbEvents.forEach((dbEvent) => {
        const query = dbEvent.labels.query || "unknown";
        const time = parseInt(dbEvent.labels.query_time) || 0;

        if (!slowQueries.has(query)) {
          slowQueries.set(query, {
            count: 0,
            totalTime: 0,
            timeouts: 0,
          });
        }

        const stats = slowQueries.get(query);
        stats.count++;
        stats.totalTime += time;
        if (apiEvents.length > 0) stats.timeouts++;
      });
    }
  }

  // Alternative: Use specific correlation method
  // for await (const correlation of executor.executeCorrelation(performanceQuery)) {
  //   // Direct access to CorrelatedEvent
  //   const dbEvents = correlation.events.filter((e) => e.labels.service === "database");
  //   const apiEvents = correlation.events.filter((e) => e.labels.service === "api");
  //   // ... process events
  // }

  // Report slow query statistics
  console.log("Slow Query Analysis:");
  for (const [query, stats] of slowQueries) {
    const avgTime = stats.totalTime / stats.count;
    const timeoutRate = (stats.timeouts / stats.count) * 100;

    console.log(`  Query: ${query}`);
    console.log(`    Occurrences: ${stats.count}`);
    console.log(`    Avg Time: ${avgTime}ms`);
    console.log(`    Timeout Rate: ${timeoutRate.toFixed(1)}%`);
  }
}
```

### Example 4: Security Event Correlation

```javascript
async function correlateSecurityEvents() {
  const executor = new TimeQLExecutor();

  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      url: "https://graylog.example.com",
      apiToken: process.env.GRAYLOG_TOKEN,
      streamName: "Security Events",
    })
  );

  // Correlate failed login attempts with successful logins
  const suspiciousActivity = `
    graylog(event_type:login_failed)[1h]
      and on(user_id) within(5m)
    graylog(event_type:login_success)[1h]
  `;

  for await (const correlation of executor.execute(suspiciousActivity)) {
    const failedAttempts = correlation.events.filter(
      (e) => e.labels.event_type === "login_failed"
    );
    const successfulLogin = correlation.events.find(
      (e) => e.labels.event_type === "login_success"
    );

    if (failedAttempts.length >= 3 && successfulLogin) {
      console.log(`⚠️ Suspicious activity for user: ${correlation.joinValue}`);
      console.log(`  Failed attempts: ${failedAttempts.length}`);
      console.log(`  Successful login at: ${successfulLogin.timestamp}`);

      // Check if login was from different IP
      const failedIPs = new Set(failedAttempts.map((e) => e.labels.client_ip));
      const successIP = successfulLogin.labels.client_ip;

      if (!failedIPs.has(successIP)) {
        console.log(`  🔴 ALERT: Login from new IP: ${successIP}`);
      }
    }
  }
}
```

### Example 5: Stream Processing with Filters (Updated for v0.0.8)

```javascript
const { isEventResult } = require("@timebridge/core");

async function processStreamedLogs() {
  const executor = new TimeQLExecutor();

  // Configure adapter with enhanced options
  executor.addAdapter(
    "graylog",
    new GraylogAdapter({
      url: "https://graylog.example.com",
      apiToken: process.env.GRAYLOG_TOKEN,
      streamName: "Application Logs", // v0.0.7+ feature
      maxResults: 1000, // Limit for real-time processing
      pollInterval: 1000, // Poll every second (only used with continuous: true)
    })
  );

  // Process logs as they arrive - NOTE: Use continuous: true for real-time monitoring
  const realtimeQuery = "graylog(level:error OR level:critical)[1m]";

  console.log("Monitoring for errors (press Ctrl+C to stop)...");

  const errorCounts = new Map();
  let totalErrors = 0;

  // IMPORTANT: Use continuous: true for real-time monitoring
  for await (const result of executor.execute(realtimeQuery, { continuous: true })) {
    if (isEventResult(result)) {
      // TypeScript knows result.data is LogEvent
      const event = result.data;
      totalErrors++;

      // Track errors by service using extracted labels
      const service = event.labels.service || "unknown";
      errorCounts.set(service, (errorCounts.get(service) || 0) + 1);

      // Display error with extracted field information
      console.log(
        `[${new Date(
          event.timestamp
        ).toLocaleTimeString()}] ${event.labels.level?.toUpperCase()}: ${
          event.message
        }`
      );
      
      // Show extracted fields for context
      const contextFields = ['user_id', 'request_id', 'client_ip', 'response_time'];
      const context = {};
      contextFields.forEach(field => {
        if (event.labels[field]) {
          context[field] = event.labels[field];
        }
      });
      if (Object.keys(context).length > 0) {
        console.log(`  Context: ${JSON.stringify(context)}`);
      }

      // Show running statistics every 10 errors
      if (totalErrors % 10 === 0) {
        console.log("\n📊 Error Statistics:");
        for (const [svc, count] of errorCounts) {
          console.log(`  ${svc}: ${count} errors`);
        }
        console.log("");
      }

      // Take action on critical errors with correlation capability
      if (event.labels.level === "critical") {
        console.log("🚨 CRITICAL ERROR DETECTED - Triggering alert!");
        console.log(`  Available correlation keys: ${Object.keys(event.joinKeys || {}).join(', ')}`);
        // Send notification, page on-call, etc.
      }
    }
  }

  // Alternative: Use executeEvents for direct access when you know it's events
  // for await (const event of executor.executeEvents(realtimeQuery, { continuous: true })) {
  //   // Direct access to LogEvent objects
  //   console.log(`Error: ${event.message}`);
  // }
}
```

### Example 6: Field Extraction Demonstration

```javascript
async function demonstrateFieldExtraction() {
  const executor = new TimeQLExecutor();
  
  executor.addAdapter('graylog', new GraylogAdapter({
    url: 'https://graylog.example.com',
    apiToken: process.env.GRAYLOG_TOKEN,
  }));

  console.log('🔍 Demonstrating automatic field extraction...');
  
  // Query that returns various log types
  const demoQuery = 'graylog(*)[5m]';
  let processedEvents = 0;
  
  for await (const event of executor.execute(demoQuery)) {
    console.log(`\n--- Event ${++processedEvents} ---`);
    console.log('Message:', event.message);
    console.log('Stream:', event.stream);
    
    // Show all extracted labels (custom fields from Graylog)
    if (Object.keys(event.labels).length > 0) {
      console.log('📋 Extracted Labels:');
      Object.entries(event.labels).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
    } else {
      console.log('📋 No custom fields extracted');
    }
    
    // Show correlation-ready join keys
    if (Object.keys(event.joinKeys).length > 0) {
      console.log('🔗 Auto-detected Join Keys:');
      Object.entries(event.joinKeys).forEach(([key, value]) => {
        console.log(`  ${key}: ${value} ✅ Can correlate on this field`);
      });
    } else {
      console.log('🔗 No correlation keys detected');
    }
    
    // Analyze field types that were processed
    const fieldTypes = {};
    Object.entries(event.labels).forEach(([key, value]) => {
      // Try to determine original type before string conversion
      if (value === 'true' || value === 'false') {
        fieldTypes[key] = 'boolean -> string';
      } else if (!isNaN(Number(value)) && value !== '') {
        fieldTypes[key] = 'number -> string';  
      } else {
        fieldTypes[key] = 'string';
      }
    });
    
    if (Object.keys(fieldTypes).length > 0) {
      console.log('📊 Field Type Processing:');
      Object.entries(fieldTypes).forEach(([key, type]) => {
        console.log(`  ${key}: ${type}`);
      });
    }
    
    // Stop after analyzing a few events
    if (processedEvents >= 5) break;
  }
  
  console.log('\n✅ Field extraction analysis complete!');
  console.log('All custom Graylog fields are automatically available as labels for correlation.');
}
```

### Example 7: Cross-Instance Correlation with Extracted Fields

```javascript
async function correlateAcrossGraylogInstances() {
  const executor = new TimeQLExecutor();
  
  // Register multiple Graylog instances (e.g., different data centers)
  executor.addAdapter('graylog-east', new GraylogAdapter({
    url: 'https://east.graylog.example.com',
    apiToken: process.env.EAST_GRAYLOG_TOKEN,
    streamName: 'Production Logs'
  }));
  
  executor.addAdapter('graylog-west', new GraylogAdapter({
    url: 'https://west.graylog.example.com', 
    apiToken: process.env.WEST_GRAYLOG_TOKEN,
    streamName: 'Production Logs'
  }));

  console.log('🌐 Correlating events across geographic Graylog instances...');
  
  // Find user actions that span multiple data centers
  const geoCorrelationQuery = `
    graylog-east(action:login AND user_id:*)[30m]
      and on(user_id) within(5m)
    graylog-west(action:api_call)[30m]
  `;

  for await (const correlation of executor.execute(geoCorrelationQuery)) {
    const userId = correlation.joinValue;
    console.log(`\n👤 Cross-region activity for user: ${userId}`);
    
    // Group events by region
    const eastEvents = correlation.events.filter(e => e.source.includes('east'));
    const westEvents = correlation.events.filter(e => e.source.includes('west'));
    
    console.log(`  East Coast: ${eastEvents.length} events`);
    eastEvents.forEach(event => {
      console.log(`    [${event.timestamp}] ${event.message}`);
      console.log(`    Location: ${event.labels.datacenter || 'unknown'}`);
      console.log(`    Session: ${event.labels.session_id || 'none'}`);
    });
    
    console.log(`  West Coast: ${westEvents.length} events`);
    westEvents.forEach(event => {
      console.log(`    [${event.timestamp}] ${event.message}`);
      console.log(`    Location: ${event.labels.datacenter || 'unknown'}`);
      console.log(`    API: ${event.labels.api_endpoint || 'unknown'}`);
    });
    
    // Calculate time difference for geographic analysis
    if (eastEvents.length > 0 && westEvents.length > 0) {
      const eastTime = new Date(eastEvents[0].timestamp);
      const westTime = new Date(westEvents[0].timestamp); 
      const timeDiff = Math.abs(westTime.getTime() - eastTime.getTime());
      console.log(`    Time between regions: ${timeDiff}ms`);
      
      // Flag suspicious rapid geographic transitions
      if (timeDiff < 60000) { // Less than 1 minute
        console.log('    🚨 ALERT: Suspiciously fast geographic transition!');
      }
    }
  }
}
```

### Contributing Integration Tests

When adding new integration test scenarios:

1. **Add Environment Variables**: Define new test parameters in `.env.example`
2. **Update Configuration**: Add new options to `graylog.config.js`
3. **Create Test Cases**: Add new test methods following existing patterns
4. **Document Usage**: Update this README with configuration details
5. **Consider Edge Cases**: Test error conditions, timeouts, and edge cases

### CI/CD Integration

The integration tests are designed for CI/CD environments:

```yaml
# Example GitHub Actions step
- name: Run Graylog Integration Tests
  run: npm run test:integration
  env:
    GRAYLOG_URL: ${{ secrets.GRAYLOG_URL }}
    GRAYLOG_API_TOKEN: ${{ secrets.GRAYLOG_API_TOKEN }}
    GRAYLOG_STREAM_NAME: "CI Test Stream"
```

Tests automatically skip if `GRAYLOG_URL` is not configured, making them safe for environments without Graylog access.

### Performance Considerations

The integration tests include performance monitoring:

- **Duration Tracking**: Measures query execution time
- **Memory Usage**: Monitors event processing efficiency
- **Result Limits**: Prevents runaway queries with configurable limits
- **Timeout Handling**: Prevents tests from hanging on slow networks

For optimal performance:

- Use specific queries rather than wildcards
- Configure appropriate time ranges for your data volume
- Set realistic event limits based on your log volume
- Consider SOCKS proxy latency in timeout settings
