# Migration Guide: Direct to Grafana Data Sources

## Overview

This guide helps you migrate from direct data source connections to Grafana-mediated connections. The migration is designed to be seamless with minimal code changes.

## Why Use Grafana Data Sources?

### Benefits
- **Centralized Configuration**: Manage all data source connections in one place
- **Security**: No need to expose data source credentials to client applications
- **Access Control**: Leverage Grafana's RBAC for data access
- **Monitoring**: Built-in metrics and logging for all queries
- **Caching**: Grafana's query caching reduces backend load

### Trade-offs
- **Additional Hop**: Adds ~10-50ms latency per query
- **Grafana Dependency**: Requires Grafana to be available
- **API Limits**: Subject to Grafana API rate limits

## Migration Strategies

### Strategy 1: Drop-in Replacement (Recommended)

Simply change the URL and authentication - everything else stays the same.

#### Before
```javascript
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

const adapter = new PrometheusAdapter({
  url: 'http://prometheus.internal:9090',
  authToken: 'prometheus-secret-token'
});
```

#### After
```javascript
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

const adapter = new PrometheusAdapter({
  url: 'https://grafana.company.com',
  authToken: 'glsa_xxxxxxxxxxxx', // Grafana service account token
  datasourceName: 'Prometheus Production' // Optional
});
```

### Strategy 2: Environment-Based Configuration

Use environment variables to switch between direct and Grafana connections:

```javascript
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

const adapter = new PrometheusAdapter({
  url: process.env.PROMETHEUS_URL || 'https://grafana.company.com',
  authToken: process.env.PROMETHEUS_TOKEN,
  datasourceName: process.env.PROMETHEUS_DATASOURCE_NAME,
  // Falls back to direct connection if datasourceName is not provided
});
```

### Strategy 3: Dynamic Detection

Let the adapter automatically detect and adapt:

```javascript
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

async function createAdapter(config) {
  const adapter = new PrometheusAdapter(config);
  
  // The adapter automatically detects if it's connecting to Grafana
  // No code changes needed!
  return adapter;
}

// Works with both direct and Grafana URLs
const adapter = await createAdapter({
  url: process.env.METRICS_URL,
  authToken: process.env.METRICS_TOKEN
});
```

## Authentication Migration

### From Direct Authentication to Grafana

#### Prometheus Direct → Grafana Service Account
```javascript
// Before: Prometheus Bearer token
const adapter = new PrometheusAdapter({
  url: 'http://prometheus:9090',
  authToken: 'Bearer prometheus-token'
});

// After: Grafana service account
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'glsa_xxxxxxxxxxxx'
});
```

#### Loki Direct → Grafana API Key
```javascript
// Before: Loki basic auth
const adapter = new LokiAdapter({
  url: 'http://loki:3100',
  basicAuth: {
    username: 'loki',
    password: 'loki-password'
  }
});

// After: Grafana API key
const adapter = new LokiAdapter({
  url: 'https://grafana.example.com',
  authToken: 'eyJrIjoiT0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk'
});
```

#### InfluxDB Direct → Grafana Basic Auth
```javascript
// Before: InfluxDB token
const adapter = new InfluxDBAdapter({
  url: 'http://influxdb:8086',
  authToken: 'influxdb-token',
  org: 'my-org',
  bucket: 'my-bucket'
});

// After: Grafana basic auth
const adapter = new InfluxDBAdapter({
  url: 'https://grafana.example.com',
  basicAuth: {
    username: 'viewer',
    password: 'viewer-password'
  },
  datasourceName: 'InfluxDB Production'
  // org and bucket are configured in Grafana data source
});
```

## Creating Grafana Service Accounts

### Step 1: Create Service Account

```bash
# Using Grafana CLI
grafana-cli admin create-service-account "timebridge-app" --role Viewer

# Using Grafana API
curl -X POST https://grafana.example.com/api/serviceaccounts \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "timebridge-app", "role": "Viewer"}'
```

### Step 2: Create Service Account Token

```bash
# Using Grafana CLI
grafana-cli admin create-service-account-token "timebridge-app" --name "prod-token"

# Using Grafana API
curl -X POST https://grafana.example.com/api/serviceaccounts/1/tokens \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "prod-token"}'
```

### Step 3: Set Permissions

Ensure the service account has the necessary permissions:
- `datasources:query` - Required for querying
- `datasources:read` - Required for data source discovery

## Feature Compatibility

### Fully Compatible Features

✅ **Query Language**: All queries work unchanged
```javascript
// These work identically with direct or Grafana connections:
adapter.query('rate(http_requests_total[5m])');
adapter.query('{service="nginx"} |= "error"');
adapter.query('SELECT * FROM cpu WHERE time > now() - 1h');
```

