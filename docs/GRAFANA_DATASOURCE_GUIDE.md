# Grafana Data Source Integration Guide

## Overview

TimeCore adapters (Prometheus, Loki, InfluxDB) now support transparent integration with Grafana data sources. This allows you to query these systems through Grafana's data source API instead of directly connecting to them. The integration is completely transparent - you use the same query syntax and all existing features continue to work.

## Key Features

- **Automatic Detection**: Adapters automatically detect whether they're connecting to Grafana or directly to the data source
- **Name-Based Resolution**: Use human-readable data source names instead of IDs or UIDs
- **Native Query Syntax**: Continue using PromQL, LogQL, and InfluxQL as before
- **Full Feature Support**: Streaming, proxies, parsers, and all existing functionality remains available
- **Multiple Authentication Methods**: Support for service tokens, API keys, and basic authentication

## Quick Start

### Direct Connection (Traditional)

```javascript
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

const adapter = new PrometheusAdapter({
  url: 'http://prometheus:9090',
  authToken: 'prometheus-token'
});

// Query directly
for await (const event of adapter.query('rate(http_requests_total[5m])')) {
  console.log(event);
}
```

### Through Grafana (New - Transparent)

```javascript
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

// Just point to Grafana instead - everything else works the same!
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'grafana-service-token',
  datasourceName: 'Prometheus Production' // Optional - uses default if not specified
});

// Same query syntax works transparently
for await (const event of adapter.query('rate(http_requests_total[5m])')) {
  console.log(event);
}
```

## Authentication

### Service Account Token (Recommended)

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'glsa_xxxxxxxxxxxxxxxxxxxx' // Grafana service account token
});
```

### Bearer Token

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'Bearer eyJrIjoiT0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk'
});
```

### Basic Authentication

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  basicAuth: {
    username: 'admin',
    password: 'admin'
  }
});
```

### API Key

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'eyJrIjoiT0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk'
});
```

## Data Source Selection

### Automatic Selection

If you don't specify a data source name, the adapter will:
1. Use the default data source of the matching type
2. If no default exists, use the first available data source of the matching type

```javascript
// Uses default Prometheus data source
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token'
});
```

### Explicit Selection

Specify the exact data source to use:

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  datasourceName: 'Prometheus Production'
});
```

### Name Resolution

The adapter handles fuzzy matching for data source names:
- Case-insensitive matching
- Exact match preferred over partial match
- Throws clear error if ambiguous or not found

```javascript
// All of these will match "Prometheus Production"
datasourceName: 'Prometheus Production'
datasourceName: 'prometheus production'
datasourceName: 'PROMETHEUS PRODUCTION'
```

## Adapter-Specific Examples

### Prometheus

```javascript
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'grafana-token',
  datasourceName: 'Prometheus Metrics'
});

// PromQL queries work unchanged
const stream = adapter.query('sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)');

for await (const event of stream) {
  console.log(`Pod: ${event.labels.pod}, CPU: ${event.labels.__value__}`);
}

// Instant queries
const instant = await adapter.instantQuery('up');
for await (const event of instant) {
  console.log(`Instance: ${event.labels.instance}, Status: ${event.labels.__value__}`);
}
```

### Loki

```javascript
const { LokiAdapter } = require('@timebridge/adapter-loki');

const adapter = new LokiAdapter({
  url: 'https://grafana.example.com',
  authToken: 'grafana-token',
  datasourceName: 'Loki Logs'
});

// LogQL queries work unchanged
const stream = adapter.query('{service="nginx"} |= "error" | json');

for await (const event of stream) {
  console.log(`[${event.timestamp}] ${event.message}`);
}

// Metric queries
const metrics = adapter.query('rate({service="api"}[5m])');
for await (const metric of metrics) {
  console.log(`Rate: ${metric.labels.__value__}`);
}
```

### InfluxDB

```javascript
const { InfluxDBAdapter } = require('@timebridge/adapter-influxdb');

