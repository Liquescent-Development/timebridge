# Log Correlator

A TypeScript npm package that enables real-time correlation of log streams from multiple sources (Loki, Graylog) with a PromQL-inspired query language.

## Features

- **Real-time Stream Processing**: Handle live log streams from multiple sources simultaneously
- **PromQL-style Query Language**: Familiar syntax for join operations and filtering
- **Multiple Data Sources**: Built-in adapters for Loki and Graylog (supports v2.x-6.x+)
- **SOCKS Proxy Support**: Connect through SOCKS4/SOCKS5 proxies for secure network environments
- **JavaScript-First API**: Easy consumption from vanilla JavaScript/Node.js
- **Memory Efficient**: Bounded buffers with configurable time windows
- **Electron Compatible**: Designed for integration with Electron applications

## Installation

> ⚠️ **Pre-release Software**: This is version 0.0.7 - API may change significantly before 1.0.0

```bash
npm install @liquescent/log-correlator-core@^0.0.7
npm install @liquescent/log-correlator-loki@^0.0.7     # Optional: Loki adapter
npm install @liquescent/log-correlator-graylog@^0.0.7  # Optional: Graylog adapter
```

## Quick Start

### Basic Example with Loki

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const { LokiAdapter } = require("@liquescent/log-correlator-loki");

const engine = new CorrelationEngine({
  timeWindow: 30000, // 30 second window
  maxEvents: 10000, // Memory limit
});

// Add data source adapter
engine.addAdapter(
  "loki",
  new LokiAdapter({
    url: "http://localhost:3100",
  }),
);

// Execute correlation query
const query = `
  loki({service="frontend"})[5m] 
    and on(request_id) 
    loki({service="backend"})[5m]
`;

// Stream results
for await (const correlation of engine.correlate(query)) {
  console.log("Correlated events:", correlation);
}
```

### Graylog 6.x Example

For Graylog 6.x deployments, use the Views API which supports advanced features and returns CSV data:

```javascript
const { CorrelationEngine } = require("@liquescent/log-correlator-core");
const { GraylogAdapter } = require("@liquescent/log-correlator-graylog");

const engine = new CorrelationEngine({
  timeWindow: 30000,
  maxEvents: 10000,
});

// Configure for Graylog 6.x with Views API
engine.addAdapter(
  "graylog",
  new GraylogAdapter({
    url: "http://graylog.example.com:9000",
    apiToken: "your-api-token",
    apiVersion: "v6", // Required for Graylog 6.x (uses CSV responses)
    pollInterval: 2000,
  }),
);

// Correlate logs from different services
const query = `
  graylog(service:frontend)[5m]
    and on(request_id)
    graylog(service:backend)[5m]
`;

for await (const correlation of engine.correlate(query)) {
  console.log("Correlated events:", correlation);
}
```

## Query Language

The package supports a PromQL-inspired syntax for correlating log streams:

### Basic Join Operations

#### Inner Join (AND)

Finds events that exist in both streams:

```promql
loki({service="frontend"})[5m]
  and on(request_id)
  loki({service="backend"})[5m]
```

#### Left Join (OR)

Includes all events from the left stream, with matching events from the right:

```promql
graylog(service:payment)[10m]
  or on(transaction_id)
  graylog(service:notification)[10m]
```

#### Anti-Join (UNLESS)

Events from the left stream that have no match in the right:

```promql
loki({service="api"})[5m]
  unless on(request_id)
  loki({service="database"})[5m]
```

### Graylog-Specific Examples

#### Basic Graylog Query

```promql
graylog(application:webserver AND level:ERROR)[5m]
```

#### Graylog with Stream Name (v0.0.7+)

```javascript
// Configure adapter with stream name
const adapter = new GraylogAdapter({
  url: "http://graylog:9000",
  apiToken: "token",
  streamName: "Production Logs", // New in v0.0.7
});

// Query will automatically filter to this stream
const query = "graylog(service:api)[5m]";
```

#### Complex Graylog Correlation

```promql
# Correlate errors with their originating requests
graylog(level:ERROR AND service:backend)[30m]
  and on(correlation_id)
  graylog(service:frontend AND path:"/api/*")[30m]
```

#### Multi-Service Trace Correlation

```promql
# Three-way correlation across microservices
graylog(service:api-gateway)[10m]
  and on(trace_id)
  graylog(service:auth-service)[10m]
  and on(trace_id)
  graylog(service:user-service)[10m]
```

### Cross-Source Correlation

#### Loki and Graylog Together

```promql
# Correlate Kubernetes logs (Loki) with application logs (Graylog)
loki({namespace="production", pod=~"api-.*"})[5m]
  and on(request_id)
  graylog(application:api AND environment:production)[5m]
```

#### With Custom Field Mapping

```promql
# Map different field names between sources
loki({job="nginx"})[5m]
  and on(req_id=request_id)
  graylog(service:backend)[5m]
```

### Advanced Features

#### Temporal Join with Time Window

Events must occur within a specific time window:

```promql
loki({service="frontend"})[5m]
  and on(session_id) within(30s)
  loki({service="backend"})[5m]
```

#### Group Modifiers

Control how multiple matches are handled:

```promql
# Many-to-one correlation
graylog(service:loadbalancer)[5m]
  and on(backend_id) group_left()
  graylog(service:backend)[5m]
```

#### Ignoring Specific Labels

```promql
loki({service="api"})[5m]
  and ignoring(timestamp, hostname)
  loki({service="database"})[5m]
```

## SOCKS Proxy Configuration

All adapters support connecting through SOCKS4/SOCKS5 proxies, useful for secure or restricted network environments:

```javascript
const { LokiAdapter } = require("@liquescent/log-correlator-loki");

const adapter = new LokiAdapter({
  url: "http://loki.internal:3100",
  proxy: {
    host: "127.0.0.1",
    port: 1080,
    type: 5, // SOCKS5 (default) or 4 for SOCKS4
    username: "proxyuser", // Optional authentication
    password: "proxypass",
  },
});
```

This works identically for Graylog and PromQL adapters:

```javascript
const { GraylogAdapter } = require("@liquescent/log-correlator-graylog");

const graylogAdapter = new GraylogAdapter({
  url: "http://graylog.internal:9000",
  apiToken: "your-token",
  proxy: {
    host: "proxy.company.com",
    port: 8080,
    type: 5,
  },
});
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm run test

# Type checking
npm run typecheck

# Linting
npm run lint
```

### Integration Testing

The adapters include comprehensive integration tests that validate functionality against live instances:

```bash
# Run integration tests for all adapters
npm run test:integration

# Run integration tests for specific adapter
cd packages/adapters/graylog && npm run test:integration
cd packages/adapters/loki && npm run test:integration
```

**Graylog Integration Tests** verify:

- Connection and authentication (basic auth and API tokens)
- Query execution across legacy (2.x-5.x) and v6+ APIs
- Field extraction and correlation ID detection
- Time range filtering and stream filtering
- Error handling and performance testing
- SOCKS proxy connectivity

**Setup**: Copy `.env.example` to `.env` and configure your instance details. Tests automatically skip if no connection is configured.

See individual adapter READMEs for detailed integration test configuration.

## Documentation

See the [docs](./docs) directory for detailed documentation.

## License

AGPLv3