✅ **Streaming**: AsyncIterable interface preserved
```javascript
for await (const event of adapter.query(myQuery)) {
  console.log(event);
}
```

✅ **Parsers**: Query validation works the same
```javascript
const result = adapter.parseQuery('rate(invalid[5m])');
if (!result.isValid) {
  console.error(result.errors);
}
```

✅ **Proxy Support**: SOCKS proxy configuration
```javascript
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  proxy: {
    host: 'socks5://proxy.example.com',
    port: 1080
  }
});
```

### Grafana-Specific Features

🔄 **Data Source Discovery**: Automatic in Grafana mode
```javascript
// Automatically discovers and uses the right data source
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token'
  // No need to specify datasourceName if there's a default
});
```

🔄 **Multi-Tenancy**: Use different data sources per query
```javascript
// Create multiple adapters for different data sources
const prodAdapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  datasourceName: 'Prometheus Production'
});

const devAdapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  datasourceName: 'Prometheus Development'
});
```

## Configuration Mapping

### Environment Variables

Create a mapping between old and new configuration:

```bash
# .env.direct (old)
PROMETHEUS_URL=http://prometheus:9090
PROMETHEUS_TOKEN=prometheus-token
LOKI_URL=http://loki:3100
LOKI_USER=loki
LOKI_PASS=loki-password

# .env.grafana (new)
GRAFANA_URL=https://grafana.example.com
GRAFANA_TOKEN=glsa_xxxxxxxxxxxx
PROMETHEUS_DATASOURCE=Prometheus Production
LOKI_DATASOURCE=Loki Production
```

### Configuration File

```javascript
// config.js
module.exports = {
  // Direct connection config
  direct: {
    prometheus: {
      url: 'http://prometheus:9090',
      authToken: 'prometheus-token'
    },
    loki: {
      url: 'http://loki:3100',
      basicAuth: {
        username: 'loki',
        password: 'loki-password'
      }
    }
  },
  
  // Grafana connection config
  grafana: {
    prometheus: {
      url: 'https://grafana.example.com',
      authToken: 'glsa_xxxxxxxxxxxx',
      datasourceName: 'Prometheus Production'
    },
    loki: {
      url: 'https://grafana.example.com',
      authToken: 'glsa_xxxxxxxxxxxx',
      datasourceName: 'Loki Production'
    }
  }
};
```

## Testing the Migration

### 1. Parallel Testing

Run queries against both direct and Grafana connections:

```javascript
async function compareResults() {
  const directAdapter = new PrometheusAdapter({
    url: 'http://prometheus:9090',
    authToken: 'prometheus-token'
  });
  
  const grafanaAdapter = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: 'grafana-token',
    datasourceName: 'Prometheus Production'
  });
  
  const query = 'up{job="api"}';
  
  const [directResults, grafanaResults] = await Promise.all([
    collectResults(directAdapter.query(query)),
    collectResults(grafanaAdapter.query(query))
  ]);
  
  // Compare results
  console.log('Direct results:', directResults.length);
  console.log('Grafana results:', grafanaResults.length);
}

async function collectResults(stream) {
  const results = [];
  for await (const event of stream) {
    results.push(event);
  }
  return results;
}
```

### 2. Performance Testing

Measure latency impact:

```javascript
async function measureLatency() {
  const iterations = 100;
  const query = 'up';
  
  // Direct connection
  const directAdapter = new PrometheusAdapter({
    url: 'http://prometheus:9090',
    authToken: 'prometheus-token'
  });
  
  const directStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    await collectResults(directAdapter.query(query));
  }
  const directTime = Date.now() - directStart;
  
  // Grafana connection
  const grafanaAdapter = new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: 'grafana-token'
  });
  
  const grafanaStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    await collectResults(grafanaAdapter.query(query));
  }
  const grafanaTime = Date.now() - grafanaStart;
  
  console.log(`Direct: ${directTime}ms (${directTime/iterations}ms avg)`);
  console.log(`Grafana: ${grafanaTime}ms (${grafanaTime/iterations}ms avg)`);
  console.log(`Overhead: ${((grafanaTime-directTime)/directTime*100).toFixed(1)}%`);
}
```

### 3. Integration Testing