const adapter = new InfluxDBAdapter({
  url: 'https://grafana.example.com',
  authToken: 'grafana-token',
  datasourceName: 'InfluxDB Metrics'
});

// InfluxQL queries work unchanged
const stream = adapter.query('SELECT mean("value") FROM "cpu" WHERE time > now() - 1h GROUP BY time(1m)');

for await (const event of stream) {
  console.log(`Time: ${event.timestamp}, Mean: ${event.fields.mean}`);
}

// Flux queries (InfluxDB 2.x)
const fluxStream = adapter.query(`
  from(bucket: "metrics")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "cpu")
`);
```

## Proxy Support

SOCKS proxy configuration works with Grafana connections:

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  proxy: {
    host: 'socks5://proxy.example.com',
    port: 1080,
    auth: {
      username: 'proxy-user',
      password: 'proxy-pass'
    }
  }
});
```

## Advanced Configuration

### Grafana-Specific Options

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  datasourceName: 'Prometheus Production',
  grafanaOptions: {
    // Force refresh data source cache
    refreshDataSources: true,
    
    // Data source cache TTL (milliseconds)
    datasourceCacheTTL: 3600000, // 1 hour
    
    // Request retry configuration
    maxRetries: 5,
    
    // Request timeout (milliseconds)
    timeout: 30000,
    
    // Custom headers for Grafana requests
    headers: {
      'X-Custom-Header': 'value'
    }
  }
});
```

### Parser Integration

All parsers work transparently with Grafana data sources:

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token'
});

// Validate query syntax before execution
const parseResult = adapter.parseQuery('rate(http_requests_total[5m])');
if (parseResult.isValid) {
  const stream = adapter.query(parseResult.query);
  // Process results...
}
```

## Migration Guide

### From Direct Connection to Grafana

Migrating existing code to use Grafana is simple - just change the URL and authentication:

#### Before (Direct Connection)
```javascript
const adapter = new PrometheusAdapter({
  url: 'http://prometheus:9090',
  authToken: 'prometheus-token',
  proxy: { /* proxy config */ }
});

const stream = adapter.query('up{job="api"}');
```

#### After (Through Grafana)
```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'grafana-service-token',
  datasourceName: 'Prometheus Production', // Optional
  proxy: { /* same proxy config still works */ }
});

const stream = adapter.query('up{job="api"}'); // Same query!
```

### Compatibility Notes

- **No Breaking Changes**: All existing code continues to work unchanged
- **Feature Parity**: All features available with direct connections work through Grafana
- **Performance**: Minimal overhead added by Grafana layer (typically <10ms per query)
- **Caching**: Data source information is cached to reduce API calls

## Troubleshooting

### Common Issues

#### Data Source Not Found

```javascript
// Error: Data source 'MyPrometheus' not found
```

**Solution**: Check the exact name in Grafana UI, or list available data sources:

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token'
});

// This will log available data sources during initialization
adapter.on('debug', (msg) => console.log(msg));
```

#### Authentication Failed

```javascript
// Error: Grafana authentication failed: 401 Unauthorized
```

**Solution**: Verify your token/credentials and ensure they have appropriate permissions:
- Service accounts need `datasources:query` permission
- API keys need Viewer role or higher
- Basic auth users need appropriate organization access

#### Wrong Data Source Type

```javascript
// Error: No prometheus data sources found in Grafana
```

**Solution**: Ensure Grafana has a configured Prometheus data source. The adapter filters by type automatically.

### Debug Mode

Enable debug logging to see Grafana API interactions:

```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  debug: true // Enable debug logging
});

adapter.on('debug', (message) => {
  console.log(`[DEBUG] ${message}`);
});
```

### Testing Grafana Detection

You can verify if a URL points to Grafana:

```javascript
const { isGrafanaUrl } = require('@timebridge/core');

