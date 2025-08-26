# Graylog Adapter for Log Correlator

This adapter enables the Log Correlator to connect to and consume logs from Graylog instances.

## Installation

```bash
npm install @liquescent/log-correlator-graylog
```

## Supported Graylog Versions

The adapter supports multiple Graylog versions through configurable API endpoints:

- **Graylog 2.x - 5.x**: Uses the Universal Search API (`/api/search/universal/relative`)
- **Graylog 6.x+**: Uses the Views Search API (`/api/views/search/messages`)

## Configuration

```javascript
const { GraylogAdapter } = require("@liquescent/log-correlator-graylog");

// For Graylog 2.x - 5.x (default)
const legacyAdapter = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  username: "admin",
  password: "password",
  apiVersion: "legacy", // Optional, this is the default
  pollInterval: 2000, // Poll every 2 seconds
  timeout: 15000, // 15 second timeout
});

// For Graylog 6.x+ with stream filtering by name
const v6Adapter = new GraylogAdapter({
  url: "http://graylog.example.com:9000",
  apiToken: "your-api-token", // API token recommended for v6
  apiVersion: "v6", // Required for Graylog 6.x
  pollInterval: 2000,
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

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const { GraylogAdapter } = require("@liquescent/log-correlator-graylog");

const engine = new CorrelationEngine();

// Add Graylog adapter
engine.addAdapter(
  "graylog",
  new GraylogAdapter({
    url: "http://graylog.example.com:9000",
    apiToken: "your-token",
    apiVersion: "v6", // Use v6 API for Graylog 6.x+ (returns CSV)
    streamId: "optional-stream-id", // Filter by specific stream if needed
  }),
);

// Simple query
const simpleQuery = "graylog(service:api AND level:error)[5m]";

for await (const event of engine.correlate(simpleQuery)) {
  console.log("Log event:", event);
}

// Correlation query - correlate logs by trace ID
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

- **Polling-based streaming**: Continuously polls for new log messages
- **Automatic retry**: Handles transient failures with exponential backoff
- **Join key extraction**: Automatically extracts correlation IDs from log messages
- **Stream filtering**: Filter logs by stream name or ID
- **Time window support**: Configure time ranges for log queries
- **Stream name resolution**: Automatically converts stream names to IDs
- **Correlation support**: Works seamlessly with the CorrelationEngine for complex correlation queries

## Correlation Query Support

The Graylog adapter fully supports correlation queries when used with the CorrelationEngine. This enables powerful log correlation scenarios:

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

1. **Query Parsing**: The CorrelationEngine parses the correlation query syntax
2. **Adapter Calls**: Each `graylog()` segment calls the adapter's `createStream()` method
3. **Join Key Extraction**: The adapter automatically extracts correlation IDs (request_id, trace_id, etc.) as `joinKeys`
4. **Correlation**: The engine correlates events based on matching join keys
5. **Result Stream**: Correlated events are returned as an async iterable

### Join Key Detection

The adapter automatically detects and extracts common correlation IDs from log messages:

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
| `pollInterval` | number           | 2000     | Polling interval in milliseconds           |
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