```javascript
// test/grafana-integration.test.js
const { PrometheusAdapter } = require('@timebridge/adapter-prometheus');

describe('Grafana Integration', () => {
  let adapter;
  
  beforeAll(() => {
    adapter = new PrometheusAdapter({
      url: process.env.GRAFANA_URL,
      authToken: process.env.GRAFANA_TOKEN,
      datasourceName: 'Prometheus Test'
    });
  });
  
  test('should execute queries through Grafana', async () => {
    const results = [];
    for await (const event of adapter.query('up')) {
      results.push(event);
    }
    expect(results.length).toBeGreaterThan(0);
  });
  
  test('should handle instant queries', async () => {
    const results = await adapter.instantQuery('up');
    expect(results).toBeDefined();
  });
  
  test('should parse queries correctly', () => {
    const result = adapter.parseQuery('rate(http_requests_total[5m])');
    expect(result.isValid).toBe(true);
  });
});
```

## Rollback Plan

If you need to rollback to direct connections:

### 1. Feature Flag Approach

```javascript
const USE_GRAFANA = process.env.USE_GRAFANA === 'true';

function createAdapter(type, config) {
  if (USE_GRAFANA) {
    return new adapters[type]({
      url: process.env.GRAFANA_URL,
      authToken: process.env.GRAFANA_TOKEN,
      datasourceName: config.datasourceName
    });
  } else {
    return new adapters[type](config.directConfig);
  }
}
```

### 2. Gradual Rollback

```javascript
// Rollback specific data sources while keeping others on Grafana
const adapters = {
  // Keep using Grafana for Prometheus
  prometheus: new PrometheusAdapter({
    url: 'https://grafana.example.com',
    authToken: 'grafana-token',
    datasourceName: 'Prometheus Production'
  }),
  
  // Rollback to direct for Loki
  loki: new LokiAdapter({
    url: 'http://loki:3100',
    basicAuth: { username: 'loki', password: 'password' }
  })
};
```

## Troubleshooting

### Issue: Authentication Errors

**Symptom**: `401 Unauthorized` errors

**Solution**:
1. Verify token is valid: `curl -H "Authorization: Bearer TOKEN" https://grafana/api/user`
2. Check service account permissions
3. Ensure token hasn't expired

### Issue: Data Source Not Found

**Symptom**: `Data source 'Name' not found`

**Solution**:
1. List available data sources:
```javascript
// Enable debug mode to see available data sources
const adapter = new PrometheusAdapter({
  url: 'https://grafana.example.com',
  authToken: 'token',
  debug: true
});
```

2. Check exact name in Grafana UI
3. Use case-insensitive name

### Issue: Query Timeout

**Symptom**: Queries timeout or take too long

**Solution**:
1. Increase timeout in grafanaOptions:
```javascript
grafanaOptions: {
  timeout: 60000 // 60 seconds
}
```

2. Optimize query time range
3. Check Grafana data source timeout settings

### Issue: Different Results

**Symptom**: Results differ between direct and Grafana

**Solution**:
1. Check Grafana data source configuration matches direct settings
2. Verify time zone settings
3. Ensure Grafana has latest data (check refresh interval)

## Best Practices

### 1. Use Service Accounts
- Create dedicated service accounts for applications
- Use minimal required permissions
- Rotate tokens regularly

### 2. Cache Adapter Instances
```javascript
// Good: Reuse adapter instance
const adapter = new PrometheusAdapter({ /* config */ });
app.locals.prometheusAdapter = adapter;

// Bad: Creating new adapter for each request
app.get('/metrics', async (req, res) => {
  const adapter = new PrometheusAdapter({ /* config */ }); // Don't do this!
});
```

### 3. Handle Failures Gracefully
```javascript
async function queryWithFallback(query) {
  try {
    // Try Grafana first
    return await grafanaAdapter.query(query);
  } catch (error) {
    console.warn('Grafana query failed, falling back to direct:', error);
    // Fall back to direct connection
    return await directAdapter.query(query);
  }
}
```

### 4. Monitor Migration Progress
- Track query latency
- Monitor error rates
- Compare result counts
- Log authentication failures

## FAQ

### Q: Will my existing queries work?
A: Yes, all query syntax remains exactly the same.

### Q: What about WebSocket connections for Loki?
A: Grafana doesn't support WebSocket streaming, so Loki will use polling mode when connected through Grafana.

### Q: Can I use both direct and Grafana connections simultaneously?
A: Yes, you can create multiple adapter instances with different configurations.

### Q: How do I know if the adapter is using Grafana?
A: Enable debug mode to see detection results, or check `adapter.isGrafana()` method.

### Q: What Grafana versions are supported?
A: Grafana 8.0+ is fully supported. Version 7.x may work with limited features.

## Support

- Documentation: [Grafana Data Source Guide](./GRAFANA_DATASOURCE_GUIDE.md)
- Issues: https://github.com/your-org/timebridge/issues
- Examples: See `/packages/examples/grafana-migration/`