const isGrafana = await isGrafanaUrl('https://grafana.example.com');
console.log(`Is Grafana: ${isGrafana}`);
```

## API Reference

### Configuration Options

| Option | Type | Description | Required |
|--------|------|-------------|----------|
| `url` | string | Grafana URL or direct data source URL | Yes |
| `authToken` | string | Authentication token (Bearer, API key, or service account) | No* |
| `basicAuth` | object | Basic authentication credentials | No* |
| `datasourceName` | string | Name of the Grafana data source to use | No |
| `proxy` | object | SOCKS proxy configuration | No |
| `grafanaOptions` | object | Grafana-specific options | No |
| `debug` | boolean | Enable debug logging | No |

*At least one authentication method is required for Grafana

### Methods

All adapter methods work identically whether connected directly or through Grafana:

```javascript
// Create a query stream
adapter.query(query: string, options?: QueryOptions): AsyncIterable<LogEvent>

// Execute instant query (Prometheus only)
adapter.instantQuery(query: string, time?: Date): AsyncIterable<LogEvent>

// Parse and validate query
adapter.parseQuery(query: string): ParseResult

// Get metadata (Prometheus only)
adapter.getMetadata(metric?: string): Promise<MetadataResponse>

// Get label names (Prometheus/Loki)
adapter.getLabelNames(): Promise<string[]>

// Get label values (Prometheus/Loki)
adapter.getLabelValues(label: string): Promise<string[]>
```

## Performance Considerations

### Caching

The Grafana integration includes intelligent caching:
- Data source list cached for 1 hour by default
- Grafana detection cached for session lifetime
- Query results are not cached (real-time data)

### Connection Pooling

When using Grafana at scale, consider:
- Grafana's own connection limits to backend data sources
- Rate limiting on Grafana API endpoints
- Network latency between your application and Grafana

### Best Practices

1. **Reuse Adapter Instances**: Create one adapter instance per data source and reuse it
2. **Specify Data Source Names**: Avoid discovery overhead by explicitly naming data sources
3. **Use Appropriate Time Ranges**: Limit query scope to reduce data transfer
4. **Enable Compression**: Use gzip compression for large result sets

## Examples Repository

Full working examples are available in the examples package:

```bash
# Clone the repository
git clone https://github.com/your-org/timebridge.git
cd timebridge/packages/examples

# Install dependencies
npm install

# Run Grafana integration example
node grafana-integration.js
```

## Support Matrix

| Grafana Version | Support Status | Notes |
|-----------------|----------------|--------|
| 10.x | ✅ Full Support | Recommended |
| 9.x | ✅ Full Support | Tested |
| 8.x | ⚠️ Partial Support | Some features may not work |
| 7.x | ❌ Not Supported | API incompatible |

| Data Source Type | Direct | Via Grafana |
|------------------|--------|-------------|
| Prometheus | ✅ | ✅ |
| Loki | ✅ | ✅ |
| InfluxDB 1.x | ✅ | ✅ |
| InfluxDB 2.x | ✅ | ✅ |

## Security Considerations

### Token Storage

- Never hardcode tokens in source code
- Use environment variables or secure configuration management
- Rotate tokens regularly

### Network Security

- Always use HTTPS when connecting to Grafana
- Configure proxy settings for isolated networks
- Implement proper error handling to avoid token leakage

### Permissions

Minimum Grafana permissions required:
- `datasources:query` - Query data sources
- `datasources:read` - List data sources (for discovery)

## Getting Help

- **Documentation**: See adapter-specific READMEs for detailed query syntax
- **Issues**: Report bugs at https://github.com/your-org/timebridge/issues
- **Examples**: Check the examples package for working code samples
- **API Specs**: Grafana API documentation at https://grafana.com/docs/grafana/latest/developers/http_api/

## Changelog

### Version 2.0.0
- Added transparent Grafana data source support
- Automatic Grafana detection
- Name-based data source resolution
- Full backward compatibility maintained

### Version 1.x
- Direct connection support only
- Parser integration
- Streaming support